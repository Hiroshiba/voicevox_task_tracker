import { deliverDiscord, deliverOperationsAlert } from "../notification-delivery-runtime.js";
import { assertValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import { basename, resolve } from "node:path";

import { encodePublicationCheckpoint } from "../publication-checkpoint-codec.js";
import { bindPublicationCheckpoint } from "../publication-checkpoint-binding.js";
import { writePublicationCheckpointFile } from "../publication-checkpoint-file.js";
import {
  readPublicationRuntimeContext,
  writeWorkflowRuntimeManifest,
} from "../publication-runtime.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import { createCollectAnalyzePayload } from "./artifact.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { DailyPublicationStageHandlers, RunPublicationAdapters } from "./contracts.js";
import { createRunMetadata } from "./metadata.js";
import { buildPublicPages } from "./pages.js";
import { persistSuccessfulRunCompletion, persistValidatedRun } from "./persistence.js";
import { discordDeliverySettings } from "./settings.js";

type DailyNotificationAdapters = Pick<
  RunPublicationAdapters,
  | "environment"
  | "repositoryPath"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "now"
  | "sleep"
  | "random"
  | "sendDiscord"
>;

/** 完全性検証済みrunを初期保存へ渡す。 */
export async function persistDailyState(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      "repositoryPath" | "environment" | "createStateBranchAdapter" | "now"
    >;
  }>,
  input: Parameters<DailyPublicationStageHandlers["persistState"]>[0],
): ReturnType<DailyPublicationStageHandlers["persistState"]> {
  const { configuration, state, repositoryInventory, planned } = input;
  if (
    nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(configuration.config)) !==
    planned.validated.core.configDigest
  ) {
    throw new TypeError("sequential checkpointの設定digestが一致しません");
  }
  const runtime = await readPublicationRuntimeContext(
    dependencies.adapters.repositoryPath,
    planned.validated.core.executionPolicy,
    dependencies.adapters.environment,
  );
  const validatedPayload = createCollectAnalyzePayload({
    invocation: input.invocation,
    configuration,
    inventory: repositoryInventory,
    validated: planned.validated,
    diagnostics: input.diagnostics,
  });
  const encoded = encodePublicationCheckpoint(
    {
      planned,
      validatedPayload,
      runtimeIdentity: runtime.runtimeIdentity,
      artifactFileName: "validated-run.json",
    },
    nodeContentDigestPort,
  );
  const snapshot = state.snapshot;
  const bound = bindPublicationCheckpoint(
    encoded.decoded,
    {
      checkpointFileDigest: encoded.decoded.checkpointFileDigest,
      runtimeRecoveryPlan: runtime.runtimeRecoveryPlan,
    },
    {
      revision: planned.validated.core.baseRevision,
      previousAiSnapshot:
        snapshot.status === "available"
          ? {
              trackedItems: snapshot.snapshot.items,
              collectionRepositories: snapshot.snapshot.collection.repositories,
            }
          : undefined,
    },
    nodeContentDigestPort,
  );
  return persistValidatedRun({
    configuration,
    state,
    inventory: repositoryInventory,
    bound,
    adapter: dependencies.adapters.createStateBranchAdapter(),
    now: dependencies.adapters.now,
  });
}

/** 初期保存済みrunをPages生成へ渡す。 */
export function buildDailyPages(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "writePublicData" | "pagesOutputDirectory">;
  }>,
  input: Parameters<DailyPublicationStageHandlers["buildPages"]>[0],
): ReturnType<DailyPublicationStageHandlers["buildPages"]> {
  const { configuration, repositoryInventory, persisted } = input;
  return buildPublicPages({
    writePublicData: dependencies.adapters.writePublicData,
    inventory: repositoryInventory.inventory,
    planned: persisted.bound.planned,
    historyRecords: persisted.historyRecords,
    outputDirectory: dependencies.adapters.pagesOutputDirectory,
    knownSecrets: configuration.credentials.knownSecrets,
  });
}

/** 日次runのDiscord配送または通知省略を実行する。 */
export async function sendDailyDiscord(
  dependencies: Readonly<{
    adapters: DailyNotificationAdapters;
  }>,
  input: Parameters<DailyPublicationStageHandlers["sendDiscord"]>[0],
): ReturnType<DailyPublicationStageHandlers["sendDiscord"]> {
  const { configuration, state, repositoryInventory, persisted, pages } = input;
  const planned = persisted.bound.planned;
  const validated = planned.validated;
  assertValidatedRun(validated);
  if (planned.publicationPlan.notificationOutbox.action !== "send") {
    return Object.freeze({
      value: Object.freeze({
        delivery: Object.freeze({
          status: "skipped",
          reason:
            planned.publicationPlan.notificationOutbox.action === "hold" ? "held" : "no_candidates",
        }),
        notificationEvents: Object.freeze([]),
        notificationLedger: validated.notificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const result = await deliverDiscord(
    dependencies.adapters,
    Object.freeze({
      ...state,
      session: persisted.session,
      notificationLedger: persisted.notificationLedger,
    }),
    repositoryInventory.inventory,
    repositoryInventory.allowlist.repositories,
    configuration.credentials.knownSecrets,
    planned,
    pages.pagesUrl,
  );
  return Object.freeze({
    value: Object.freeze({
      ...result.value,
      notificationLedger: result.notificationLedger,
    }),
    notificationCount: result.notificationCount,
    discordSentAt: result.discordSentAt,
  });
}

/** Discord結果を使って日次runの完了状態を保存する。 */
export function completeDailyRun(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "now">;
  }>,
  input: Parameters<DailyPublicationStageHandlers["completeRun"]>[0],
): ReturnType<DailyPublicationStageHandlers["completeRun"]> {
  const { invocation, configuration, state, repositoryInventory, discord, metrics, diagnostics } =
    input;
  const planned = input.persisted.bound.planned;
  const validated = planned.validated;
  return persistSuccessfulRunCompletion({
    now: dependencies.adapters.now,
    state: Object.freeze({ ...state, session: input.persisted.session }),
    repositoryInventory: repositoryInventory.inventory,
    repositoryAllowlist: repositoryInventory.allowlist.repositories,
    planned,
    runMetadata: createRunMetadata({ invocation, validated, metrics, diagnostics }),
    delivery: {
      notificationLedger: discord.notificationLedger,
      notificationCount: metrics.notificationCount,
    },
    knownSecrets: configuration.credentials.knownSecrets,
  });
}

/** 日次runの障害通知またはsandboxでの省略を実行する。 */
export async function sendDailyOperationsAlert(
  dependencies: Readonly<{
    adapters: DailyNotificationAdapters;
  }>,
  input: Parameters<DailyPublicationStageHandlers["sendOperationsAlert"]>[0],
): ReturnType<DailyPublicationStageHandlers["sendOperationsAlert"]> {
  const { invocation, configuration, state, persisted, kind, retryAttempts } = input;
  if (configuration.target.kind === "sandbox") {
    return Object.freeze({
      value: Object.freeze({
        delivery: Object.freeze({
          status: "disabled",
        }),
        notificationEvents: Object.freeze([]),
        notificationLedger:
          persisted == null ? state.notificationLedger : persisted.notificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  let persistedState = state;
  if (persisted != null) {
    persistedState = Object.freeze({
      ...state,
      session: persisted.session,
      notificationLedger: persisted.notificationLedger,
    });
  }
  return deliverOperationsAlert(
    dependencies.adapters,
    discordDeliverySettings(configuration.config),
    configuration.credentials.knownSecrets,
    persistedState,
    {
      incidentId: `${invocation.runId}:${kind}`,
      kind,
      occurredAt: invocation.startedAt,
      retryAttempts,
    },
  );
}

/** 日次runの解析結果からworkflow artifactを書き出す。 */
export async function writeDailyCollectAnalyzeArtifact(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "repositoryPath" | "environment">;
  }>,
  path: string,
  stageInput: Parameters<DailyPublicationStageHandlers["writeCollectAnalyzeArtifact"]>[1],
): Promise<void> {
  await writeWorkflowRuntimeManifest(dependencies.adapters.repositoryPath);
  const runtime = await readPublicationRuntimeContext(
    dependencies.adapters.repositoryPath,
    stageInput.planned.validated.core.executionPolicy,
    dependencies.adapters.environment,
  );
  const validatedPayload = createCollectAnalyzePayload({
    invocation: stageInput.invocation,
    configuration: stageInput.configuration,
    inventory: stageInput.repositoryInventory,
    validated: stageInput.planned.validated,
    diagnostics: stageInput.diagnostics,
  });
  const outputPath = resolve(dependencies.adapters.repositoryPath, path);
  const encoded = encodePublicationCheckpoint(
    {
      planned: stageInput.planned,
      validatedPayload,
      runtimeIdentity: runtime.runtimeIdentity,
      artifactFileName: basename(outputPath),
    },
    nodeContentDigestPort,
  );
  await writePublicationCheckpointFile(outputPath, encoded);
}

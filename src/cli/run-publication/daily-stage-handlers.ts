import { deliverOperationsAlert } from "../notification-delivery-runtime.js";
import { basename, resolve } from "node:path";

import { encodePublicationCheckpoint } from "../publication-checkpoint-codec.js";
import { bindPublicationCheckpoint } from "../publication-checkpoint-binding.js";
import { parseInitialPagesBuildArtifact } from "../initial-pages-build-artifact.js";
import {
  preflightInitialPagesDeployment,
  recordInitialPagesSequentialDeployment,
} from "../initial-pages-deployment.js";
import { writePublicationCheckpointFile } from "../publication-checkpoint-file.js";
import {
  readPublicationRuntimeContext,
  writeWorkflowRuntimeManifest,
} from "../publication-runtime.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import { createCollectAnalyzePayload } from "./artifact.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { DailyPublicationStageHandlers, RunPublicationAdapters } from "./contracts.js";
import { buildPublicPages } from "./pages.js";
import { persistValidatedRun } from "./persistence.js";
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
export async function buildDailyPages(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      | "writePublicData"
      | "buildWebOutput"
      | "pagesOutputDirectory"
      | "createStateBranchAdapter"
      | "repositoryPath"
      | "now"
      | "writeJsonArtifact"
    >;
  }>,
  input: Parameters<DailyPublicationStageHandlers["buildPages"]>[0],
): ReturnType<DailyPublicationStageHandlers["buildPages"]> {
  const { configuration, persisted } = input;
  const result = await buildPublicPages({
    adapter: dependencies.adapters.createStateBranchAdapter(),
    config: configuration.config,
    stateConfiguration: configuration.target.state,
    initialStateCommitReceipt: persisted.result.receipt,
    repositoryPath: dependencies.adapters.repositoryPath,
    writePublicData: dependencies.adapters.writePublicData,
    buildWebOutput: dependencies.adapters.buildWebOutput,
    outputDirectory: dependencies.adapters.pagesOutputDirectory,
    knownSecrets: configuration.credentials.knownSecrets,
    now: dependencies.adapters.now,
  });
  await dependencies.adapters.writeJsonArtifact(
    resolve(dependencies.adapters.repositoryPath, "artifacts/workflow/initial-pages-build.json"),
    parseInitialPagesBuildArtifact({
      schemaVersion: 1,
      manifest: result.manifest,
      intent: result.intent,
      receipt: result.receipt,
    }),
  );
  return result;
}

/** 初回Pages intentを確認し、productionまたはsandboxの結果を記録する。 */
export async function deployDailyPages(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      | "repositoryPath"
      | "createStateBranchAdapter"
      | "deployProductionPages"
      | "now"
      | "writeJsonArtifact"
    >;
  }>,
  input: Parameters<DailyPublicationStageHandlers["deployPages"]>[0],
): ReturnType<DailyPublicationStageHandlers["deployPages"]> {
  const artifact = parseInitialPagesBuildArtifact({
    schemaVersion: 1,
    manifest: input.pagesPrepared.manifest,
    intent: input.pagesPrepared.intent,
    receipt: input.pagesPrepared.receipt,
  });
  const preflight = await preflightInitialPagesDeployment({
    adapter: dependencies.adapters.createStateBranchAdapter(),
    configuration: input.configuration.target.state,
    repositoryPath: dependencies.adapters.repositoryPath,
    artifact,
    initialStateCommitReceipt: input.persisted.result.receipt,
    replay: false,
    observedAt: dependencies.adapters.now().toISOString(),
    effectTarget: input.configuration.target.kind,
  });
  const productionResult =
    preflight.kind === "ready" && input.configuration.target.kind === "production"
      ? await dependencies.adapters.deployProductionPages(artifact.intent)
      : undefined;
  const deployment = recordInitialPagesSequentialDeployment({
    artifact,
    preflight,
    target: input.configuration.target.kind === "production" ? "production" : "recording",
    ...(productionResult == null ? {} : { productionResult }),
    recordingId: `${input.invocation.runId}:${artifact.intent.deploymentIntentDigest}`,
    observedAt: dependencies.adapters.now().toISOString(),
  });
  await dependencies.adapters.writeJsonArtifact(
    resolve(
      dependencies.adapters.repositoryPath,
      "artifacts/workflow/initial-pages-deployment.json",
    ),
    deployment,
  );
  if (deployment.kind !== "success" || deployment.receipt.result == null) {
    throw new TypeError("初回Pages公開の成功receiptがありません");
  }
  return Object.freeze({
    prepared: input.pagesPrepared,
    deployment,
    pagesUrl: deployment.receipt.result.pageUrl,
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

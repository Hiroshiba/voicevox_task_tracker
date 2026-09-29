import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertNonNullable } from "../../util/assert-non-nullable.js";

import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { Config } from "../../config/index.js";
import {
  DiscordOperationsPostSendError,
  DiscordWebhookDeliveryUnknownError,
} from "../../discord/index.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import {
  assertOperationsAlertLedgerWritable,
  joinStatePath,
  loadOperationsAlertLedger,
  readExactStateSnapshot,
} from "../../persistence/index.js";
import type { StateBranchAdapter } from "../../persistence/index.js";
import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import { operationsIncidentKindForFailure } from "../../application/tracking-run/failure-primary.js";
import {
  createWorkflowInfrastructureFailure,
  primaryAlertFailure,
  readWorkflowFailureArtifacts,
} from "../operations-failure-selection.js";
import { createOperationsAlertReceipt } from "../operations-alert-receipt.js";
import { readPriorOperationsAlertReceipts } from "../operations-alert-receipt-file.js";
import { assertPriorOperationsAlertDeliveries } from "../operations-alert-receipt-state.js";
import type {
  BuildPagesCliCommand,
  NotifyOperationsCliCommand,
  PersistStateCliCommand,
  VerifyCheckpointCliCommand,
} from "../command.js";
import {
  deliverOperationsAlert,
  OperationsAlertCommitFailureError,
  OperationsAlertNoEffectError,
  OperationsAlertPendingDeliveryError,
} from "../notification-delivery-runtime.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import {
  readPublicationCheckpointFile,
  readPublicationCheckpointHeader,
} from "../publication-checkpoint-file.js";
import { readPublicationRuntimeContext } from "../publication-runtime.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "../publication-checkpoint-binding.js";
import type { RunPublicationAdapters, ValidatedRun } from "./contracts.js";
import { buildPublicPages } from "./pages.js";
import { commitInitialState } from "../initial-state-commit.js";
import {
  BoundPublicationFailureError,
  OperationsAlertReceiptFailureError,
} from "../failure-context-error.js";
import { parseInitialPagesBuildArtifact } from "../initial-pages-build-artifact.js";
import { discordDeliverySettings, projectPublicationSettings } from "./settings.js";

type WorkflowStateAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "now"
  | "writeJsonArtifact"
>;

type WorkflowDeliveryAdapters = Pick<
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
  | "diagnosticsRecorder"
  | "writeJsonArtifact"
>;

function assertWorkflowConfig(
  artifact: Readonly<{ validated: ValidatedRun }>,
  config: Config,
): void {
  if (
    nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)) !==
    artifact.validated.core.configDigest
  ) {
    throw new TypeError("workflow artifactと現在の設定でconfig digestが一致しません");
  }
  const projection = artifact.validated.publicationInputs;
  if (
    serializeCanonicalJson(projectPublicationSettings(config)) !==
      serializeCanonicalJson({
        pages: projection.pages,
        discord: projection.discord,
        configuredTrackingStartAt: projection.configuredTrackingStartAt,
      }) ||
    projection.state.snapshotPath !== config.state.snapshotPath ||
    projection.state.notificationLedgerPath !== config.state.notificationLedgerPath ||
    projection.state.aiCacheDirectory !== config.state.aiCacheDirectory ||
    projection.state.personalReminderAiCacheDirectory !==
      config.state.personalReminderAiCacheDirectory ||
    projection.state.runReportsDirectory !== config.state.runReportsDirectory ||
    projection.state.historyPath !==
      joinStatePath(
        config.state.historyDirectory,
        `${artifact.validated.snapshot.generatedAt.slice(0, 10)}.jsonl`,
      )
  ) {
    throw new TypeError("workflow artifactと現在の設定で公開計画の投影が一致しません");
  }
}

async function readWorkflowCheckpoint(
  adapters: WorkflowStateAdapters,
  artifactPath: string,
  config: Config,
  adapter: StateBranchAdapter,
  baseRevision: BaseStateRevision,
): Promise<BoundPublicationCheckpoint> {
  const header = await readPublicationCheckpointHeader(artifactPath);
  if (header.executionPolicy.executionShape !== "split_workflow") {
    throw new TypeError("分割workflowにsequential checkpointは使えません");
  }
  const expectedRunId = adapters.environment["VOICEVOX_EXPECTED_RUN_ID"];
  if (expectedRunId == null || expectedRunId.length === 0) {
    throw new TypeError("workflowから期待するrun IDが渡されていません");
  }
  const previousSnapshot = await readExactStateSnapshot(
    adapter,
    config.state,
    config.staleness.timezone,
    baseRevision,
  );
  const runtime = await readPublicationRuntimeContext(
    adapters.repositoryPath,
    header.executionPolicy,
    adapters.environment,
  );
  const bound = await readPublicationCheckpointFile(artifactPath, {
    expectedRunId,
    baseStateRevision: baseRevision,
    configDigest: nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)),
    runtime,
    baseWitness: {
      revision: baseRevision,
      previousAiSnapshot:
        previousSnapshot.status === "available"
          ? {
              trackedItems: previousSnapshot.snapshot.items,
              collectionRepositories: previousSnapshot.snapshot.collection.repositories,
            }
          : undefined,
    },
  });
  assertBoundPublicationCheckpoint(bound);
  assertWorkflowConfig(bound, config);
  return bound;
}

/** artifactとsidecarをexact baseへ結合し、効果なしで検証する。 */
export async function verifyWorkflowCheckpoint(
  dependencies: Readonly<{ adapters: WorkflowStateAdapters }>,
  command: VerifyCheckpointCliCommand,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const artifactPath = resolve(dependencies.adapters.repositoryPath, command.artifactPath);
  const header = await readPublicationCheckpointHeader(artifactPath);
  const adapter = dependencies.adapters.createStateBranchAdapter();
  await readWorkflowCheckpoint(
    dependencies.adapters,
    artifactPath,
    config,
    adapter,
    header.baseStateRevision,
  );
}

/** workflow artifactの検証済みstateを初期保存する。 */
export async function persistWorkflowState(
  dependencies: Readonly<{ adapters: WorkflowStateAdapters }>,
  command: PersistStateCliCommand,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const adapter = dependencies.adapters.createStateBranchAdapter();
  const artifactPath = resolve(dependencies.adapters.repositoryPath, command.artifactPath);
  const header = await readPublicationCheckpointHeader(artifactPath);
  const artifact = await readWorkflowCheckpoint(
    dependencies.adapters,
    artifactPath,
    config,
    adapter,
    header.baseStateRevision,
  );
  try {
    const result = await commitInitialState(artifact, {
      adapter,
      configuration: config.state,
      migrationTimezone: config.staleness.timezone,
      knownSecrets: [],
      now: dependencies.adapters.now,
    });
    await dependencies.adapters.writeJsonArtifact(
      resolve(dependencies.adapters.repositoryPath, command.receiptPath),
      result.receipt,
    );
  } catch (error: unknown) {
    throw new BoundPublicationFailureError(artifact, error);
  }
}

/** workflow artifactの検証済みrunからPagesを生成する。 */
export async function buildWorkflowPages(
  dependencies: Readonly<{
    adapters: WorkflowStateAdapters &
      Pick<RunPublicationAdapters, "writePublicData" | "buildWebOutput">;
  }>,
  command: BuildPagesCliCommand,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const receipt = decodeReceipt(
    await readFile(resolve(dependencies.adapters.repositoryPath, command.initialStateReceiptPath)),
    nodeContentDigestPort,
  );
  if (receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回Pages buildには初回state commit receiptが必要です");
  }
  const expectedRunId = requireEnvironmentValue(
    dependencies.adapters.environment,
    "VOICEVOX_EXPECTED_RUN_ID",
  );
  if (receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== expectedRunId) {
    throw new TypeError("初回Pages buildのreceiptと期待run IDが一致しません");
  }
  const adapter = dependencies.adapters.createStateBranchAdapter();
  const result = await buildPublicPages({
    adapter,
    config,
    stateConfiguration: config.state,
    initialStateCommitReceipt: receipt,
    repositoryPath: dependencies.adapters.repositoryPath,
    writePublicData: dependencies.adapters.writePublicData,
    buildWebOutput: dependencies.adapters.buildWebOutput,
    outputDirectory: resolve(dependencies.adapters.repositoryPath, command.outputDirectory),
    knownSecrets: [],
    now: dependencies.adapters.now,
  });
  await dependencies.adapters.writeJsonArtifact(
    resolve(dependencies.adapters.repositoryPath, command.buildArtifactPath),
    parseInitialPagesBuildArtifact({
      schemaVersion: 1,
      manifest: result.manifest,
      intent: result.intent,
      receipt: result.receipt,
    }),
  );
}

/** workflowの障害通知を実行する。 */
export async function notifyWorkflowOperations(
  dependencies: Readonly<{ adapters: WorkflowDeliveryAdapters }>,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  const failureDirectory = resolve(dependencies.adapters.repositoryPath, command.failureDirectory);
  const outputFailureDirectory = resolve(
    dependencies.adapters.repositoryPath,
    command.outputFailureDirectory,
  );
  if (failureDirectory === outputFailureDirectory) {
    throw new TypeError("元jobの公開失敗artifactと通知jobの出力先が同じです");
  }
  const configuredFailureDirectory =
    dependencies.adapters.environment["VOICEVOX_TASK_TRACKER_FAILURE_DIRECTORY"];
  if (
    configuredFailureDirectory != null &&
    resolve(dependencies.adapters.repositoryPath, configuredFailureDirectory) !==
      outputFailureDirectory
  ) {
    throw new TypeError("通知jobの公開失敗artifact出力先がCLI境界と一致しません");
  }
  const artifacts = await readWorkflowFailureArtifacts(failureDirectory);
  if (artifacts.some((artifact) => artifact.failure.failureKind === "public_boundary")) {
    return;
  }
  const recorder = dependencies.adapters.diagnosticsRecorder;
  let primary;
  if (artifacts.length === 0) {
    assertNonNullable(recorder, "運用障害通知の暗号化診断recorderがありません");
    primary = await createWorkflowInfrastructureFailure(
      outputFailureDirectory,
      command.failedJobs,
      recorder,
    );
  } else {
    primary = primaryAlertFailure(artifacts);
  }
  if (primary == null) {
    throw new TypeError("公開失敗artifactの主因を選べません");
  }
  const incidentKind = operationsIncidentKindForFailure(primary.failure);
  const incidentId = `${command.workflowRunId}:${incidentKind}:${primary.failure.failedStage}`;
  createOperationsAlertReceipt(
    primary,
    incidentId,
    dependencies.adapters.now().toISOString(),
    { status: "no_effect" },
    undefined,
  );
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    config.staleness.timezone,
  );
  await assertOperationsAlertLedgerWritable(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    session.baseRevision,
  );
  const snapshot = await session.loadSnapshot();
  const state = Object.freeze({
    session,
    snapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const priorReceipts = await readPriorOperationsAlertReceipts(
    resolve(dependencies.adapters.repositoryPath, command.receiptPath),
    resolve(dependencies.adapters.repositoryPath, command.previousReceiptsDirectory),
    resolve(dependencies.adapters.repositoryPath, command.previousFailuresDirectory),
    command.workflowRunId,
    command.workflowRunAttempt,
    command.workflowKind,
    primary,
    incidentId,
  );
  const priorDeliveries = priorReceipts.filter((receipt) => receipt.status !== "no_effect");
  if (priorDeliveries.length > 0) {
    const dedicated = await loadOperationsAlertLedger(
      dependencies.adapters.createStateBranchAdapter(),
      config.state,
    );
    await assertPriorOperationsAlertDeliveries(
      dependencies.adapters.createStateBranchAdapter(),
      dedicated.head,
      dedicated.ledger.operationsAlerts,
      session.baseRevision,
      state.notificationLedger.operationsAlerts,
      priorDeliveries,
      incidentId,
      incidentKind,
    );
  }
  const knownSecrets = config.notifications.discord.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          dependencies.adapters.environment,
          config.notifications.discord.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  const isNotificationHistoryFailure =
    primary.failure.failedStage === "notification_history_pages_prepared" ||
    primary.failure.failedStage === "notification_history_pages_published";
  let delivered: Awaited<ReturnType<typeof deliverOperationsAlert>>;
  try {
    delivered = await deliverOperationsAlert(
      dependencies.adapters,
      discordDeliverySettings(config),
      knownSecrets,
      state,
      config.state,
      {
        incidentId,
        kind: incidentKind,
        occurredAt: command.occurredAt,
        retryAttempts: command.retryAttempts,
        context: {
          failureKind: primary.failure.failureKind,
          failedStage: primary.failure.failedStage,
          ...(isNotificationHistoryFailure && primary.failure.finalStateRevision != null
            ? { finalStateRevision: primary.failure.finalStateRevision }
            : {}),
          ...(isNotificationHistoryFailure && primary.failure.lastReceiptDigest != null
            ? { lastReceiptDigest: primary.failure.lastReceiptDigest }
            : {}),
        },
      },
    );
  } catch (error: unknown) {
    if (
      !(error instanceof OperationsAlertCommitFailureError) &&
      !(error instanceof OperationsAlertPendingDeliveryError) &&
      !(error instanceof OperationsAlertNoEffectError) &&
      !(error instanceof DiscordOperationsPostSendError) &&
      !(error instanceof DiscordWebhookDeliveryUnknownError)
    ) {
      throw error;
    }
    let delivery: Parameters<typeof createOperationsAlertReceipt>[3];
    if (error instanceof OperationsAlertNoEffectError) {
      delivery = { status: "no_effect" };
    } else if (error instanceof OperationsAlertCommitFailureError) {
      delivery = {
        status: "ambiguous",
        discordMessageId: error.discordMessageId,
        observedOperationsLedgerState: error.observedState,
      };
    } else if (error instanceof DiscordOperationsPostSendError) {
      delivery = { status: "ambiguous", discordMessageId: error.discordMessageId };
    } else {
      delivery = { status: "ambiguous" };
    }
    try {
      const receipt = createOperationsAlertReceipt(
        primary,
        incidentId,
        dependencies.adapters.now().toISOString(),
        delivery,
        undefined,
      );
      await dependencies.adapters.writeJsonArtifact(
        resolve(dependencies.adapters.repositoryPath, command.receiptPath),
        receipt,
      );
    } catch (receiptError: unknown) {
      throw new OperationsAlertReceiptFailureError(
        delivery.status === "no_effect" ? "no_effect" : "ambiguous",
        new AggregateError(
          [error, receiptError],
          "運用障害通知の失敗receiptを保存できませんでした",
          {
            cause: error,
          },
        ),
      );
    }
    throw error;
  }
  const operationsDelivery = delivered.delivery;
  try {
    const receipt = createOperationsAlertReceipt(
      primary,
      incidentId,
      dependencies.adapters.now().toISOString(),
      operationsDelivery.status === "sent"
        ? { status: "sent", discordMessageId: operationsDelivery.discordMessageId }
        : { status: "no_effect" },
      delivered.operationsCommit,
    );
    await dependencies.adapters.writeJsonArtifact(
      resolve(dependencies.adapters.repositoryPath, command.receiptPath),
      receipt,
    );
  } catch (error: unknown) {
    throw new OperationsAlertReceiptFailureError(
      operationsDelivery.status === "sent" ? "committed" : "no_effect",
      error,
    );
  }
}

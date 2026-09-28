import { resolve } from "node:path";

import { assertValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import { planPublication } from "../../publication/plan-publication.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { assertHistoricalAiWitnessMatchesBaseSnapshot } from "../../application/tracking-run/stages/run-validation-artifact-witness.js";
import type { Config } from "../../config/index.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import { joinStatePath } from "../../persistence/index.js";
import { CliWorkflowArtifactError } from "../errors.js";
import { readOptionalRunReportFile } from "../workflow-run-report.js";
import type {
  BuildPagesCliCommand,
  NotifyDiscordCliCommand,
  NotifyOperationsCliCommand,
  PersistStateCliCommand,
} from "../command.js";
import { deliverDiscord, deliverOperationsAlert } from "../notification-delivery-runtime.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import { workflowArtifactRepositoryInventory } from "../workflow-artifact.js";
import type {
  RunPublicationAdapters,
  ValidatedRun,
} from "./contracts.js";
import { buildPublicPages } from "./pages.js";
import { assertPlannedAiCacheAdditions, persistSuccessfulRunCompletion } from "./persistence.js";
import { discordDeliverySettings, projectPublicationSettings } from "./settings.js";
import {
  assertWorkflowDeliveryLedgerMatches,
  assertWorkflowInitialLedgerMatches,
  assertWorkflowSnapshotMatches,
} from "./workflow-state-identity.js";

type WorkflowStateAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "readWorkflowArtifact"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
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

/** workflow artifactの検証済みstateを初期保存する。 */
export async function persistWorkflowState(
  dependencies: Readonly<{ adapters: WorkflowStateAdapters }>,
  command: PersistStateCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  assertValidatedRun(artifact.validated);
  const planned = planPublication(artifact.validated, nodeContentDigestPort);
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  assertWorkflowConfig(artifact, config);
  const adapter = dependencies.adapters.createStateBranchAdapter();
  const baseRevision = await adapter.resolveHead(config.state.branch);
  if (
    serializeCanonicalJson(baseRevision) !==
    serializeCanonicalJson(artifact.validated.core.baseRevision)
  ) {
    throw new TypeError("workflow artifactとstate branchの基準revisionが一致しません");
  }
  const session = await dependencies.adapters.openStateSession(
    adapter,
    config.state,
    config.staleness.timezone,
  );
  const previousSnapshot = await session.loadSnapshot();
  assertHistoricalAiWitnessMatchesBaseSnapshot(
    artifact.validated.evidenceClosureWitness,
    previousSnapshot.status === "available"
      ? {
          trackedItems: previousSnapshot.snapshot.items,
          collectionRepositories: previousSnapshot.snapshot.collection.repositories,
        }
      : undefined,
  );
  for (const entry of artifact.validated.aiCacheAdditions) {
    await session.aiCache.write(entry);
  }
  for (const entry of artifact.validated.personalReminderAiCacheAdditions) {
    await session.personalReminderAiCache.write(entry);
  }
  assertPlannedAiCacheAdditions({ session }, planned);
  await session.persist({
    snapshot: planned.publicationPlan.initialStateWriteSet.snapshot,
    historyInputEvents: planned.publicationPlan.initialStateWriteSet.historyInputEvents,
    notificationLedger: planned.publicationPlan.initialStateWriteSet.notificationLedger,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    repositoryAllowlist: artifact.validated.repositoryAllowlist,
    knownSecrets: [],
    expectedHistoryBase: planned.publicationPlan.initialStateWriteSet.paths.historyBase,
    expectedPreviousInitialPagesEvidence:
      planned.publicationPlan.initialStateWriteSet.previousInitialPagesEvidence.expectedBase,
    deletions: planned.publicationPlan.initialStateWriteSet.deletions,
  });
}

/** workflow artifactの検証済みrunからPagesを生成する。 */
export async function buildWorkflowPages(
  dependencies: Readonly<{
    adapters: WorkflowStateAdapters & Pick<RunPublicationAdapters, "writePublicData">;
  }>,
  command: BuildPagesCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  assertValidatedRun(artifact.validated);
  const planned = planPublication(artifact.validated, nodeContentDigestPort);
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  assertWorkflowConfig(artifact, config);
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    config.staleness.timezone,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Pages生成対象のstate snapshotがありません");
  }
  assertWorkflowSnapshotMatches(artifact.validated, persistedSnapshot.snapshot);
  assertWorkflowInitialLedgerMatches(artifact.validated, await session.loadNotificationLedger());
  const historyRecords = await session.loadHistoryRecords();
  await buildPublicPages({
    writePublicData: dependencies.adapters.writePublicData,
    inventory: workflowArtifactRepositoryInventory(artifact),
    planned,
    historyRecords,
    outputDirectory: resolve(dependencies.adapters.repositoryPath, command.outputDirectory),
    knownSecrets: [],
  });
}

/** workflowのDiscord通知と完了保存を実行する。 */
export async function notifyWorkflowDiscord(
  dependencies: Readonly<{
    adapters: WorkflowDeliveryAdapters & Pick<RunPublicationAdapters, "readWorkflowArtifact">;
  }>,
  command: NotifyDiscordCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  assertValidatedRun(artifact.validated);
  const planned = planPublication(artifact.validated, nodeContentDigestPort);
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  assertWorkflowConfig(artifact, config);
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    config.staleness.timezone,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord通知対象のstate snapshotがありません");
  }
  assertWorkflowSnapshotMatches(artifact.validated, persistedSnapshot.snapshot);
  const notificationLedger = await session.loadNotificationLedger();
  assertWorkflowDeliveryLedgerMatches(artifact.validated, notificationLedger);
  const state = Object.freeze({
    session,
    snapshot: persistedSnapshot,
    notificationLedger,
  });
  if (planned.publicationPlan.notificationOutbox.action !== "send") {
    await persistSuccessfulRunCompletion({
      now: dependencies.adapters.now,
      state,
      repositoryInventory: workflowArtifactRepositoryInventory(artifact),
      repositoryAllowlist: artifact.validated.repositoryAllowlist,
      planned,
      runMetadata: artifact.runMetadata,
      delivery: {
        notificationLedger: state.notificationLedger,
        notificationCount: 0,
      },
      knownSecrets: [],
    });
    return;
  }
  const knownSecrets = artifact.discordSettings.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          dependencies.adapters.environment,
          artifact.discordSettings.webhookSecretName,
        ),
        requireEnvironmentValue(
          dependencies.adapters.environment,
          artifact.discordSettings.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  const result = await deliverDiscord(
    dependencies.adapters,
    state,
    workflowArtifactRepositoryInventory(artifact),
    artifact.validated.repositoryAllowlist,
    knownSecrets,
    planned,
    command.pagesUrl,
  );
  await persistSuccessfulRunCompletion({
    now: dependencies.adapters.now,
    state,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    repositoryAllowlist: artifact.validated.repositoryAllowlist,
    planned,
    runMetadata: artifact.runMetadata,
    delivery: {
      notificationLedger: result.notificationLedger,
      notificationCount: result.notificationCount,
    },
    knownSecrets,
  });
}

/** workflowの障害通知を実行する。 */
export async function notifyWorkflowOperations(
  dependencies: Readonly<{ adapters: WorkflowDeliveryAdapters }>,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  if (command.incidentKind === "collection") {
    const reportPath = resolve(
      dependencies.adapters.repositoryPath,
      command.collectAnalyzeReportPath,
    );
    const report = await readOptionalRunReportFile(reportPath);
    if (report != null && report.command !== "collect-analyze") {
      throw new CliWorkflowArtifactError(reportPath, "invalid", {
        cause: new TypeError("収集run reportのcommandが一致しません"),
      });
    }
    if (
      command.publicBoundaryStatus === "confirmed" ||
      (report?.status === "failure" && report.failureKind === "public_boundary")
    ) {
      return;
    }
  }
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    config.staleness.timezone,
  );
  const snapshot = await session.loadSnapshot();
  const state = Object.freeze({
    session,
    snapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const knownSecrets = config.notifications.discord.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          dependencies.adapters.environment,
          config.notifications.discord.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  await deliverOperationsAlert(
    dependencies.adapters,
    discordDeliverySettings(config),
    knownSecrets,
    state,
    {
      incidentId: command.incidentId,
      kind: command.incidentKind,
      occurredAt: command.occurredAt,
      retryAttempts: command.retryAttempts,
    },
  );
}

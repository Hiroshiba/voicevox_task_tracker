import { resolve } from "node:path";

import { assertValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { Config } from "../../config/index.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
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
  NormalizeLabelRules,
  ResolveCompletedTrackingStartAt,
  RunPublicationAdapters,
  ValidatedRun,
} from "./contracts.js";
import { buildPublicPages } from "./pages.js";
import { persistSuccessfulRunCompletion } from "./persistence.js";
import { discordDeliverySettings, pagesUrl } from "./settings.js";
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
  for (const entry of artifact.validated.aiCacheAdditions) {
    await session.aiCache.write(entry);
  }
  for (const entry of artifact.validated.personalReminderAiCacheAdditions) {
    await session.personalReminderAiCache.write(entry);
  }
  await session.persist({
    snapshot: artifact.validated.snapshot,
    historyInputEvents: artifact.validated.historyInputEvents,
    notificationLedger: artifact.validated.notificationLedger,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    repositoryAllowlist: artifact.validated.repositoryAllowlist,
    knownSecrets: [],
  });
}

/** workflow artifactの検証済みrunからPagesを生成する。 */
export async function buildWorkflowPages(
  dependencies: Readonly<{
    adapters: WorkflowStateAdapters & Pick<RunPublicationAdapters, "writePublicData">;
    normalizeLabelRules: NormalizeLabelRules;
  }>,
  command: BuildPagesCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  assertValidatedRun(artifact.validated);
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  assertWorkflowConfig(artifact, config);
  if (pagesUrl(config) !== artifact.pagesUrl) {
    throw new TypeError("workflow artifactと現在の設定でPages URLが一致しません");
  }
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
    config,
    inventory: workflowArtifactRepositoryInventory(artifact),
    repositoryAllowlist: artifact.validated.repositoryAllowlist,
    validated: artifact.validated,
    historyRecords,
    outputDirectory: resolve(dependencies.adapters.repositoryPath, command.outputDirectory),
    knownSecrets: [],
    resolveLabelRules: () => dependencies.normalizeLabelRules(config),
  });
}

/** workflowのDiscord通知と完了保存を実行する。 */
export async function notifyWorkflowDiscord(
  dependencies: Readonly<{
    adapters: WorkflowDeliveryAdapters & Pick<RunPublicationAdapters, "readWorkflowArtifact">;
    normalizeLabelRules: NormalizeLabelRules;
    resolveCompletedTrackingStartAt: ResolveCompletedTrackingStartAt;
  }>,
  command: NotifyDiscordCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  assertValidatedRun(artifact.validated);
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  assertWorkflowConfig(artifact, config);
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  if (
    serializeCanonicalJson(discordDeliverySettings(config)) !==
    serializeCanonicalJson(artifact.discordSettings)
  ) {
    throw new TypeError("workflow artifactと現在の設定でDiscord配送条件が一致しません");
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
  if (
    artifact.notificationAction === "acknowledge-current" ||
    artifact.notificationAction === "hold"
  ) {
    await persistSuccessfulRunCompletion({
      now: dependencies.adapters.now,
      config,
      state,
      repositoryInventory: workflowArtifactRepositoryInventory(artifact),
      repositoryAllowlist: artifact.validated.repositoryAllowlist,
      validated: artifact.validated,
      runMetadata: artifact.runMetadata,
      delivery: {
        notificationLedger: state.notificationLedger,
        notificationCount: 0,
      },
      knownSecrets: [],
      resolveCompletedTrackingStartAt: dependencies.resolveCompletedTrackingStartAt,
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
    config,
    () => dependencies.normalizeLabelRules(config),
    artifact.discordSettings,
    state,
    workflowArtifactRepositoryInventory(artifact),
    artifact.validated.repositoryAllowlist,
    knownSecrets,
    artifact.validated,
    command.pagesUrl,
  );
  await persistSuccessfulRunCompletion({
    now: dependencies.adapters.now,
    config,
    state,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    repositoryAllowlist: artifact.validated.repositoryAllowlist,
    validated: artifact.validated,
    runMetadata: artifact.runMetadata,
    delivery: {
      notificationLedger: result.notificationLedger,
      notificationCount: result.notificationCount,
    },
    knownSecrets,
    resolveCompletedTrackingStartAt: dependencies.resolveCompletedTrackingStartAt,
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

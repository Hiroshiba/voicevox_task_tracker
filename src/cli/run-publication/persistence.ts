import { assertValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import { serializeCanonicalJson } from "../../canonical-json/index.js";
import type { PublicationPlannedRun } from "../../publication/publication-plan-contracts.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "../publication-checkpoint-binding.js";
import { countSentOutboxNotifications } from "../../publication/notification-outbox.js";
import { createUtcIsoDateTime, resolveTrackingStartAt } from "../../domain/index.js";
import type { Repository } from "../../domain/index.js";
import { createStateSnapshot } from "../../persistence/index.js";
import { StatePersistenceSession, type StateBranchAdapter } from "../../persistence/index.js";
import type { WorkflowRunMetadata } from "../validated-run-payload.js";
import { createPersistedRunReport, persistedMetrics } from "./metadata.js";
import type {
  PersistedRun,
  PublicationConfiguration,
  PublicationRepositoryInventory,
  PublicationState,
  RunCompletionDelivery,
  RunPublicationAdapters,
} from "./contracts.js";
import { commitInitialState } from "../initial-state-commit.js";

/** 完全性検証済みrunの初期保存に必要な値。 */
export type PersistValidatedRunInput = Readonly<{
  configuration: PublicationConfiguration;
  state: PublicationState;
  inventory: PublicationRepositoryInventory;
  bound: BoundPublicationCheckpoint;
  adapter: StateBranchAdapter;
  now: () => Date;
}>;

/** 完全性検証済みrunを初期保存し、後続段階用state sessionを開く。 */
export async function persistValidatedRun(input: PersistValidatedRunInput): Promise<PersistedRun> {
  assertBoundPublicationCheckpoint(input.bound);
  const { validated } = input.bound.planned;
  assertValidatedRun(validated);
  assertPlannedAiCacheAdditions(input.state, input.bound.planned);
  const result = await commitInitialState(input.bound, {
    adapter: input.adapter,
    configuration: input.configuration.target.state,
    migrationTimezone: input.configuration.config.staleness.timezone,
    knownSecrets: input.configuration.credentials.knownSecrets,
    now: input.now,
  });
  const session = await StatePersistenceSession.openAtRevision(
    input.adapter,
    input.configuration.target.state,
    input.configuration.config.staleness.timezone,
    result.revision,
  );
  return Object.freeze({
    result,
    notificationLedger: await session.loadNotificationLedger(),
    session,
    bound: input.bound,
  });
}

/** state sessionの保存待ちAI cacheが公開計画の値と一致することを確認する。 */
export function assertPlannedAiCacheAdditions(
  state: Pick<PublicationState, "session">,
  planned: PublicationPlannedRun,
): void {
  const writeSet = planned.publicationPlan.initialStateWriteSet;
  if (
    serializeCanonicalJson(writeSet.aiCacheAdditions) !==
      serializeCanonicalJson(state.session.pendingAiCacheEntries()) ||
    serializeCanonicalJson(writeSet.personalReminderAiCacheAdditions) !==
      serializeCanonicalJson(state.session.pendingPersonalReminderAiCacheEntries())
  ) {
    throw new TypeError("公開計画のAI cache追加がstate sessionと一致しません");
  }
}

/** 完了保存に必要な状態、通知結果、時刻関数。 */
export type PersistSuccessfulRunCompletionInput = Readonly<{
  now: RunPublicationAdapters["now"];
  state: PublicationState;
  repositoryInventory: readonly Repository[];
  repositoryAllowlist: readonly Pick<Repository, "id" | "owner" | "name">[];
  planned: PublicationPlannedRun;
  runMetadata: WorkflowRunMetadata;
  delivery: RunCompletionDelivery;
  knownSecrets: readonly string[];
}>;

/** 通知結果を含む完了状態を保存し、state branchへpublishする。 */
export async function persistSuccessfulRunCompletion(
  input: PersistSuccessfulRunCompletionInput,
): Promise<void> {
  assertValidatedRun(input.planned.validated);
  const completedAt = createUtcIsoDateTime(input.now().toISOString());
  const persistedSnapshot = await input.state.session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("run完了対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== input.planned.validated.snapshot.run.id) {
    throw new TypeError("run完了対象のrunがstate snapshotと一致しません");
  }
  const snapshot = persistedSnapshot.snapshot;
  const policy = input.planned.publicationPlan.runFinalizationPolicy;
  if (
    policy.report.runId !== snapshot.run.id ||
    policy.report.scheduledFor !== input.runMetadata.scheduledFor ||
    policy.report.startedAt !== input.runMetadata.startedAt ||
    policy.report.status !== snapshot.run.status ||
    serializeCanonicalJson(persistedMetrics(policy.report.metrics, input.planned.validated)) !==
      serializeCanonicalJson(input.runMetadata.metrics)
  ) {
    throw new TypeError("公開計画とrun完了reportの識別が一致しません");
  }
  if (
    input.delivery.notificationCount !==
    countSentOutboxNotifications(
      input.planned.publicationPlan.notificationOutbox,
      input.delivery.notificationLedger,
    )
  ) {
    throw new TypeError("公開計画の通知対象とrun完了時の実送信数が一致しません");
  }
  const trackingStartAt = resolveTrackingStartAt({
    configuredStartAt: policy.configuredTrackingStartAt,
    previousState: snapshot.trackingStartAt,
    run: Object.freeze({ outcome: "complete_success", finishedAt: completedAt }),
  });
  if (trackingStartAt.status !== "fixed") {
    throw new TypeError("完全成功したrunでtracking.startAtを確定できませんでした");
  }
  await input.state.session.persistRunCompletion({
    snapshot: createStateSnapshot({
      ...snapshot,
      trackingStartAt,
    }),
    notificationEvents: Object.freeze([]),
    notificationLedger: input.delivery.notificationLedger,
    runReport: createPersistedRunReport({
      snapshot,
      metadata: input.runMetadata,
      notificationCount: input.delivery.notificationCount,
      finishedAt: completedAt,
    }),
    repositoryInventory: input.repositoryInventory,
    repositoryAllowlist: input.repositoryAllowlist,
    knownSecrets: input.knownSecrets,
  });
  await input.state.session.publish();
}

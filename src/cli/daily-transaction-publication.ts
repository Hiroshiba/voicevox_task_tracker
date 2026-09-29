import {
  completeTrackingRun,
  type CompletedRun,
} from "../application/tracking-run/complete-run.js";
import type { InitialStateCommitReference } from "../application/tracking-run/engine.js";
import type { ReceiptChainEntry } from "../application/tracking-run/receipt-chain-schema.js";
import type { Receipt } from "../application/tracking-run/receipt-schema.js";
import type { StateCommitReceiptEvidence } from "../application/tracking-run/observed-state-commit.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";
import type { FinalizeRunOutcome } from "./run-finalization.js";
import type { NotificationHistoryPublishedRun } from "./run-publication/contracts.js";
import type {
  DailyRunRuntime,
  DailyTransactionDependencies,
  DailyTransactionTypeMap,
  NotificationStageResult,
} from "./daily-transaction.js";

/** 公開境界へ渡す完全性検証済みの値。 */
export type PublicationStageInput<Types extends DailyTransactionTypeMap> = Parameters<
  DailyTransactionDependencies<Types>["persistState"]
>[0];

type CommittedDailyState<Types extends DailyTransactionTypeMap> = Types["persisted"] &
  Readonly<{
    stateContentDigest: string;
    receiptEvidence: Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>;
  }>;

type PreparedDailyPages<Types extends DailyTransactionTypeMap> = Readonly<{
  committed: CommittedDailyState<Types>;
  pagesPrepared: Types["pagesPrepared"];
}>;

type PublishedDailyState<Types extends DailyTransactionTypeMap> = Readonly<{
  committed: CommittedDailyState<Types>;
  pages: Types["pages"];
}>;

type SettledDailyState<Types extends DailyTransactionTypeMap> = PublishedDailyState<Types> &
  Readonly<{ notifications: NotificationStageResult<Types["notifications"]> }>;

type FinalizedDailyState<Types extends DailyTransactionTypeMap> = SettledDailyState<Types> &
  Readonly<{ finalization: Extract<FinalizeRunOutcome, { kind: "finalized" }> }>;

type PreparedHistoryDailyState<Types extends DailyTransactionTypeMap> = FinalizedDailyState<Types> &
  Readonly<{ historyPagesPrepared: Types["historyPagesPrepared"] }>;

type HistoryPagesDailyState<Types extends DailyTransactionTypeMap> = FinalizedDailyState<Types> &
  Readonly<{ historyPages: NotificationHistoryPublishedRun }>;

/** CLI runnerへ公開段階の副作用と通知実績を渡す。 */
export type DailyPublicationProgress<Types extends DailyTransactionTypeMap> = Readonly<{
  stateCommitted: () => void;
  pagesBuilt: () => void;
  notificationStarted: () => void;
  notificationsSettled: (result: NotificationStageResult<Types["notifications"]>) => void;
  receiptRecorded: (receipt: Receipt) => void;
}>;

/** 公開段階の成果物をcanonical engineの各段階へ対応させる。 */
export type DailyPublicationStageValues<Types extends DailyTransactionTypeMap> = Readonly<{
  publication_planned: PublicationStageInput<Types>;
  initial_state_committed: CommittedDailyState<Types>;
  initial_pages_prepared: PreparedDailyPages<Types>;
  initial_pages_published: PublishedDailyState<Types>;
  notifications_settled: SettledDailyState<Types>;
  run_finalized: FinalizedDailyState<Types>;
  notification_history_pages_prepared: PreparedHistoryDailyState<Types>;
  notification_history_pages_published: HistoryPagesDailyState<Types>;
}>;

/** 初回commit後はexact state再読込結果だけを公開段階へ渡す。 */
export function createDailyPublicationStages<Types extends DailyTransactionTypeMap>(
  dependencies: DailyTransactionDependencies<Types>,
  runtime: DailyRunRuntime,
  progress: DailyPublicationProgress<Types>,
  getInput: () => PublicationStageInput<Types>,
): Readonly<{
  encodeCheckpoint: (
    input: PublicationStageInput<Types>,
  ) => Promise<
    Readonly<{ bound: BoundPublicationCheckpoint; input: PublicationStageInput<Types> }>
  >;
  commitInitialState: (
    checkpoint: Readonly<{
      bound: BoundPublicationCheckpoint;
      input: PublicationStageInput<Types>;
    }>,
  ) => Promise<InitialStateCommitReference>;
  readCommittedState: (
    reference: InitialStateCommitReference,
  ) => Promise<CommittedDailyState<Types>>;
  initialPagesPrepared: (
    committed: CommittedDailyState<Types>,
  ) => Promise<PreparedDailyPages<Types>>;
  initialPagesPublished: (
    prepared: PreparedDailyPages<Types>,
  ) => Promise<PublishedDailyState<Types>>;
  notificationsSettled: (
    published: PublishedDailyState<Types>,
  ) => Promise<SettledDailyState<Types>>;
  runFinalized: (settled: SettledDailyState<Types>) => Promise<FinalizedDailyState<Types>>;
  notificationHistoryPagesPrepared: (
    finalized: FinalizedDailyState<Types>,
  ) => Promise<PreparedHistoryDailyState<Types>>;
  notificationHistoryPagesPublished: (
    prepared: PreparedHistoryDailyState<Types>,
  ) => Promise<HistoryPagesDailyState<Types>>;
  complete: (published: HistoryPagesDailyState<Types>) => Promise<CompletedRun>;
}> {
  const receiptChain: ReceiptChainEntry[] = [];
  const appendReceipts = async (...entries: readonly ReceiptChainEntry[]): Promise<void> => {
    receiptChain.push(...entries);
    await dependencies.writeReceiptChain(getInput().invocation.runId, receiptChain);
  };
  return Object.freeze({
    encodeCheckpoint: async (input) =>
      Object.freeze({ bound: await dependencies.prepareCheckpoint(input), input }),
    commitInitialState: async ({ bound, input }) => {
      const persisted = await dependencies.commitPreparedCheckpoint(input, bound);
      progress.stateCommitted();
      return Object.freeze({
        stateRevision: persisted.result.revision,
        stateContentDigest: persisted.result.receipt.result.stateContentDigest,
      });
    },
    readCommittedState: async (reference) => {
      const committed = await dependencies.readCommittedState({
        configuration: getInput().configuration,
        reference,
      });
      progress.receiptRecorded(committed.result.receipt);
      await appendReceipts({
        receipt: committed.result.receipt,
        evidence: { kind: "state_commit", state: committed.receiptEvidence },
      });
      return committed;
    },
    initialPagesPrepared: async (committed) => {
      const input = getInput();
      const pagesPrepared = await dependencies.buildPages({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: committed,
      });
      progress.pagesBuilt();
      progress.receiptRecorded(pagesPrepared.receipt);
      await appendReceipts({ receipt: pagesPrepared.receipt, evidence: { kind: "none" } });
      return Object.freeze({ committed, pagesPrepared });
    },
    initialPagesPublished: async (prepared) => {
      const input = getInput();
      const pages = await dependencies.deployPages({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: prepared.committed,
        pagesPrepared: prepared.pagesPrepared,
      });
      progress.receiptRecorded(pages.deployment.receipt);
      await appendReceipts({
        receipt: pages.deployment.receipt,
        evidence: pages.receiptEvidence,
      });
      return Object.freeze({ committed: prepared.committed, pages });
    },
    notificationsSettled: async (published) => {
      const input = getInput();
      progress.notificationStarted();
      const notifications = await dependencies.settleNotifications({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: published.committed,
        pages: published.pages,
      });
      progress.notificationsSettled(notifications);
      progress.receiptRecorded(notifications.value.receipt);
      await appendReceipts(...notifications.value.messageReceipts, {
        receipt: notifications.value.receipt,
        evidence: notifications.value.receiptEvidence,
      });
      return Object.freeze({ ...published, notifications });
    },
    runFinalized: async (settled) => {
      const input = getInput();
      const finalization = await dependencies.finalizeRun({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: settled.committed,
        notifications: settled.notifications.value,
      });
      progress.receiptRecorded(finalization.receipt);
      await appendReceipts({
        receipt: finalization.receipt,
        evidence: finalization.receiptEvidence,
      });
      return Object.freeze({ ...settled, finalization });
    },
    notificationHistoryPagesPrepared: async (finalized) => {
      const historyPagesPrepared = await dependencies.buildNotificationHistoryPages({
        configuration: getInput().configuration,
        settlementReceipt: finalized.notifications.value.receipt,
        finalizationReceipt: finalized.finalization.receipt,
      });
      progress.receiptRecorded(historyPagesPrepared.receipt);
      await appendReceipts({ receipt: historyPagesPrepared.receipt, evidence: { kind: "none" } });
      return Object.freeze({ ...finalized, historyPagesPrepared });
    },
    notificationHistoryPagesPublished: async (prepared) => {
      const input = getInput();
      const historyPages = await dependencies.deployNotificationHistoryPages({
        configuration: input.configuration,
        prepared: prepared.historyPagesPrepared,
        settlementReceipt: prepared.notifications.value.receipt,
        finalizationReceipt: prepared.finalization.receipt,
        runId: input.invocation.runId,
      });
      progress.receiptRecorded(historyPages.deployment.receipt);
      await appendReceipts({
        receipt: historyPages.deployment.receipt,
        evidence: { kind: "none" },
      });
      return Object.freeze({ ...prepared, historyPages });
    },
    complete: (published) =>
      Promise.resolve(
        completeTrackingRun(
          {
            entries: receiptChain,
            finalStateRevision: published.finalization.stateRevision,
            invocationId: getInput().invocation.invocationId,
            observedAt: runtime.now().toISOString(),
          },
          nodeContentDigestPort,
        ),
      ),
  });
}

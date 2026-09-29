import {
  completeTrackingRun,
  type CompletedRun,
} from "../application/tracking-run/complete-run.js";
import { runPreparedTrackingRun } from "../application/tracking-run/engine.js";
import type { ReceiptChainEntry } from "../application/tracking-run/receipt-chain-schema.js";
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
import type { RunStage } from "./run-report.js";

/** 公開境界へ渡す完全性検証済みの値。 */
export type PublicationStageInput<Types extends DailyTransactionTypeMap> = Parameters<
  DailyTransactionDependencies<Types>["persistState"]
>[0];

type CommittedDailyState<Types extends DailyTransactionTypeMap> = Types["persisted"] &
  Readonly<{
    stateContentDigest: string;
    receiptEvidence: Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>;
  }>;

type PublishedDailyState<Types extends DailyTransactionTypeMap> = Readonly<{
  committed: CommittedDailyState<Types>;
  pages: Types["pages"];
}>;

type SettledDailyState<Types extends DailyTransactionTypeMap> = PublishedDailyState<Types> &
  Readonly<{ notifications: NotificationStageResult<Types["notifications"]> }>;

type FinalizedDailyState<Types extends DailyTransactionTypeMap> = SettledDailyState<Types> &
  Readonly<{ finalization: Extract<FinalizeRunOutcome, { kind: "finalized" }> }>;

type HistoryPagesDailyState<Types extends DailyTransactionTypeMap> = FinalizedDailyState<Types> &
  Readonly<{ historyPages: NotificationHistoryPublishedRun }>;

/** CLI runnerへ公開段階の進捗と通知実績を渡す。 */
export type DailyPublicationProgress<Types extends DailyTransactionTypeMap> = Readonly<{
  setStage: (stage: RunStage) => void;
  stateCommitted: () => void;
  pagesBuilt: () => void;
  notificationStarted: () => void;
  notificationsSettled: (result: NotificationStageResult<Types["notifications"]>) => void;
}>;

function completionEntries<Types extends DailyTransactionTypeMap>(
  state: HistoryPagesDailyState<Types>,
): readonly ReceiptChainEntry[] {
  const initialReceipt = state.committed.result.receipt;
  if (initialReceipt.receiptKind !== "observed") {
    throw new TypeError("初回stateの再読込receiptがありません");
  }
  const pagesReceipt = state.pages.deployment.receipt;
  const settlement = state.notifications.value;
  const history = state.historyPages.deployment;
  return Object.freeze([
    {
      receipt: initialReceipt,
      evidence: { kind: "state_commit", state: state.committed.receiptEvidence },
    },
    { receipt: state.pages.prepared.receipt, evidence: { kind: "none" } },
    { receipt: pagesReceipt, evidence: state.pages.receiptEvidence },
    ...settlement.messageReceipts,
    { receipt: settlement.receipt, evidence: settlement.receiptEvidence },
    { receipt: state.finalization.receipt, evidence: state.finalization.receiptEvidence },
    { receipt: state.historyPages.prepared.receipt, evidence: { kind: "none" } },
    { receipt: history.receipt, evidence: { kind: "none" } },
  ]);
}

/** 新規runの公開段階を同じengineとreceipt chainで完了する。 */
export async function runDailyPublication<Types extends DailyTransactionTypeMap>(
  dependencies: DailyTransactionDependencies<Types>,
  runtime: DailyRunRuntime,
  input: PublicationStageInput<Types>,
  progress: DailyPublicationProgress<Types>,
): Promise<CompletedRun> {
  const { invocation, configuration, repositoryInventory, planned } = input;
  return runPreparedTrackingRun<
    PublicationStageInput<Types>,
    BoundPublicationCheckpoint,
    CommittedDailyState<Types>,
    PublishedDailyState<Types>,
    SettledDailyState<Types>,
    FinalizedDailyState<Types>,
    HistoryPagesDailyState<Types>,
    CompletedRun
  >(input, {
    checkpoint: async (prepared) => {
      progress.setStage("artifact");
      return dependencies.prepareCheckpoint(prepared);
    },
    commitInitialState: async (checkpoint) => {
      progress.setStage("state_persistence");
      const persisted = await dependencies.commitPreparedCheckpoint(input, checkpoint);
      progress.stateCommitted();
      return Object.freeze({
        stateRevision: persisted.result.revision,
        stateContentDigest: persisted.result.receipt.result.stateContentDigest,
      });
    },
    readCommittedState: (reference) =>
      dependencies.readCommittedState({ configuration, reference }),
    publishInitialPages: async (committed) => {
      progress.setStage("pages");
      const pagesPrepared = await dependencies.buildPages({
        invocation,
        configuration,
        repositoryInventory,
        planned,
        persisted: committed,
      });
      progress.pagesBuilt();
      const pages = await dependencies.deployPages({
        invocation,
        configuration,
        persisted: committed,
        pagesPrepared,
      });
      return Object.freeze({ committed, pages });
    },
    settleNotifications: async (published) => {
      progress.setStage("discord");
      progress.notificationStarted();
      const notifications = await dependencies.settleNotifications({
        invocation,
        configuration,
        repositoryInventory,
        persisted: published.committed,
        pages: published.pages,
      });
      progress.notificationsSettled(notifications);
      return Object.freeze({ ...published, notifications });
    },
    finalizeRun: async (settled) => {
      progress.setStage("state_persistence");
      const finalization = await dependencies.finalizeRun({
        invocation,
        configuration,
        repositoryInventory,
        persisted: settled.committed,
        notifications: settled.notifications.value,
      });
      return Object.freeze({ ...settled, finalization });
    },
    publishNotificationHistoryPages: async (finalized) => {
      progress.setStage("pages");
      const pagesPrepared = await dependencies.buildNotificationHistoryPages({
        configuration,
        settlementReceipt: finalized.notifications.value.receipt,
        finalizationReceipt: finalized.finalization.receipt,
      });
      const historyPages = await dependencies.deployNotificationHistoryPages({
        configuration,
        prepared: pagesPrepared,
        settlementReceipt: finalized.notifications.value.receipt,
        finalizationReceipt: finalized.finalization.receipt,
        runId: invocation.runId,
      });
      return Object.freeze({ ...finalized, historyPages });
    },
    complete: (history) => {
      progress.setStage("artifact");
      return Promise.resolve(
        completeTrackingRun(
          {
            entries: completionEntries(history),
            finalStateRevision: history.finalization.stateRevision,
            invocationId: invocation.invocationId,
            observedAt: runtime.now().toISOString(),
          },
          nodeContentDigestPort,
        ),
      );
    },
  });
}

import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import { stateCommitReceiptOperationId } from "../application/tracking-run/observed-state-commit.js";
import { assertRunTransactionMarkerTransition } from "../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "./branch-adapter.js";
import { OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 } from "./state-documents.js";
import { parseRunTransactionNotificationLedger } from "./state-documents.js";
import { initialNotificationLedger } from "./state-initial-notification-transition.js";
import { loadStateNotificationLedgers } from "./state-ledger-files.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { assertFinalizationTransition } from "./state-commit-chain-finalization.js";
import { assertNotificationCommitTransition } from "./state-commit-chain-notification.js";
import {
  assertTrackingCommitPaths,
  type VerifiedCommitTree as VerifiedTree,
} from "./state-commit-chain-paths.js";
import {
  assertSettledOutboxLedger,
  assertSettlementParentPhase,
} from "./state-commit-chain-settlement.js";
import { advanceSettlementMarker } from "./state-notification-transition.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  MAX_INTERVENING_COMMITS,
} from "./state-orthogonal-advance.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "./state-transaction-files.js";

async function readVerifiedAt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<VerifiedTree> {
  const paths = await adapter.listFiles(revision, "state");
  const fixedPaths = new Set([
    configuration.snapshotPath,
    configuration.notificationLedgerPath,
    OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  ]);
  const selected = paths.filter(
    (path) =>
      fixedPaths.has(path) ||
      path.startsWith(`${configuration.historyDirectory}/`) ||
      path.startsWith(`${configuration.runReportsDirectory}/`),
  );
  const files = await adapter.readFiles(revision, selected);
  if (
    files.size !== selected.length ||
    selected.some((path) => files.get(path)?.status !== "present")
  ) {
    throw new TypeError("Git祖先のexact state treeが不足しています");
  }
  const transaction = verifyRunTransactionFiles(files, configuration);
  if (transaction == null) {
    throw new TypeError("Git祖先にrun transactionがありません");
  }
  return { files, transaction };
}

async function previousTrackingRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  headRevision: string,
): Promise<string> {
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    if (commit.metadata.commitScope !== "operations_alert") {
      return revision;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("運用通知commitの前に追跡runのcommitがありません");
    }
    await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      commit.parent.revision,
      revision,
    );
    revision = commit.parent.revision;
  }
  throw new TypeError("追跡runのcommit探索が上限を超えています");
}

function assertCommitOperation(
  scope: "tracking_run" | "manual_resolution",
  operationId: string,
  current: VerifiedTree,
  previous: VerifiedTree | undefined,
  configuration: StatePersistenceConfiguration,
): void {
  const marker = current.transaction.marker;
  if (marker.phase === "notifications_in_progress") {
    if (previous == null) {
      throw new TypeError("通知commitの追跡祖先がありません");
    }
    assertNotificationCommitTransition(previous, current, configuration, scope, operationId);
    return;
  }
  if (scope !== "tracking_run") {
    throw new TypeError("state commitのscopeが不正です");
  }
  let receiptType: "initial_state_commit" | "notification_settlement" | "run_finalization";
  if (marker.phase === "initial_state_committed") {
    receiptType = "initial_state_commit";
  } else if (marker.phase === "notifications_settled") {
    receiptType = "notification_settlement";
  } else {
    receiptType = "run_finalization";
  }
  if (marker.phase === "initial_state_committed" && previous != null) {
    throw new TypeError("初回state commitの追跡祖先が不正です");
  }
  const expected = stateCommitReceiptOperationId(
    receiptType,
    marker.runId,
    marker.checkpointDigest,
    nodeContentDigestPort,
  );
  if (operationId !== expected) {
    throw new TypeError("state commitのoperation IDが保存済み値と一致しません");
  }
}

/** headから初回commitまでの全Git祖先とtransaction遷移を検証する。 */
export async function assertStateCommitChain(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  headRevision: string,
  verified: VerifiedRunTransactionFiles,
  initialStateRevision: string,
): Promise<string> {
  const latestRevision = await previousTrackingRevision(adapter, configuration, headRevision);
  const latest = await readVerifiedAt(adapter, configuration, latestRevision);
  if (
    serializeCanonicalJson(latest.transaction.marker) !== serializeCanonicalJson(verified.marker) ||
    latest.transaction.record.recordDigest !== verified.record.recordDigest
  ) {
    throw new TypeError("headの検証済みtransactionとGit祖先の先頭が一致しません");
  }
  let revision = latestRevision;
  let settled: VerifiedTree | undefined;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const [commit, current] = await Promise.all([
      adapter.readCommit(revision),
      readVerifiedAt(adapter, configuration, revision),
    ]);
    const parentRevision = commit.parent.status === "present" ? commit.parent.revision : "unborn";
    if (
      (commit.metadata.commitScope !== "tracking_run" &&
        commit.metadata.commitScope !== "manual_resolution") ||
      commit.metadata.runId !== verified.marker.runId ||
      current.transaction.marker.expectedParentStateRevision !== parentRevision ||
      current.transaction.marker.runId !== verified.marker.runId ||
      current.transaction.record.recordDigest !== verified.record.recordDigest ||
      current.transaction.snapshotSchemaVersion !== verified.snapshotSchemaVersion ||
      !commit.changedPathManifest.entries.some(
        (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      )
    ) {
      throw new TypeError("Git祖先のcommit metadataとtransactionが一致しません");
    }
    if (revision === initialStateRevision) {
      if (
        current.transaction.marker.phase !== "initial_state_committed" ||
        current.transaction.snapshotDigest !==
          current.transaction.record.initialStateContentDigests.snapshot ||
        current.transaction.notificationLedgerDigest !==
          current.transaction.record.initialStateContentDigests.notificationLedger
      ) {
        throw new TypeError("初回state commitと現在のrecord chainが一致しません");
      }
      assertCommitOperation(
        commit.metadata.commitScope,
        commit.metadata.operationId,
        current,
        undefined,
        configuration,
      );
      const parentLedger = await loadStateNotificationLedgers(
        adapter,
        configuration,
        commit.parent,
      );
      const expectedLedger = initialNotificationLedger(parentLedger, current.transaction.record);
      const actualFile = current.files.get(configuration.notificationLedgerPath);
      if (actualFile?.status !== "present") {
        throw new TypeError("初回state commitの通常ledgerがありません");
      }
      const actualLedger = parseRunTransactionNotificationLedger(
        new TextDecoder("utf-8", { fatal: true }).decode(actualFile.bytes),
      ).ledger;
      if (
        serializeCanonicalJson(normalNotificationLedgerValue(actualLedger)) !==
        serializeCanonicalJson(normalNotificationLedgerValue(expectedLedger))
      ) {
        throw new TypeError(
          "初回state commitのledgerが固定outboxと親stateから導出した値と一致しません",
        );
      }
      await assertTrackingCommitPaths(adapter, configuration, commit, current, undefined);
      if (settled != null) {
        assertSettledOutboxLedger(current, settled, configuration);
      }
      await authorizeAdvanceAfterOrthogonalCommits(
        adapter,
        configuration,
        current.transaction.marker.baseStateRevision,
        parentRevision,
      );
      return latestRevision;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("Git祖先が初回state commitに到達しません");
    }
    const previousRevision = await previousTrackingRevision(
      adapter,
      configuration,
      commit.parent.revision,
    );
    await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      previousRevision,
      commit.parent.revision,
    );
    const previous = await readVerifiedAt(adapter, configuration, previousRevision);
    if (
      current.transaction.marker.phase === "initial_state_committed" ||
      current.transaction.marker.initialStateRevision !== initialStateRevision ||
      previous.transaction.marker.runId !== verified.marker.runId ||
      previous.transaction.record.recordDigest !== verified.record.recordDigest
    ) {
      throw new TypeError("Git祖先のrunまたは初回revisionが一致しません");
    }
    assertRunTransactionMarkerTransition(
      previous.transaction.marker,
      current.transaction.marker,
      parentRevision,
      current.transaction.initialPagesEvidence,
    );
    if (
      current.transaction.initialPagesEvidence?.pageUrl !==
      current.transaction.record.initialPagesProjection.settings.url
    ) {
      throw new TypeError("Git祖先のPages証拠が固定公開URLと一致しません");
    }
    if (current.transaction.marker.phase === "notifications_settled") {
      assertSettlementParentPhase(current.transaction.record, previous.transaction.marker.phase);
      const evidence = current.transaction.initialPagesEvidence;
      const expectedMarker = advanceSettlementMarker(
        previous.transaction.marker,
        evidence,
        evidence.sourceStateRevision,
        parentRevision,
        previous.transaction.notificationLedgerDigest,
      );
      if (
        serializeCanonicalJson(expectedMarker) !==
        serializeCanonicalJson(current.transaction.marker)
      ) {
        throw new TypeError("通知settlementのmarkerが親stateから導出した値と一致しません");
      }
      settled = current;
    }
    if (current.transaction.marker.phase === "run_finalized") {
      assertFinalizationTransition(previous, current, configuration);
    }
    assertCommitOperation(
      commit.metadata.commitScope,
      commit.metadata.operationId,
      current,
      previous,
      configuration,
    );
    await assertTrackingCommitPaths(adapter, configuration, commit, current, previous);
    revision = previousRevision;
  }
  throw new TypeError("state commitのGit祖先探索が上限を超えています");
}

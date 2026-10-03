import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import { stateCommitReceiptOperationId } from "../application/tracking-run/observed-state-commit.js";
import { receiptIdentifiers } from "../application/tracking-run/receipt-codec.js";
import { assertRunTransactionMarkerTransition } from "../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type {
  StateBranchAdapter,
  StateFileReadResult,
  StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { parseStateNotificationLedger } from "./state-documents.js";
import { OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 } from "./state-documents.js";
import { createStateCommitOperationId } from "./state-commit-metadata.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  MAX_INTERVENING_COMMITS,
} from "./state-orthogonal-advance.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "./state-transaction-files.js";

type VerifiedTree = Readonly<{
  files: ReadonlyMap<string, StateFileReadResult>;
  transaction: VerifiedRunTransactionFiles;
}>;

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

function notificationLedger(
  tree: VerifiedTree,
  configuration: StatePersistenceConfiguration,
): ReturnType<typeof parseStateNotificationLedger> {
  const file = tree.files.get(configuration.notificationLedgerPath);
  if (file?.status !== "present") {
    throw new TypeError("Git祖先の通常ledgerがありません");
  }
  return parseStateNotificationLedger(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
}

function assertCommitOperation(
  scope: "tracking_run" | "manual_resolution",
  operationId: string,
  current: VerifiedTree,
  previous: VerifiedTree | undefined,
  configuration: StatePersistenceConfiguration,
): void {
  const { marker, record } = current.transaction;
  let expected: string;
  if (marker.phase === "initial_state_committed") {
    if (scope !== "tracking_run" || previous != null) {
      throw new TypeError("初回state commitのscopeが不正です");
    }
    expected = stateCommitReceiptOperationId(
      "initial_state_commit",
      marker.runId,
      marker.checkpointDigest,
      nodeContentDigestPort,
    );
  } else if (marker.phase === "notifications_settled") {
    if (scope !== "tracking_run") {
      throw new TypeError("通知settlementのcommit scopeが不正です");
    }
    expected = stateCommitReceiptOperationId(
      "notification_settlement",
      marker.runId,
      marker.checkpointDigest,
      nodeContentDigestPort,
    );
  } else if (marker.phase === "run_finalized") {
    if (scope !== "tracking_run") {
      throw new TypeError("run finalizationのcommit scopeが不正です");
    }
    expected = stateCommitReceiptOperationId(
      "run_finalization",
      marker.runId,
      marker.checkpointDigest,
      nodeContentDigestPort,
    );
  } else {
    if (previous == null) {
      throw new TypeError("通知commitの追跡祖先がありません");
    }
    const prior = notificationLedger(previous, configuration);
    const next = notificationLedger(current, configuration);
    const priorByKey = new Map(prior.entries.map((entry) => [entry.notificationKey, entry]));
    if (scope === "manual_resolution") {
      if (previous.transaction.marker.phase !== "notifications_in_progress") {
        throw new TypeError("手動解決の前に通知開始済みmarkerが必要です");
      }
      const resolutions = next.entries.flatMap((entry) => {
        const resolution = entry.manualResolution;
        const priorEntry = priorByKey.get(entry.notificationKey);
        const before = priorEntry?.manualResolution;
        if (
          resolution != null &&
          (priorEntry?.status !== "delivery_started" ||
            priorEntry.deliveryId !== resolution.deliveryId ||
            priorEntry.lastDeliveryAttempt?.attemptId !== resolution.attemptId ||
            priorEntry.lastDeliveryAttempt.result !== "started")
        ) {
          throw new TypeError("手動解決の元となる開始済み送達試行がありません");
        }
        return resolution != null &&
          (before == null || serializeCanonicalJson(resolution) !== serializeCanonicalJson(before))
          ? [resolution]
          : [];
      });
      const resolution = resolutions[0];
      if (
        resolution == null ||
        new Set(resolutions.map((value) => serializeCanonicalJson(value))).size !== 1
      ) {
        throw new TypeError("手動解決commitのoperation IDをledgerから特定できません");
      }
      expected = receiptIdentifiers(
        {
          binding: {
            bindingKind: "checkpoint",
            runId: record.runIdentity.runId,
            checkpointDigest: record.checkpointDigest,
            checkpointFileDigest: record.checkpointFileDigest,
            runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
              serializeCanonicalJson(record.runtimeIdentity),
            ),
          },
          stage: "notifications_settled",
          phase: "notification",
          logicalTarget: `manual:${record.checkpointDigest}:${resolution.deliveryId}:${resolution.attemptId}:${resolution.decision}`,
          invocationId: record.runIdentity.invocationId,
          localAttemptIndex: 0,
        },
        nodeContentDigestPort,
      ).operationId;
      if (resolution.operationId !== expected) {
        throw new TypeError("手動解決のledgerと論理操作IDが一致しません");
      }
    } else {
      const attempts = next.entries.flatMap((entry) => {
        const attempt = entry.lastDeliveryAttempt;
        const before = priorByKey.get(entry.notificationKey)?.lastDeliveryAttempt;
        return attempt != null &&
          (before == null || serializeCanonicalJson(attempt) !== serializeCanonicalJson(before))
          ? [attempt]
          : [];
      });
      const attempt = attempts[0];
      if (
        attempt == null ||
        new Set(attempts.map((value) => serializeCanonicalJson(value))).size !== 1
      ) {
        throw new TypeError("通知commitの送達試行をledgerから特定できません");
      }
      if (record.notificationOutbox.action !== "send") {
        throw new TypeError("通知commitの送達試行が不正です");
      }
      const changedKeys = next.entries
        .filter((entry) =>
          attempts.some((value) => entry.lastDeliveryAttempt?.attemptId === value.attemptId),
        )
        .map((entry) => entry.notificationKey)
        .sort();
      if (
        serializeCanonicalJson(changedKeys) !==
          serializeCanonicalJson([...attempt.notificationKeys].sort()) ||
        attempt.notificationKeys.some((key) => {
          const before = priorByKey.get(key);
          const after = next.entries.find((entry) => entry.notificationKey === key);
          if (after?.lastDeliveryAttempt?.attemptId !== attempt.attemptId) {
            return true;
          }
          if (attempt.result === "started") {
            return before?.status !== "reserved" || after.status !== "delivery_started";
          }
          return (
            before?.status !== "delivery_started" ||
            before.lastDeliveryAttempt?.attemptId !== attempt.attemptId ||
            before.lastDeliveryAttempt.result !== "started" ||
            after.status !== (attempt.result === "sent" ? "sent" : "reserved")
          );
        })
      ) {
        throw new TypeError("通知commitの送達試行とledger遷移が一致しません");
      }
      expected = createStateCommitOperationId({
        kind: "notification_message",
        deliveryOperationId: attempt.operationId,
        deliveryAttemptId: attempt.attemptId,
        transition: attempt.result === "started" ? "reservation" : "result",
      });
    }
  }
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
    assertCommitOperation(
      commit.metadata.commitScope,
      commit.metadata.operationId,
      current,
      previous,
      configuration,
    );
    revision = previousRevision;
  }
  throw new TypeError("state commitのGit祖先探索が上限を超えています");
}

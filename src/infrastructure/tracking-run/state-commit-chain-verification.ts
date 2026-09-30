import {
  type StateBranchAdapter,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  MAX_INTERVENING_COMMITS,
} from "../../persistence/state-orthogonal-advance.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";

async function readVerifiedAt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<VerifiedRunTransactionFiles> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  const verified = verifyRunTransactionFiles(files, configuration);
  if (verified == null) {
    throw new TypeError("指定revisionにrun transactionがありません");
  }
  return verified;
}

async function latestTrackingRevision(
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

/** 現在と初回のstate commitをmarkerとrecordへ結び付ける。 */
export async function assertStateCommitChain(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  headRevision: string,
  verified: VerifiedRunTransactionFiles,
  initialStateRevision: string,
): Promise<string> {
  const latestRevision = await latestTrackingRevision(adapter, configuration, headRevision);
  const latestCommit = await adapter.readCommit(latestRevision);
  const latestParent =
    latestCommit.parent.status === "present" ? latestCommit.parent.revision : "unborn";
  if (
    (latestCommit.metadata.commitScope !== "tracking_run" &&
      latestCommit.metadata.commitScope !== "manual_resolution") ||
    latestCommit.metadata.runId !== verified.marker.runId ||
    verified.marker.expectedParentStateRevision !== latestParent
  ) {
    throw new TypeError("markerがexact tracking commitの親と一致しません");
  }
  const initial = await readVerifiedAt(adapter, configuration, initialStateRevision);
  const initialCommit = await adapter.readCommit(initialStateRevision);
  if (
    initial.marker.phase !== "initial_state_committed" ||
    initial.record.recordDigest !== verified.record.recordDigest ||
    initial.marker.runId !== verified.marker.runId ||
    initial.marker.checkpointDigest !== verified.marker.checkpointDigest ||
    initial.snapshotDigest !== verified.record.initialStateContentDigests.snapshot ||
    initial.notificationLedgerDigest !==
      verified.record.initialStateContentDigests.notificationLedger ||
    initialCommit.metadata.commitScope !== "tracking_run" ||
    initialCommit.metadata.runId !== verified.marker.runId ||
    initial.marker.expectedParentStateRevision !==
      (initialCommit.parent.status === "present" ? initialCommit.parent.revision : "unborn")
  ) {
    throw new TypeError("初回state commitと現在のrecord chainが一致しません");
  }
  return latestRevision;
}

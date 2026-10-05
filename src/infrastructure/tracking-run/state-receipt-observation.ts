import type { PerformanceDetailObserver } from "../../application/tracking-run/contracts/performance-detail-observation.js";
import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  observeStateCommitReceipt,
  type ObservedStateCommitPosition,
  type StateCommitReceiptEvidence,
} from "../../application/tracking-run/observed-state-commit.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { assertRunTransactionMarkerTransition } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  type StateBranchAdapter,
  type StateBranchCommitInspection,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  MAX_INTERVENING_COMMITS,
} from "../../persistence/state-orthogonal-advance.js";
import { assertStateCommitChain } from "../../persistence/state-commit-chain-verification.js";
import { isOrthogonalStateCommitScope } from "../../persistence/state-commit-metadata.js";
import {
  finalizedHistoryDigest,
  finalizedRunReportDigest,
} from "../../persistence/state-transaction-finalization.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";
import type { StateSnapshot } from "../../persistence/snapshot-v23.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  assertPostSaveExactReadDependencies,
  assertPostSaveExactReadTree,
  assertPostSaveExactSnapshotBytes,
  recordPostSaveExactReads,
  type PostSaveExactReadFootprint,
} from "./post-save-exact-reads.js";

const postSaveExactProofBrand: unique symbol = Symbol("postSaveExactProof");

/** 公開済みrevisionの完全検証と読込元だけを保持する短命証明。 */
type PostSaveExactProof = Readonly<{
  [postSaveExactProofBrand]: true;
  transaction: VerifiedRunTransactionFiles;
}>;

type ProofRun = Readonly<{ runId: string; token: symbol; proof?: PostSaveExactProof }>;
type ProofDetails = Readonly<{
  scope: PostSaveExactProofScope;
  runToken: symbol;
  revision: string;
  configuration: string;
  footprint: PostSaveExactReadFootprint;
}>;

const adapterScopes = new WeakMap<StateBranchAdapter, PostSaveExactProofScope>();
const scopeRuns = new WeakMap<PostSaveExactProofScope, ProofRun>();
const issuedProofDetails = new WeakMap<PostSaveExactProof, ProofDetails>();

/** 日次run内の同じadapter生成元だけに証明を渡す。 */
export class PostSaveExactProofScope {
  /** 日次runの開始時に前の証明を破棄する。 */
  public beginRun(runId: string): void {
    scopeRuns.set(this, { runId, token: Symbol("postSaveExactProofRun") });
  }

  /** 日次runの終了時に証明を破棄する。 */
  public endRun(runId: string): void {
    if (scopeRuns.get(this)?.runId === runId) {
      scopeRuns.delete(this);
    }
  }

  /** 同じadapter生成元から得たadapterをscopeへ結び付ける。 */
  public register(adapter: StateBranchAdapter): void {
    adapterScopes.set(adapter, this);
  }
}

function activePostSaveExactProofDetails(proof: PostSaveExactProof): ProofDetails {
  const details = issuedProofDetails.get(proof);
  const run = details == null ? undefined : scopeRuns.get(details.scope);
  if (details == null || run?.proof !== proof || run.token !== details.runToken) {
    throw new TypeError("公開済みexact revisionの証明が現在のrunに属していません");
  }
  return details;
}

/** 同じrunと設定で保持した公開済みrevisionの証明を返す。 */
export function postSaveExactProof(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): PostSaveExactProof | undefined {
  const scope = adapterScopes.get(adapter);
  const proof = scope == null ? undefined : scopeRuns.get(scope)?.proof;
  if (proof == null) {
    return undefined;
  }
  const details = activePostSaveExactProofDetails(proof);
  return details.revision === revision &&
    details.configuration === serializeCanonicalJson(configuration)
    ? proof
    : undefined;
}

function freezeTransaction(value: unknown): void {
  if (typeof value !== "object" || value == null) {
    return;
  }
  for (const nested of Object.values(value)) {
    freezeTransaction(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
}

function issueAndRetainPostSaveExactProof(
  scope: PostSaveExactProofScope,
  runToken: symbol,
  configuration: StatePersistenceConfiguration,
  revision: string,
  transaction: VerifiedRunTransactionFiles,
  footprint: PostSaveExactReadFootprint,
): void {
  const run = scopeRuns.get(scope);
  if (
    run?.token !== runToken ||
    transaction.marker.runId !== run.runId ||
    transaction.snapshotSchemaVersion !== "23" ||
    transaction.marker.phase !== "initial_state_committed"
  ) {
    throw new TypeError("初回公開済みexact revisionの証明入力が現在のrunに一致しません");
  }
  freezeTransaction(transaction);
  const proof = Object.freeze({
    [postSaveExactProofBrand]: true,
    transaction,
  } satisfies PostSaveExactProof);
  issuedProofDetails.set(
    proof,
    Object.freeze({
      scope,
      runToken,
      revision,
      configuration: serializeCanonicalJson(configuration),
      footprint,
    }),
  );
  scopeRuns.set(scope, { ...run, proof });
}

/** freshなpath、byte列を完全検証時の同じexact treeへ照合する。 */
export function assertPostSaveExactTree(
  proof: PostSaveExactProof,
  paths: readonly string[],
  files: ReadonlyMap<string, StateFileReadResult>,
): void {
  const details = activePostSaveExactProofDetails(proof);
  assertPostSaveExactReadTree(details.footprint, details.revision, paths, files);
}

/** chain検証に使用した全revisionの読込値をfreshなadapter応答と照合する。 */
export async function assertPostSaveExactDependencies(
  adapter: StateBranchAdapter,
  proof: PostSaveExactProof,
  currentFiles: ReadonlyMap<string, StateFileReadResult>,
  currentCommit: StateBranchCommitInspection,
): Promise<void> {
  const details = activePostSaveExactProofDetails(proof);
  if (adapterScopes.get(adapter) !== details.scope) {
    throw new TypeError("公開済みexact revisionのadapter生成元が証明と一致しません");
  }
  await assertPostSaveExactReadDependencies(
    adapter,
    details.footprint,
    details.revision,
    currentFiles,
    currentCommit,
  );
  activePostSaveExactProofDetails(proof);
}

/** 証明済みsnapshot byteだけを同じ論理値として復元する。 */
export function parseProvenStateSnapshot(
  proof: PostSaveExactProof,
  configuration: StatePersistenceConfiguration,
  bytes: Uint8Array,
): StateSnapshot {
  const details = activePostSaveExactProofDetails(proof);
  if (details.configuration !== serializeCanonicalJson(configuration)) {
    throw new TypeError("snapshotの設定が公開済みexact revisionの証明と一致しません");
  }
  assertPostSaveExactSnapshotBytes(
    details.footprint,
    details.revision,
    configuration.snapshotPath,
    bytes,
  );
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parse: (value: string) => StateSnapshot = JSON.parse;
  const snapshot = parse(source);
  freezeTransaction(snapshot);
  return snapshot;
}

type ObservedCommit<T> = Readonly<{
  receipt: T;
  evidence: StateCommitReceiptEvidence;
}>;

type VerifiedTree = Readonly<{
  files: ReadonlyMap<string, StateFileReadResult>;
  transaction: VerifiedRunTransactionFiles;
}>;

async function readVerifiedTree(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<VerifiedTree> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("観測対象のexact state file一覧が不足しています");
  }
  const proof = postSaveExactProof(adapter, configuration, revision);
  if (proof != null) {
    assertPostSaveExactTree(proof, paths, files);
  }
  const transaction = proof?.transaction ?? verifyRunTransactionFiles(files, configuration);
  if (transaction == null) {
    throw new TypeError("観測対象のexact stateにrun transactionがありません");
  }
  return { files, transaction };
}

async function previousTrackingRevision(
  adapter: StateBranchAdapter,
  parentRevision: string,
): Promise<string> {
  let revision = parentRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      return revision;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("追跡commitの前に運用通知commitの祖先がありません");
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("追跡commitの祖先探索が上限を超えています");
}

async function assertCommitAncestry(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  recordDigest: string,
): Promise<Readonly<{ expectedTrackingRevision: string; intervening: readonly string[] }>> {
  let currentRevision = revision;
  let targetParent:
    Readonly<{ expectedTrackingRevision: string; intervening: readonly string[] }> | undefined;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (currentRevision === initialStateRevision) {
      if (targetParent == null) {
        throw new TypeError("後続state commitの祖先がありません");
      }
      return targetParent;
    }
    const [currentCommit, currentTree] = await Promise.all([
      adapter.readCommit(currentRevision),
      readVerifiedTree(adapter, configuration, currentRevision),
    ]);
    if (
      currentCommit.parent.status !== "present" ||
      (currentCommit.metadata.commitScope !== "tracking_run" &&
        currentCommit.metadata.commitScope !== "manual_resolution") ||
      currentCommit.metadata.runId !== currentTree.transaction.marker.runId ||
      currentTree.transaction.record.recordDigest !== recordDigest ||
      !currentCommit.changedPathManifest.entries.some(
        (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      )
    ) {
      throw new TypeError("後続state commitのmetadataとmarkerが一致しません");
    }
    const previousRevision = await previousTrackingRevision(adapter, currentCommit.parent.revision);
    const advance = await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      previousRevision,
      currentCommit.parent.revision,
    );
    const previousTree = await readVerifiedTree(adapter, configuration, previousRevision);
    if (
      previousTree.transaction.marker.runId !== currentTree.transaction.marker.runId ||
      previousTree.transaction.record.recordDigest !== recordDigest ||
      (currentTree.transaction.marker.phase !== "initial_state_committed" &&
        currentTree.transaction.marker.initialStateRevision !== initialStateRevision)
    ) {
      throw new TypeError("後続state commitのrunまたは初回revisionが一致しません");
    }
    assertRunTransactionMarkerTransition(
      previousTree.transaction.marker,
      currentTree.transaction.marker,
      currentCommit.parent.revision,
      currentTree.transaction.initialPagesEvidence,
    );
    targetParent ??= {
      expectedTrackingRevision: previousRevision,
      intervening: advance.interveningOperationsAlertCommits,
    };
    currentRevision = previousRevision;
  }
  throw new TypeError("後続state commitの祖先探索が上限を超えています");
}

/** commit metadataと全marker遷移から復旧用のstate receiptを再観測する。 */
export async function observeStateCommitAtRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  receiptType: StateCommitReceiptEvidence["receiptType"],
  observation: Readonly<{
    invocationId: string;
    observedAt: string;
    position: ObservedStateCommitPosition;
  }>,
  observePerformanceDetail?: PerformanceDetailObserver,
  issuePostSaveProof?: boolean,
): Promise<
  ObservedCommit<InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt>
> {
  const proof = postSaveExactProof(adapter, configuration, revision);
  const scope = adapterScopes.get(adapter);
  const proofRun = scope == null ? undefined : scopeRuns.get(scope);
  const recording =
    issuePostSaveProof === true && proof == null && scope != null && proofRun != null
      ? Object.freeze({
          ...recordPostSaveExactReads(adapter),
          scope,
          runToken: proofRun.token,
        })
      : undefined;
  const readingAdapter = recording?.adapter ?? adapter;
  const [tree, commit] = await Promise.all([
    readVerifiedTree(readingAdapter, configuration, revision),
    readingAdapter.readCommit(revision),
  ]);
  observePerformanceDetail?.({ step: "receipt_tree_read", count: tree.files.size });
  const { marker, record } = tree.transaction;
  if (proof == null) {
    await assertStateCommitChain(
      readingAdapter,
      configuration,
      revision,
      tree.transaction,
      initialStateRevision,
      { revision, files: tree.files, transaction: tree.transaction },
    );
  } else {
    await assertPostSaveExactDependencies(adapter, proof, tree.files, commit);
  }
  observePerformanceDetail?.({ step: "receipt_commit_chain_verified" });
  if (
    commit.metadata.commitScope !== "tracking_run" ||
    commit.metadata.runId !== marker.runId ||
    commit.changedPathManifest.entries.every(
      (entry) => entry.path !== RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    ) ||
    observation.invocationId === record.runIdentity.invocationId
  ) {
    throw new TypeError("state commitのmetadataまたは再観測試行が不正です");
  }
  const parentRevision = commit.parent.status === "present" ? commit.parent.revision : "unborn";
  let expectedTrackingStateRevision: string;
  let interveningOperationsAlertCommits: readonly string[];
  if (receiptType === "initial_state_commit") {
    if (revision !== initialStateRevision || marker.phase !== "initial_state_committed") {
      throw new TypeError("初回state commitのrevisionまたはphaseが一致しません");
    }
    expectedTrackingStateRevision = marker.baseStateRevision;
    const advance = await authorizeAdvanceAfterOrthogonalCommits(
      readingAdapter,
      configuration,
      expectedTrackingStateRevision,
      parentRevision,
    );
    interveningOperationsAlertCommits = advance.interveningOperationsAlertCommits;
  } else {
    const ancestry = await assertCommitAncestry(
      readingAdapter,
      configuration,
      revision,
      initialStateRevision,
      record.recordDigest,
    );
    expectedTrackingStateRevision = ancestry.expectedTrackingRevision;
    interveningOperationsAlertCommits = ancestry.intervening;
  }
  const common = {
    marker,
    record: {
      runId: record.runIdentity.runId,
      checkpointDigest: record.checkpointDigest,
      checkpointFileDigest: record.checkpointFileDigest,
      runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
        serializeCanonicalJson(record.runtimeIdentity),
      ),
      recordDigest: record.recordDigest,
      notificationAction: record.notificationOutbox.action,
    },
    commit: {
      revision,
      parentRevision,
      operationId: commit.metadata.operationId,
      runId: marker.runId,
      commitScope: commit.metadata.commitScope,
      changedPathManifestDigest: commit.metadata.changedPathManifestDigest,
    },
    expectedTrackingStateRevision,
    interveningOperationsAlertCommits: [...interveningOperationsAlertCommits],
    snapshotDigest: tree.transaction.snapshotDigest,
    notificationLedgerDigest: tree.transaction.notificationLedgerDigest,
  };
  let evidence: StateCommitReceiptEvidence;
  if (receiptType === "initial_state_commit") {
    evidence = { ...common, receiptType };
  } else if (receiptType === "notification_settlement") {
    evidence = {
      ...common,
      receiptType,
      notificationHistoryDigest: finalizedHistoryDigest(tree.files, configuration, marker, record),
    };
  } else {
    evidence = {
      ...common,
      receiptType,
      runReportDigest: finalizedRunReportDigest(tree.files, configuration, marker, record),
    };
  }
  const receipt = observeStateCommitReceipt(evidence, observation, nodeContentDigestPort);
  verifyReceiptChain(
    [{ receipt, evidence: { kind: "state_commit", state: evidence } }],
    nodeContentDigestPort,
  );
  if (recording != null) {
    issueAndRetainPostSaveExactProof(
      recording.scope,
      recording.runToken,
      configuration,
      revision,
      tree.transaction,
      recording.footprint,
    );
  }
  observePerformanceDetail?.({ step: "receipt_created" });
  return Object.freeze({ receipt, evidence });
}

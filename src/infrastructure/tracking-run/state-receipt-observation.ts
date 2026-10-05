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
import { assertPublishedStateCommit } from "../../persistence/state-cas-observation.js";
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

type ProofRun = Readonly<{
  runId: string;
  token: symbol;
  adapter: StateBranchAdapter;
  proof?: PostSaveExactProof;
}>;
type PostSaveExactProofScope = Readonly<{
  createStateBranchAdapter: () => StateBranchAdapter;
  beginRun: (runId: string) => void;
  endRun: (runId: string) => void;
}>;
type ProofDetails = Readonly<{
  scope: PostSaveExactProofScope;
  runToken: symbol;
  adapter: StateBranchAdapter;
  revision: string;
  configuration: string;
  footprint: PostSaveExactReadFootprint;
}>;

const adapterScopes = new WeakMap<StateBranchAdapter, PostSaveExactProofScope>();
const scopeRuns = new WeakMap<PostSaveExactProofScope, ProofRun>();
const issuedProofDetails = new WeakMap<PostSaveExactProof, ProofDetails>();

function bindStateBranchAdapter(source: StateBranchAdapter): StateBranchAdapter {
  return Object.freeze({
    resolveHead: source.resolveHead.bind(source),
    ...(source.resolveRepositoryRevision == null
      ? {}
      : { resolveRepositoryRevision: source.resolveRepositoryRevision.bind(source) }),
    ...(source.resolveOriginUrls == null
      ? {}
      : { resolveOriginUrls: source.resolveOriginUrls.bind(source) }),
    readFile: source.readFile.bind(source),
    readFiles: source.readFiles.bind(source),
    listFiles: source.listFiles.bind(source),
    readCommit: source.readCommit.bind(source),
    commit: source.commit.bind(source),
    publish: source.publish.bind(source),
  });
}

/** 日次runごとに保存と観測が共有するadapterを固定する。 */
export function createPostSaveExactProofScope(
  createSource: () => StateBranchAdapter,
): PostSaveExactProofScope {
  const scope: PostSaveExactProofScope = Object.freeze({
    createStateBranchAdapter: (): StateBranchAdapter =>
      scopeRuns.get(scope)?.adapter ?? bindStateBranchAdapter(createSource()),
    beginRun: (runId: string): void => {
      const adapter = bindStateBranchAdapter(createSource());
      adapterScopes.set(adapter, scope);
      scopeRuns.set(scope, { runId, token: Symbol("postSaveExactProofRun"), adapter });
    },
    endRun: (runId: string): void => {
      if (scopeRuns.get(scope)?.runId === runId) {
        scopeRuns.delete(scope);
      }
    },
  });
  return scope;
}

function activePostSaveExactProofDetails(proof: PostSaveExactProof): ProofDetails {
  const details = issuedProofDetails.get(proof);
  const run = details == null ? undefined : scopeRuns.get(details.scope);
  if (
    details == null ||
    run?.proof !== proof ||
    run.token !== details.runToken ||
    run.adapter !== details.adapter
  ) {
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
    details.configuration === serializeCanonicalJson(configuration) &&
    details.adapter === adapter
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
      adapter: run.adapter,
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
  if (adapterScopes.get(adapter) !== details.scope || adapter !== details.adapter) {
    throw new TypeError("公開済みexact revisionの読込adapterが証明と一致しません");
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

type StateCommitObservation = Readonly<{
  invocationId: string;
  observedAt: string;
  position: ObservedStateCommitPosition;
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

async function observePublishedStateCommitAtRevision(
  adapter: StateBranchAdapter,
  currentConfiguration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  receiptType: StateCommitReceiptEvidence["receiptType"],
  observation: StateCommitObservation,
  observePerformanceDetail: PerformanceDetailObserver | undefined,
  observationKind: "initial_publication" | "receipt_reobservation",
): Promise<
  ObservedCommit<InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt>
> {
  const configuration = Object.freeze({ ...currentConfiguration });
  const configurationIdentity = serializeCanonicalJson(configuration);
  const proof = postSaveExactProof(adapter, configuration, revision);
  const scope = adapterScopes.get(adapter);
  const proofRun = scope == null ? undefined : scopeRuns.get(scope);
  if (proofRun != null && proofRun.adapter !== adapter) {
    throw new TypeError("公開stateの読込adapterが現在のrunに属していません");
  }
  const source = scope == null ? bindStateBranchAdapter(adapter) : adapter;
  const recording =
    observationKind === "initial_publication" && proof == null && scope != null && proofRun != null
      ? Object.freeze({
          ...recordPostSaveExactReads(source),
          scope,
          runToken: proofRun.token,
        })
      : undefined;
  const readingAdapter = recording?.adapter ?? source;
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
    commit.revision !== revision ||
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
  await assertPublishedStateCommit(source, configuration, commit);
  if (
    adapterScopes.get(adapter) !== scope ||
    (scope != null && scopeRuns.get(scope)?.token !== proofRun?.token) ||
    serializeCanonicalJson(currentConfiguration) !== configurationIdentity ||
    (recording != null && marker.runId !== proofRun?.runId)
  ) {
    throw new TypeError("公開stateの観測中に生成元、runまたは設定が変化しました");
  }
  if (recording != null && tree.transaction.snapshotSchemaVersion === "23") {
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

/** 公開済み初回stateを完全検証して同じ日次runの証明を保持する。 */
export async function observeInitialPublishedStateCommit(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  observation: StateCommitObservation,
  observePerformanceDetail?: PerformanceDetailObserver,
): Promise<ObservedCommit<InitialStateCommitReceipt>> {
  const observed = await observePublishedStateCommitAtRevision(
    adapter,
    configuration,
    revision,
    revision,
    "initial_state_commit",
    observation,
    observePerformanceDetail,
    "initial_publication",
  );
  if (observed.receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回公開stateのreceipt種別が不正です");
  }
  return Object.freeze({ receipt: observed.receipt, evidence: observed.evidence });
}

/** 公開head、commit metadataと全marker遷移からstate receiptを再観測する。 */
export async function observeStateCommitAtRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  receiptType: StateCommitReceiptEvidence["receiptType"],
  observation: StateCommitObservation,
  observePerformanceDetail?: PerformanceDetailObserver,
): Promise<
  ObservedCommit<InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt>
> {
  return observePublishedStateCommitAtRevision(
    adapter,
    configuration,
    revision,
    initialStateRevision,
    receiptType,
    observation,
    observePerformanceDetail,
    "receipt_reobservation",
  );
}

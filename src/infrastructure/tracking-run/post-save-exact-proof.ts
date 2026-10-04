import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StateBranchCommitInspection,
  StateFileReadResult,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import type { StateSnapshot } from "../../persistence/snapshot-v23.js";
import type { VerifiedRunTransactionFiles } from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort } from "./content-digest.js";

const postSaveExactProofBrand: unique symbol = Symbol("postSaveExactProof");

type FileFingerprint =
  Readonly<{ status: "missing" }> | Readonly<{ status: "present"; length: number; digest: string }>;

type ReadFootprint = Readonly<{
  listings: ReadonlyMap<string, readonly string[]>;
  files: ReadonlyMap<string, ReadonlyMap<string, FileFingerprint>>;
  commits: ReadonlyMap<string, string>;
}>;

/** 公開済みrevisionの完全検証と読込元だけを保持する短命証明。 */
type PostSaveExactProof = Readonly<{
  [postSaveExactProofBrand]: true;
  runToken: symbol;
  revision: string;
  configuration: string;
  transaction: VerifiedRunTransactionFiles;
  footprint: ReadFootprint;
}>;

/** 日次run内の同じadapter生成元だけに証明を渡す。 */
export class PostSaveExactProofScope {
  #run:
    | Readonly<{ status: "idle" }>
    | Readonly<{ status: "active"; runId: string; token: symbol; proof?: PostSaveExactProof }> = {
    status: "idle",
  };

  /** 日次runの開始時に前の証明を破棄する。 */
  public beginRun(runId: string): void {
    this.#run = { status: "active", runId, token: Symbol("postSaveExactProofRun") };
  }

  /** 日次runの終了時に証明を破棄する。 */
  public endRun(runId: string): void {
    if (this.#run.status === "active" && this.#run.runId === runId) {
      this.#run = { status: "idle" };
    }
  }

  /** 同じadapter生成元から得たadapterをscopeへ結び付ける。 */
  public register(adapter: StateBranchAdapter): void {
    adapterScopes.set(adapter, this);
  }

  /** 証明の生成と保持を一回のrunへ結び付ける。 */
  public runToken(): symbol | undefined {
    return this.#run.status === "active" ? this.#run.token : undefined;
  }

  /** 同じrun、設定、revisionで有効な証明だけを返す。 */
  public proof(
    configuration: StatePersistenceConfiguration,
    revision: string,
  ): PostSaveExactProof | undefined {
    if (this.#run.status !== "active") {
      return undefined;
    }
    const proof = this.#run.proof;
    if (proof?.revision !== revision) {
      return undefined;
    }
    if (
      proof.configuration !== serializeCanonicalJson(configuration) ||
      proof.transaction.marker.runId !== this.#run.runId
    ) {
      return undefined;
    }
    return proof;
  }

  /** 初回公開済みrevisionの完全検証結果だけを保持する。 */
  public retain(proof: PostSaveExactProof): void {
    if (
      this.#run.status === "active" &&
      proof.transaction.marker.runId === this.#run.runId &&
      proof.runToken === this.#run.token
    ) {
      this.#run = { ...this.#run, proof };
      proofScopes.set(proof, this);
    }
  }

  /** 取得済みの証明が現在のrunに属しているか調べる。 */
  public isActive(proof: PostSaveExactProof): boolean {
    return this.#run.status === "active" && this.#run.proof === proof;
  }
}

const adapterScopes = new WeakMap<StateBranchAdapter, PostSaveExactProofScope>();
const proofScopes = new WeakMap<PostSaveExactProof, PostSaveExactProofScope>();

function assertActivePostSaveExactProof(proof: PostSaveExactProof): void {
  if (proofScopes.get(proof)?.isActive(proof) !== true) {
    throw new TypeError("公開済みexact revisionの証明が現在のrunに属していません");
  }
}

function fingerprint(file: StateFileReadResult): FileFingerprint {
  return file.status === "missing"
    ? Object.freeze({ status: "missing" })
    : Object.freeze({
        status: "present",
        length: file.bytes.length,
        digest: nodeContentDigestPort.sha256Bytes(file.bytes),
      });
}

function sameFingerprint(expected: FileFingerprint, actual: StateFileReadResult): boolean {
  if (expected.status !== actual.status) {
    return false;
  }
  return (
    expected.status === "missing" ||
    (actual.status === "present" &&
      expected.length === actual.bytes.length &&
      expected.digest === nodeContentDigestPort.sha256Bytes(actual.bytes))
  );
}

function listingKey(revision: string, directory: string): string {
  return JSON.stringify([revision, directory]);
}

function assertSamePaths(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
    throw new TypeError("公開済みexact revisionのstate path一覧が証明と一致しません");
  }
}

function rememberFile(
  files: Map<string, Map<string, FileFingerprint>>,
  revision: string,
  path: string,
  file: StateFileReadResult,
): void {
  let byPath = files.get(revision);
  if (byPath == null) {
    byPath = new Map();
    files.set(revision, byPath);
  }
  const next = fingerprint(file);
  const previous = byPath.get(path);
  if (
    previous != null &&
    (previous.status !== next.status ||
      (previous.status === "present" &&
        next.status === "present" &&
        (previous.length !== next.length || previous.digest !== next.digest)))
  ) {
    throw new TypeError("公開済みexact revisionの同じpathが異なるbyteを返しました");
  }
  byPath.set(path, next);
}

/** 完全検証で使用したexact読込のpathとbyte digestを記録する。 */
export function recordPostSaveExactReads(adapter: StateBranchAdapter): Readonly<{
  adapter: StateBranchAdapter;
  issue: (
    configuration: StatePersistenceConfiguration,
    revision: string,
    transaction: VerifiedRunTransactionFiles,
  ) => PostSaveExactProof;
}> {
  const runToken = adapterScopes.get(adapter)?.runToken();
  if (runToken == null) {
    throw new TypeError("公開済みexact revisionの証明には実行中のrunが必要です");
  }
  const listings = new Map<string, readonly string[]>();
  const files = new Map<string, Map<string, FileFingerprint>>();
  const commits = new Map<string, string>();
  const recording: StateBranchAdapter = Object.freeze({
    resolveHead: (branch) => adapter.resolveHead(branch),
    readFile: async (revision, path) => {
      const file = await adapter.readFile(revision, path);
      rememberFile(files, revision, path, file);
      return file;
    },
    readFiles: async (revision, paths) => {
      const result = await adapter.readFiles(revision, paths);
      if (result.size !== paths.length) {
        throw new TypeError("公開済みexact revisionのfile読込数が不足しています");
      }
      for (const path of paths) {
        const file = result.get(path);
        if (file == null) {
          throw new TypeError("公開済みexact revisionのfile読込結果が不足しています");
        }
        rememberFile(files, revision, path, file);
      }
      return result;
    },
    listFiles: async (revision, directory) => {
      const paths = await adapter.listFiles(revision, directory);
      const key = listingKey(revision, directory);
      const previous = listings.get(key);
      if (previous != null) {
        assertSamePaths(previous, paths);
      }
      listings.set(key, Object.freeze([...paths]));
      return paths;
    },
    readCommit: async (revision) => {
      const commit = await adapter.readCommit(revision);
      const digest = nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(commit));
      const previous = commits.get(revision);
      if (previous != null && previous !== digest) {
        throw new TypeError("公開済みexact revisionのcommit metadataが変化しました");
      }
      commits.set(revision, digest);
      return commit;
    },
    commit: (request) => adapter.commit(request),
    publish: (request) => adapter.publish(request),
  });
  return Object.freeze({
    adapter: recording,
    issue: (configuration, revision, transaction) => {
      if (
        transaction.snapshotSchemaVersion !== "23" ||
        transaction.marker.phase !== "initial_state_committed" ||
        !listings.has(listingKey(revision, "state")) ||
        !files.has(revision) ||
        !commits.has(revision)
      ) {
        throw new TypeError("初回公開済みexact revisionの証明入力が不足しています");
      }
      freezeTransaction(transaction);
      return Object.freeze({
        [postSaveExactProofBrand]: true,
        runToken,
        revision,
        configuration: serializeCanonicalJson(configuration),
        transaction,
        footprint: Object.freeze({ listings, files, commits }),
      } satisfies PostSaveExactProof);
    },
  });
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

/** 日次runが所有する証明scopeか調べる。 */
export function hasPostSaveExactProofScope(adapter: StateBranchAdapter): boolean {
  return adapterScopes.get(adapter)?.runToken() != null;
}

/** 同じrunと設定で保持した公開済みrevisionの証明を返す。 */
export function postSaveExactProof(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): PostSaveExactProof | undefined {
  return adapterScopes.get(adapter)?.proof(configuration, revision);
}

/** 完全検証後の初回公開済みrevisionだけを日次runへ保持する。 */
export function retainPostSaveExactProof(
  adapter: StateBranchAdapter,
  proof: PostSaveExactProof,
): void {
  adapterScopes.get(adapter)?.retain(proof);
}

/** freshなpath、byte列を完全検証時の同じexact treeへ照合する。 */
export function assertPostSaveExactTree(
  proof: PostSaveExactProof,
  paths: readonly string[],
  files: ReadonlyMap<string, StateFileReadResult>,
): void {
  assertActivePostSaveExactProof(proof);
  const expectedPaths = proof.footprint.listings.get(listingKey(proof.revision, "state"));
  const expectedFiles = proof.footprint.files.get(proof.revision);
  if (expectedPaths == null || expectedFiles == null || files.size !== paths.length) {
    throw new TypeError("公開済みexact revisionのtree証明が不足しています");
  }
  assertSamePaths(expectedPaths, paths);
  for (const path of paths) {
    const expected = expectedFiles.get(path);
    const actual = files.get(path);
    if (expected == null || actual == null || !sameFingerprint(expected, actual)) {
      throw new TypeError(`公開済みexact revisionのstate byteが証明と一致しません。対象: ${path}`);
    }
  }
}

/** chain検証に使用した全revisionの読込値をfreshなadapter応答と照合する。 */
export async function assertPostSaveExactDependencies(
  adapter: StateBranchAdapter,
  proof: PostSaveExactProof,
  currentFiles: ReadonlyMap<string, StateFileReadResult>,
  currentCommit: StateBranchCommitInspection,
): Promise<void> {
  assertActivePostSaveExactProof(proof);
  for (const [key, expected] of proof.footprint.listings) {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new TypeError("公開済みexact revisionのpath証明が不正です");
    }
    const revision: unknown = parsed[0];
    const directory: unknown = parsed[1];
    if (typeof revision !== "string" || typeof directory !== "string") {
      throw new TypeError("公開済みexact revisionのpath証明が不正です");
    }
    if (revision === proof.revision && directory === "state") {
      continue;
    }
    assertSamePaths(expected, await adapter.listFiles(revision, directory));
  }
  for (const [revision, expectedFiles] of proof.footprint.files) {
    const paths = [...expectedFiles.keys()].filter(
      (path) =>
        revision !== proof.revision ||
        expectedFiles.get(path)?.status === "missing" ||
        !currentFiles.has(path),
    );
    if (paths.length === 0) {
      continue;
    }
    const actualFiles = await adapter.readFiles(revision, paths);
    if (actualFiles.size !== paths.length) {
      throw new TypeError("公開済みexact revisionの依存file読込数が一致しません");
    }
    for (const path of paths) {
      const expected = expectedFiles.get(path);
      const actual = actualFiles.get(path);
      if (expected == null || actual == null || !sameFingerprint(expected, actual)) {
        throw new TypeError(`公開済みexact revisionの依存byteが証明と一致しません。対象: ${path}`);
      }
    }
  }
  for (const [revision, expectedDigest] of proof.footprint.commits) {
    const commit = revision === proof.revision ? currentCommit : await adapter.readCommit(revision);
    if (nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(commit)) !== expectedDigest) {
      throw new TypeError("公開済みexact revisionのcommit metadataが証明と一致しません");
    }
  }
  assertActivePostSaveExactProof(proof);
}

/** 証明済みsnapshot byteだけを同じ論理値として復元する。 */
export function parseProvenStateSnapshot(
  proof: PostSaveExactProof,
  configuration: StatePersistenceConfiguration,
  bytes: Uint8Array,
): StateSnapshot {
  assertActivePostSaveExactProof(proof);
  const expected = proof.footprint.files.get(proof.revision)?.get(configuration.snapshotPath);
  if (
    proof.configuration !== serializeCanonicalJson(configuration) ||
    expected?.status !== "present" ||
    !sameFingerprint(expected, { status: "present", bytes })
  ) {
    throw new TypeError("snapshotの設定またはbyteが公開済みexact revisionの証明と一致しません");
  }
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parse: (value: string) => StateSnapshot = JSON.parse;
  const snapshot = parse(source);
  freezeTransaction(snapshot);
  return snapshot;
}

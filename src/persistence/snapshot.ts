import { Ajv2020 } from "ajv/dist/2020.js";

import snapshotSchema from "../../schemas/snapshot.schema.json" with { type: "json" };
import { serializeCanonicalJsonLine, type Sha256Hash } from "./canonical-json.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import {
  isTerminalStatus,
  type ExternalGhostNode,
  type GitHubNodeId,
  type Relation,
  type Repository,
  type Severity,
  type TrackingStartAtState,
  type TrackedItem,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type PublicRepositoryId, type Sha256Fingerprint } from "../github/index.js";

type PublicSnapshotRepositoryFields = Repository &
  Readonly<{
    visibility: "public";
    archived: false;
    disabled: false;
  }>;

/** snapshotへ保存する公開リポジトリの最新取得状態。 */
export type SnapshotRepository =
  | (PublicSnapshotRepositoryFields &
      Readonly<{
        freshness: "fresh";
      }>)
  | (PublicSnapshotRepositoryFields &
      Readonly<{
        freshness: "stale";
        failedAt: UtcIsoDateTime;
      }>);

/** snapshotへ保存するseverity付き追跡項目。 */
export type SnapshotTrackedItem = TrackedItem &
  Readonly<{
    severity: Severity;
  }>;

/** snapshotへ保存する前回Codex分析fingerprint。 */
export type SnapshotAiAnalysisFingerprint =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      fingerprint: Readonly<{
        sourceHash: Sha256Hash;
        inputHash: Sha256Hash;
        graphNeighborhoodHash: Sha256Hash;
      }>;
    }>;

/** 次回の増分計画、terminal保持判定、Codex未変更判定へ渡す軽量な項目観測値。 */
export type SnapshotCollectionItem = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  itemFingerprint: Sha256Fingerprint;
  aiAnalysisFingerprint: SnapshotAiAnalysisFingerprint;
  observedAt: UtcIsoDateTime;
}> &
  (
    | Readonly<{
        state: "open";
        terminalAt: null;
      }>
    | Readonly<{
        state: "closed";
        terminalAt: UtcIsoDateTime;
      }>
  );

/** repository単位の最終成功時刻と項目fingerprint。 */
export type SnapshotCollectionRepository = Readonly<{
  repositoryId: PublicRepositoryId;
  successfulAt: UtcIsoDateTime;
  items: readonly SnapshotCollectionItem[];
}>;

/** 次回runへ引き継ぐ本番収集の軽量state。 */
export type SnapshotCollectionState = Readonly<{
  repositories: readonly SnapshotCollectionRepository[];
}>;

/** snapshotへ保存するAIの有効状態、利用可否、縮退状態。 */
export type SnapshotAiState =
  | Readonly<{
      enabled: false;
      available: false;
      degraded: false;
    }>
  | Readonly<{
      enabled: true;
      available: true;
      degraded: boolean;
    }>
  | Readonly<{
      enabled: true;
      available: false;
      degraded: true;
    }>;

/** 完全runだけを表すsnapshot内のrun情報。 */
export type SnapshotRun = Readonly<{
  id: string;
  status: "success" | "fallback";
  complete: true;
}>;

/** tracker-stateへ保存するschema version 1のcurrent snapshot。 */
export type StateSnapshot = Readonly<{
  schemaVersion: "1";
  generatedAt: UtcIsoDateTime;
  trackingStartAt: TrackingStartAtState;
  ai: SnapshotAiState;
  collection: SnapshotCollectionState;
  repositories: readonly SnapshotRepository[];
  items: readonly SnapshotTrackedItem[];
  externalReferences: readonly ExternalGhostNode[];
  relations: readonly Relation[];
  run: SnapshotRun;
}>;

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      return false;
    }
    return !Number.isNaN(Date.parse(value));
  },
});
const validateSnapshotSchema = ajv.compile<StateSnapshot>(snapshotSchema);

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertUnique(values: readonly string[], description: string): void {
  if (new Set(values).size !== values.length) {
    throw new StateSnapshotSemanticError(`${description}が重複しています`);
  }
}

function assertUtcDateTime(value: string, description: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new StateSnapshotSemanticError(`${description}はUTCへ正規化してください`);
  }
}

function assertSnapshotSemantics(snapshot: StateSnapshot): void {
  assertUtcDateTime(snapshot.generatedAt, "generatedAt");
  if (snapshot.trackingStartAt.status === "fixed") {
    assertUtcDateTime(snapshot.trackingStartAt.value, "trackingStartAt");
  }
  assertUnique(
    snapshot.repositories.map((repository) => repository.id),
    "repository ID",
  );
  assertUnique(
    snapshot.items.map((item) => item.nodeId),
    "item node ID",
  );
  assertUnique(
    snapshot.externalReferences.map((reference) => reference.nodeId),
    "外部参照node ID",
  );
  assertUnique(
    snapshot.relations.map((relation) => relation.id),
    "relation ID",
  );

  const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.id));
  assertUnique(
    snapshot.collection.repositories.map((repository) => repository.repositoryId),
    "収集stateのrepository ID",
  );
  const collectionItemNodeIds = snapshot.collection.repositories.flatMap((repository) =>
    repository.items.map((item) => item.nodeId),
  );
  assertUnique(collectionItemNodeIds, "収集stateのitem node ID");
  const snapshotRepositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  for (const collectionRepository of snapshot.collection.repositories) {
    const snapshotRepository = snapshotRepositoriesById.get(collectionRepository.repositoryId);
    if (snapshotRepository == null) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertUtcDateTime(collectionRepository.successfulAt, "収集stateのrepository成功時刻");
    if (collectionRepository.successfulAt !== snapshotRepository.observedAt) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepository成功時刻がsnapshotのrepository観測時刻と一致しません",
      );
    }
    for (const item of collectionRepository.items) {
      if (item.repositoryId !== collectionRepository.repositoryId) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem repositoryIdが親repositoryと一致しません",
        );
      }
      assertUtcDateTime(item.observedAt, "収集stateのitem観測時刻");
      if (item.observedAt > collectionRepository.successfulAt) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem観測時刻はrepository成功時刻以前にしてください",
        );
      }
      if (item.state === "closed") {
        assertUtcDateTime(item.terminalAt, "収集stateのterminal遷移時刻");
        if (item.terminalAt > collectionRepository.successfulAt) {
          throw new StateSnapshotSemanticError(
            "収集stateのterminal遷移時刻はrepository成功時刻以前にしてください",
          );
        }
      }
    }
  }
  for (const repository of snapshot.repositories) {
    assertUtcDateTime(repository.observedAt, "repository observedAt");
    if (repository.freshness === "stale") {
      assertUtcDateTime(repository.failedAt, "stale repository failedAt");
      if (repository.observedAt >= repository.failedAt) {
        throw new StateSnapshotSemanticError(
          "stale repositoryのobservedAtはfailedAtより前にしてください",
        );
      }
    }
    const latestRepositoryTime =
      repository.freshness === "stale" ? repository.failedAt : repository.observedAt;
    if (latestRepositoryTime > snapshot.generatedAt) {
      throw new StateSnapshotSemanticError(
        "repositoryの観測時刻はsnapshot generatedAt以前にしてください",
      );
    }
  }
  for (const item of snapshot.items) {
    if (!repositoryIds.has(item.repositoryId)) {
      throw new StateSnapshotSemanticError(
        "itemのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    if (isTerminalStatus(item.status) && item.waitingOn.length !== 0) {
      throw new StateSnapshotSemanticError("terminal itemにwaitingOnを保存できません");
    }
    if (item.waitingOn.length === 0 && item.primaryWaitingOn.index !== "not_applicable") {
      throw new StateSnapshotSemanticError("waitingOnがないitemにprimaryを保存できません");
    }
    if (item.waitingOn.length > 0 && item.primaryWaitingOn.index !== 0) {
      throw new StateSnapshotSemanticError("waitingOnがあるitemにはprimaryが必要です");
    }
    assertUnique(
      item.assignees.map((assignee) => assignee.nodeId),
      "itemのassignee node ID",
    );
    for (const dateTime of [
      item.createdAt,
      item.githubUpdatedAt,
      item.lastHumanActivityAt,
      item.lastProgressAt,
      item.statusSince,
      item.ownerSince,
      item.stallSince,
      item.observedAt,
    ]) {
      assertUtcDateTime(dateTime, "itemの日時");
    }
  }
  const graphNodeIds = new Set([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new StateSnapshotSemanticError("relationがsnapshotにないnodeを参照しています");
    }
    assertUtcDateTime(relation.firstSeenAt, "relation firstSeenAt");
    assertUtcDateTime(relation.lastConfirmedAt, "relation lastConfirmedAt");
    if (!relation.active) {
      assertUtcDateTime(relation.removedAt, "relation removedAt");
    }
  }
}

function normalizeSnapshot(snapshot: StateSnapshot): StateSnapshot {
  return Object.freeze({
    ...snapshot,
    trackingStartAt: Object.freeze({
      ...snapshot.trackingStartAt,
    }),
    ai: Object.freeze({
      ...snapshot.ai,
    }),
    collection: Object.freeze({
      repositories: Object.freeze(
        [...snapshot.collection.repositories]
          .sort((left, right) => compareStrings(left.repositoryId, right.repositoryId))
          .map((repository) =>
            Object.freeze({
              ...repository,
              items: Object.freeze(
                [...repository.items]
                  .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
                  .map((item) =>
                    Object.freeze({
                      ...item,
                      aiAnalysisFingerprint:
                        item.aiAnalysisFingerprint.status === "unavailable"
                          ? Object.freeze({
                              status: "unavailable",
                            })
                          : Object.freeze({
                              status: "available",
                              fingerprint: Object.freeze({
                                ...item.aiAnalysisFingerprint.fingerprint,
                              }),
                            }),
                    }),
                  ),
              ),
            }),
          ),
      ),
    }),
    repositories: Object.freeze(
      [...snapshot.repositories].sort((left, right) => compareStrings(left.id, right.id)),
    ),
    items: Object.freeze(
      [...snapshot.items].sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    ),
    externalReferences: Object.freeze(
      [...snapshot.externalReferences].sort((left, right) =>
        compareStrings(left.nodeId, right.nodeId),
      ),
    ),
    relations: Object.freeze(
      [...snapshot.relations].sort((left, right) => compareStrings(left.id, right.id)),
    ),
    run: Object.freeze({
      ...snapshot.run,
    }),
  });
}

/** 未検証の値をschema検証済みかつ決定論的順序のsnapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  if (!validateSnapshotSchema(value)) {
    const issueCount = validateSnapshotSchema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value);
  return normalizeSnapshot(value);
}

/** snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  return serializeCanonicalJsonLine(createStateSnapshot(snapshot));
}

/** canonical JSONからsnapshotを検証して読み取る。 */
export function parseStateSnapshot(source: string): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return createStateSnapshot(value);
  } catch (error: unknown) {
    if (error instanceof StateSnapshotSchemaError || error instanceof StateSnapshotSemanticError) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

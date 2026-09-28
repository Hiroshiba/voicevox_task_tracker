import { z } from "zod";

import {
  createAiCacheEntry,
  type AiCacheEntry,
  type AiCacheKey,
  type AiCacheReadResult,
  type AiCacheStore,
} from "../codex/cache.js";
import {
  createPersonalReminderAiCacheEntry,
  type PersonalReminderAiCacheEntry,
  type PersonalReminderAiCacheKey,
  type PersonalReminderAiCacheReadResult,
  type PersonalReminderAiCacheStore,
} from "../codex/personal-reminder-cache.js";
import type { AiCacheMigrationPlan } from "./ai-cache-migration.js";
import { createStateCommitIdentity } from "./state-commit-metadata.js";
import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import { migrateStateSnapshot } from "./snapshot-v21-migration.js";
import {
  joinStatePath,
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StateFileUpdate,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import {
  StateBranchConflictError,
  StateFormatError,
  StateHistoryError,
  StateSnapshotSemanticError,
} from "./errors.js";
import {
  appendStateHistoryNotificationEvents,
  appendStateHistoryRecord,
  createStateHistoryRecord,
  diffStateHistory,
  parseStateHistoryRecords,
  type StateHistoryDiff,
  type StateHistoryInputEvent,
  type StateHistoryNotificationEvent,
  type StateHistoryRecord,
} from "./history.js";
import {
  assertNotificationWaitingOnMatchesSnapshot,
  assertRunConsistency,
} from "./state-persistence-validation.js";
import {
  assertExistingStatePublicSafety,
  assertStatePublicSafety,
  assertStateValuesPublicSafety,
} from "./public-safety.js";
import {
  assertPersonalReminderEvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure,
  createStateSnapshot,
  serializeStateSnapshot,
  version19SnapshotFields,
  type StateSnapshot,
} from "./snapshot-v21.js";
import { readAiCacheMigrationPlan } from "./state-ai-cache-migration-plan.js";
import { cachePath, personalReminderAiCachePath } from "./state-cache-paths.js";
import { compareStateKeys as compareStrings } from "./state-key-order.js";
import { createStateLedgerUpdates, loadStateNotificationLedgers } from "./state-ledger-files.js";
import { decodeStateFile, encodeStateFile } from "./state-file-codec.js";
import { OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 } from "./operations-alert-ledger.js";
import { createPersonalReminderEvidenceSourceIndex } from "./snapshot.js";
import {
  createStateNotificationLedger,
  createStateRunReport,
  serializeStateRunReport,
  type StateNotificationLedger,
  type StateRunReport,
} from "./state-documents.js";
import { createUtcIsoDateTime, type Repository, type UtcIsoDateTime } from "../domain/index.js";
import { INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1 } from "../application/tracking-run/contracts/recovery-paths.js";
import {
  createInitialPublicationBaseState,
  type InitialPublicationBaseState,
} from "./initial-publication-base-state.js";

const HISTORY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const STATE_ROOT_DIRECTORY = "state";

/** session開始時点のsnapshot読み取り結果。 */
export type StateSnapshotReadResult =
  | Readonly<{
      status: "missing_branch";
    }>
  | Readonly<{
      status: "operations_only";
    }>
  | Readonly<{
      status: "available";
      snapshot: StateSnapshot;
    }>;

/** 一つのatomic state commitへ渡す検証済みrun成果物。 */
export type PersistStateTransactionInput = Readonly<{
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  notificationLedger: StateNotificationLedger;
  repositoryInventory: readonly Repository[];
  repositoryAllowlist: readonly Pick<Repository, "id" | "owner" | "name">[];
  knownSecrets: readonly string[];
  expectedHistoryBase: InitialPublicationBaseState["historyBase"];
  expectedPreviousInitialPagesEvidence: InitialPublicationBaseState["previousInitialPagesEvidence"];
  deletions: readonly string[];
}>;

/** state永続化sessionがcommitしたrevisionとファイル一覧。 */
export type PersistStateTransactionResult = StateBranchCommitResult &
  Readonly<{
    updatedPaths: readonly string[];
  }>;

/** 通知送信直後にledgerだけを更新する入力。 */
export type PersistNotificationLedgerInput = Readonly<{
  notificationLedger: StateNotificationLedger;
  committedAt: UtcIsoDateTime;
  knownSecrets: readonly string[];
  commitScope: "operations_alert" | "manual_resolution";
}>;

/** 通知送信結果と対応する履歴を保存する入力。 */
export type PersistNotificationDeliveryInput = Readonly<{
  snapshot: StateSnapshot;
  notificationEvents: readonly StateHistoryNotificationEvent[];
  notificationLedger: StateNotificationLedger;
  committedAt: UtcIsoDateTime;
  repositoryInventory: readonly Repository[];
  repositoryAllowlist: readonly Pick<Repository, "id" | "owner" | "name">[];
  knownSecrets: readonly string[];
}>;

/** 完全成功したrunの追跡開始時刻、通知ledger、run reportを保存する入力。 */
export type PersistRunCompletionInput = Readonly<{
  snapshot: StateSnapshot;
  notificationEvents: readonly StateHistoryNotificationEvent[];
  notificationLedger: StateNotificationLedger;
  runReport: StateRunReport;
  repositoryInventory: readonly Repository[];
  repositoryAllowlist: readonly Pick<Repository, "id" | "owner" | "name">[];
  knownSecrets: readonly string[];
}>;

type PreparedNotificationHistory = Readonly<{
  historyPath: string;
  historySource: string;
  historyRecords: readonly StateHistoryRecord[];
}>;

function createAiCacheStateFormatError(error: unknown): StateFormatError {
  if (error instanceof z.ZodError) {
    return StateFormatError.fromZodError("AI cache", error);
  }
  return new StateFormatError("AI cache", {
    cause: new TypeError("AI cache entryの検証に失敗しました", {
      cause: error,
    }),
  });
}

function createPersonalReminderAiCacheStateFormatError(error: unknown): StateFormatError {
  if (error instanceof z.ZodError) {
    return StateFormatError.fromZodError("personal reminder AI cache", error);
  }
  return new StateFormatError("personal reminder AI cache", {
    cause: new TypeError("個人催促AI cache entryの検証に失敗しました", {
      cause: error,
    }),
  });
}

/** 同じbranch revisionを読み、全成果物を一つのcommitへまとめるsession。 */
export class StatePersistenceSession {
  readonly #adapter: StateBranchAdapter;
  readonly #configuration: StatePersistenceConfiguration;
  readonly #migrationTimezone: string;
  readonly #aiCacheMigrationPlan: AiCacheMigrationPlan;
  readonly #pendingAiCacheEntries = new Map<AiCacheKey, AiCacheEntry>();
  readonly #pendingPersonalReminderAiCacheEntries = new Map<
    PersonalReminderAiCacheKey,
    PersonalReminderAiCacheEntry
  >();
  #pendingAiCacheDeletionPaths: readonly string[];
  #head: StateBranchHead;

  public readonly aiCache: AiCacheStore;
  public readonly personalReminderAiCache: PersonalReminderAiCacheStore;
  /** sessionが固定したstate branch revision。 */
  public get baseRevision(): StateBranchHead {
    return this.#head;
  }
  private constructor(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
    head: StateBranchHead,
    aiCacheMigrationPlan: AiCacheMigrationPlan,
  ) {
    this.#adapter = adapter;
    this.#configuration = Object.freeze({
      ...configuration,
    });
    this.#migrationTimezone = migrationTimezone;
    this.#head = head;
    this.#aiCacheMigrationPlan = aiCacheMigrationPlan;
    this.#pendingAiCacheDeletionPaths = aiCacheMigrationPlan.legacyCachePaths;
    this.aiCache = Object.freeze({
      read: (cacheKey) => this.#readAiCache(cacheKey),
      write: (entry) => this.#bufferAiCache(entry),
    });
    this.personalReminderAiCache = Object.freeze({
      read: (cacheKey) => this.#readPersonalReminderAiCache(cacheKey),
      write: (entry) => this.#bufferPersonalReminderAiCache(entry),
    });
  }

  /** state branchのheadを固定して新しいsessionを開始する。 */
  public static async open(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
  ): Promise<StatePersistenceSession> {
    validateStatePersistenceConfiguration(configuration);
    const head = await adapter.resolveHead(configuration.branch);
    const aiCacheMigrationPlan = await readAiCacheMigrationPlan(adapter, configuration, head);
    return new StatePersistenceSession(
      adapter,
      configuration,
      migrationTimezone,
      head,
      aiCacheMigrationPlan,
    );
  }

  /** 指定したbranch headと一致するstate sessionを開始する。 */
  public static async openAtRevision(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
    expectedRevision: string,
  ): Promise<StatePersistenceSession> {
    validateStatePersistenceConfiguration(configuration);
    const head = await adapter.resolveHead(configuration.branch);
    if (head.status !== "present" || head.revision !== expectedRevision) {
      throw new StateBranchConflictError();
    }
    const aiCacheMigrationPlan = await readAiCacheMigrationPlan(adapter, configuration, head);
    return new StatePersistenceSession(
      adapter,
      configuration,
      migrationTimezone,
      head,
      aiCacheMigrationPlan,
    );
  }

  #consumeAiCacheMigration(): void {
    this.#pendingAiCacheDeletionPaths = Object.freeze([]);
  }

  #snapshotUpdate(snapshot: StateSnapshot): StateFileUpdate {
    return Object.freeze({
      path: this.#configuration.snapshotPath,
      bytes: encodeStateFile(serializeStateSnapshot(snapshot)),
    });
  }

  /** 現在のsession headをリモートへ公開する。 */
  public async publish(): Promise<void> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("state branch", {
        cause: new TypeError("state branch作成前に公開できません"),
      });
    }
    await this.#adapter.publish({
      branch: this.#configuration.branch,
      revision: this.#head.revision,
    });
  }

  async #readFile(path: string): Promise<StateFileReadResult> {
    if (this.#head.status === "missing") {
      return Object.freeze({
        status: "missing",
      });
    }
    return this.#adapter.readFile(this.#head.revision, path);
  }

  async #readAiCache(cacheKey: AiCacheKey): Promise<AiCacheReadResult> {
    const pendingEntry = this.#pendingAiCacheEntries.get(cacheKey);
    if (pendingEntry != null) {
      return Object.freeze({
        status: "hit",
        entry: pendingEntry,
      });
    }
    const result = await this.#readFile(cachePath(this.#configuration, cacheKey));
    const source = decodeStateFile(result, "AI cache");
    if (source == null) {
      return Object.freeze({
        status: "miss",
      });
    }
    let value: unknown;
    try {
      const parseJson: (text: string) => unknown = JSON.parse;
      value = parseJson(source);
    } catch (error: unknown) {
      throw new StateFormatError("AI cache", {
        cause: new SyntaxError("JSON構文が不正です", {
          cause: error,
        }),
      });
    }
    try {
      const entry = createAiCacheEntry(value);
      if (entry.cacheKey !== cacheKey) {
        throw new TypeError("cache keyがファイル名と一致しません");
      }
      return Object.freeze({
        status: "hit",
        entry,
      });
    } catch (error: unknown) {
      throw createAiCacheStateFormatError(error);
    }
  }

  #bufferAiCache(entry: AiCacheEntry): Promise<void> {
    try {
      const validated = createAiCacheEntry(entry);
      this.#pendingAiCacheEntries.set(validated.cacheKey, validated);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(createAiCacheStateFormatError(error));
    }
  }

  async #readPersonalReminderAiCache(
    cacheKey: PersonalReminderAiCacheKey,
  ): Promise<PersonalReminderAiCacheReadResult> {
    const pendingEntry = this.#pendingPersonalReminderAiCacheEntries.get(cacheKey);
    if (pendingEntry != null) {
      return Object.freeze({
        status: "hit",
        entry: pendingEntry,
      });
    }
    const result = await this.#readFile(personalReminderAiCachePath(this.#configuration, cacheKey));
    const source = decodeStateFile(result, "personal reminder AI cache");
    if (source == null) {
      return Object.freeze({
        status: "miss",
      });
    }
    let value: unknown;
    try {
      const parseJson: (text: string) => unknown = JSON.parse;
      value = parseJson(source);
    } catch (error: unknown) {
      throw new StateFormatError("personal reminder AI cache", {
        cause: new SyntaxError("JSON構文が不正です", {
          cause: error,
        }),
      });
    }
    try {
      const entry = createPersonalReminderAiCacheEntry(value);
      if (entry.cacheKey !== cacheKey) {
        throw new TypeError("cache keyがファイル名と一致しません");
      }
      return Object.freeze({
        status: "hit",
        entry,
      });
    } catch (error: unknown) {
      throw createPersonalReminderAiCacheStateFormatError(error);
    }
  }

  #bufferPersonalReminderAiCache(entry: PersonalReminderAiCacheEntry): Promise<void> {
    try {
      const validated = createPersonalReminderAiCacheEntry(entry);
      this.#pendingPersonalReminderAiCacheEntries.set(validated.cacheKey, validated);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(createPersonalReminderAiCacheStateFormatError(error));
    }
  }

  /** session開始時点のcurrent snapshotを読み取る。 */
  public async loadSnapshot(): Promise<StateSnapshotReadResult> {
    if (this.#head.status === "missing") {
      return Object.freeze({
        status: "missing_branch",
      });
    }
    const result = await this.#adapter.readFile(
      this.#head.revision,
      this.#configuration.snapshotPath,
    );
    const source = decodeStateFile(result, "snapshot");
    if (source == null) {
      const [notificationLedger, statePaths] = await Promise.all([
        this.loadNotificationLedger(),
        this.#adapter.listFiles(this.#head.revision, STATE_ROOT_DIRECTORY),
      ]);
      if (
        notificationLedger.entries.length === 0 &&
        notificationLedger.operationsAlerts.length > 0 &&
        statePaths.every(
          (path) =>
            path === this.#configuration.notificationLedgerPath ||
            path === OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
        )
      ) {
        return Object.freeze({
          status: "operations_only",
        });
      }
      throw new StateFormatError("snapshot", {
        cause: new TypeError("既存state branchにsnapshotがありません"),
      });
    }
    return Object.freeze({
      status: "available",
      snapshot: migrateStateSnapshot(
        source,
        this.#aiCacheMigrationPlan.legacyEntriesByCacheKey,
        this.#migrationTimezone,
      ),
    });
  }

  /** session開始時点のnotification ledgerを読み取る。 */
  public async loadNotificationLedger(): Promise<StateNotificationLedger> {
    return loadStateNotificationLedgers(this.#adapter, this.#configuration, this.#head);
  }

  async #ledgerUpdates(
    ledger: StateNotificationLedger,
    scope: "tracking_run" | "operations_alert" | "manual_resolution",
  ): Promise<readonly StateFileUpdate[]> {
    return createStateLedgerUpdates(this.#adapter, this.#configuration, this.#head, ledger, scope);
  }

  async #readHistorySource(path: string): Promise<string | undefined> {
    return decodeStateFile(await this.#readFile(path), "state history");
  }

  async #loadAllHistoryRecords(): Promise<readonly StateHistoryRecord[]> {
    if (this.#head.status === "missing") {
      return Object.freeze([]);
    }
    const paths = await this.#adapter.listFiles(
      this.#head.revision,
      this.#configuration.historyDirectory,
    );
    const prefix = `${this.#configuration.historyDirectory}/`;
    const records: StateHistoryRecord[] = [];
    for (const path of [...paths].sort(compareStrings)) {
      if (!path.startsWith(prefix)) {
        throw new StateHistoryError("history directory外のパスが返されました");
      }
      const fileName = path.slice(prefix.length);
      const match = HISTORY_FILE_PATTERN.exec(fileName);
      if (match == null) {
        throw new StateHistoryError("日次履歴のファイル名が不正です");
      }
      const date = match[1];
      if (date == null) {
        throw new StateHistoryError("日次履歴のファイル名から日付を取得できません");
      }
      const source = decodeStateFile(
        await this.#adapter.readFile(this.#head.revision, path),
        "state history",
      );
      if (source == null) {
        throw new StateHistoryError("一覧にある日次履歴を読み取れません");
      }
      const fileRecords = parseStateHistoryRecords(source);
      if (fileRecords.some((record) => record.date !== date)) {
        throw new StateHistoryError("日次履歴のファイル名とrecordの日付が一致しません");
      }
      records.push(...fileRecords);
    }
    return Object.freeze(records);
  }

  /** sessionの固定revisionにある全日次履歴を読み取る。 */
  public async loadHistoryRecords(): Promise<readonly StateHistoryRecord[]> {
    return this.#loadAllHistoryRecords();
  }

  /** 固定revisionの履歴fileと移行で削除する旧cache pathを読む。 */
  public async initialPublicationBaseState(runDate: string): Promise<InitialPublicationBaseState> {
    const historyPath = joinStatePath(this.#configuration.historyDirectory, `${runDate}.jsonl`);
    const [historyFile, previousInitialPagesEvidenceFile] = await Promise.all([
      this.#readFile(historyPath),
      this.#readFile(INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1),
    ]);
    return createInitialPublicationBaseState(
      historyPath,
      historyFile,
      previousInitialPagesEvidenceFile,
      this.#pendingAiCacheDeletionPaths,
    );
  }

  /** branch上の日次履歴を再生して任意の二日間の差分を返す。 */
  public async diffHistory(fromDate: string, toDate: string): Promise<StateHistoryDiff> {
    return diffStateHistory(await this.#loadAllHistoryRecords(), fromDate, toDate);
  }

  /** 現在のprocessで検証済みとなった未永続化AI cacheを返す。 */
  public pendingAiCacheEntries(): readonly AiCacheEntry[] {
    return Object.freeze(
      [...this.#pendingAiCacheEntries.values()].sort((left, right) =>
        compareStrings(left.cacheKey, right.cacheKey),
      ),
    );
  }

  /** 現在のprocessで検証済みとなった未永続化の個人催促AI cacheを返す。 */
  public pendingPersonalReminderAiCacheEntries(): readonly PersonalReminderAiCacheEntry[] {
    return Object.freeze(
      [...this.#pendingPersonalReminderAiCacheEntries.values()].sort((left, right) =>
        compareStrings(left.cacheKey, right.cacheKey),
      ),
    );
  }

  async #prepareNotificationHistory(
    snapshot: StateSnapshot,
    runId: string,
    notificationEvents: readonly StateHistoryNotificationEvent[],
    committedAt: UtcIsoDateTime,
    context: string,
  ): Promise<PreparedNotificationHistory> {
    const historyDate = snapshot.generatedAt.slice(0, 10);
    const historyPath = joinStatePath(this.#configuration.historyDirectory, `${historyDate}.jsonl`);
    const existingHistorySource = await this.#readHistorySource(historyPath);
    if (existingHistorySource == null) {
      throw new StateHistoryError(`${context}の対象history fileを読み取れません`);
    }
    const existingHistoryRecords = parseStateHistoryRecords(existingHistorySource);
    if (existingHistoryRecords.some((record) => record.date !== historyDate)) {
      throw new StateHistoryError("日次履歴のファイル名とrecordの日付が一致しません");
    }
    const targetHistoryRecords = existingHistoryRecords.filter((record) => record.runId === runId);
    if (targetHistoryRecords.length !== 1) {
      throw new StateHistoryError(`${context}の対象history recordが一意に定まりません`);
    }
    const historySource = appendStateHistoryNotificationEvents(
      existingHistorySource,
      runId,
      notificationEvents,
    );
    const historyRecords = parseStateHistoryRecords(historySource);
    const updatedTargetHistoryRecords = historyRecords.filter((record) => record.runId === runId);
    if (updatedTargetHistoryRecords.length !== 1) {
      throw new StateHistoryError(`${context}の対象history recordが一意に定まりません`);
    }
    const targetHistoryRecord = updatedTargetHistoryRecords[0];
    if (targetHistoryRecord == null) {
      throw new StateHistoryError(`${context}の対象history recordを取得できません`);
    }
    for (const event of notificationEvents) {
      if (event.sentAt < targetHistoryRecord.recordedAt || event.sentAt > committedAt) {
        throw new StateHistoryError("通知送信時刻がrunの記録時刻範囲外です");
      }
      const item = snapshot.items.find((candidate) => candidate.nodeId === event.itemNodeId);
      if (item == null) {
        throw new StateHistoryError("通知送信eventの対象itemがsnapshotにありません");
      }
      if (
        item.repositoryId !== event.repositoryId ||
        item.type !== event.type ||
        item.displayReference !== event.displayReference ||
        item.number !== event.number ||
        item.title !== event.title ||
        item.url !== event.url
      ) {
        throw new StateHistoryError("通知送信eventとsnapshotのitem表示情報が一致しません");
      }
      assertNotificationWaitingOnMatchesSnapshot(event, snapshot, item);
    }
    return Object.freeze({
      historyPath,
      historySource,
      historyRecords,
    });
  }

  async #commitNotificationLedger(
    input: PersistNotificationLedgerInput,
  ): Promise<PersistStateTransactionResult> {
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    const snapshotResult = this.#head.status === "present" ? await this.loadSnapshot() : undefined;
    const snapshot = snapshotResult?.status === "available" ? snapshotResult.snapshot : undefined;
    if (snapshot == null) {
      assertStateValuesPublicSafety([notificationLedger], input.knownSecrets);
    } else {
      assertExistingStatePublicSafety(
        snapshot,
        await this.loadHistoryRecords(),
        notificationLedger,
        [],
        input.knownSecrets,
      );
    }
    const updates: StateFileUpdate[] = [];
    if (snapshot != null && input.commitScope === "manual_resolution") {
      updates.push(this.#snapshotUpdate(snapshot));
    }
    updates.push(...(await this.#ledgerUpdates(notificationLedger, input.commitScope)));
    updates.sort((left, right) => compareStrings(left.path, right.path));
    const commitScope =
      input.commitScope === "operations_alert" &&
      updates.some((update) => update.path === this.#configuration.notificationLedgerPath)
        ? "tracking_run"
        : input.commitScope;
    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      deletions: input.commitScope === "operations_alert" ? [] : this.#pendingAiCacheDeletionPaths,
      message: `tracker notification ledger ${input.committedAt}`,
      committedAt: input.committedAt,
      commitIdentity: createStateCommitIdentity(
        commitScope,
        undefined,
        this.#head,
        `tracker notification ledger ${input.committedAt}`,
        updates,
        input.commitScope === "operations_alert" ? [] : this.#pendingAiCacheDeletionPaths,
      ),
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    if (input.commitScope === "manual_resolution") {
      this.#consumeAiCacheMigration();
    }
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((value) => value.path)),
    });
  }

  /** 通知送信結果を既存state branchのledgerへatomic commitする。 */
  public async persistNotificationLedger(
    input: PersistNotificationLedgerInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("state branch作成前にnotification ledgerだけを保存できません"),
      });
    }
    return this.#commitNotificationLedger(input);
  }

  /** 初回運用障害の通知ledgerでstate branchを作成する。 */
  public async persistInitialOperationsNotificationLedger(
    input: PersistNotificationLedgerInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status !== "missing") {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("既存state branchを初回運用障害通知で作成できません"),
      });
    }
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    if (
      notificationLedger.entries.length !== 0 ||
      notificationLedger.operationsAlerts.length !== 1
    ) {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("初回運用障害通知のledger内容が不正です"),
      });
    }
    return this.#commitNotificationLedger({
      ...input,
      notificationLedger,
      commitScope: "operations_alert",
    });
  }

  /** 通知送信結果と履歴を同じstate branch commitへ保存する。 */
  public async persistNotificationDelivery(
    input: PersistNotificationDeliveryInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("notification delivery", {
        cause: new TypeError("state branch作成前に通知送信結果を保存できません"),
      });
    }
    const snapshot = createStateSnapshot(input.snapshot);
    assertPersonalReminderEvidenceClosure(snapshot);
    const notificationEvents = input.notificationEvents.map((event) => ({
      ...event,
      reasons: [...event.reasons],
    }));
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    const currentResult = await this.loadSnapshot();
    if (currentResult.status !== "available") {
      throw new StateFormatError("notification delivery", {
        cause: new TypeError("state branchのsnapshotを読み取れません"),
      });
    }
    if (serializeStateSnapshot(snapshot) !== serializeStateSnapshot(currentResult.snapshot)) {
      throw new StateSnapshotSemanticError("通知送信時にsnapshot内容が変化しています");
    }
    const history = await this.#prepareNotificationHistory(
      snapshot,
      snapshot.run.id,
      notificationEvents,
      input.committedAt,
      "通知送信",
    );
    assertStatePublicSafety({
      snapshot,
      repositoryInventory: input.repositoryInventory,
      repositoryAllowlist: input.repositoryAllowlist,
      additionalValues: [...history.historyRecords, notificationLedger],
      knownSecrets: input.knownSecrets,
    });
    const updates: StateFileUpdate[] = [
      this.#snapshotUpdate(snapshot),
      ...(await this.#ledgerUpdates(notificationLedger, "tracking_run")),
      {
        path: history.historyPath,
        bytes: encodeStateFile(history.historySource),
      },
    ];
    updates.sort((left, right) => compareStrings(left.path, right.path));
    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      deletions: this.#pendingAiCacheDeletionPaths,
      message: `tracker notification delivery ${snapshot.run.id}`,
      committedAt: input.committedAt,
      commitIdentity: createStateCommitIdentity(
        "tracking_run",
        snapshot.run.id,
        this.#head,
        `tracker notification delivery ${snapshot.run.id}`,
        updates,
        this.#pendingAiCacheDeletionPaths,
      ),
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    this.#consumeAiCacheMigration();
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((update) => update.path)),
    });
  }

  /** 完全成功したrunの追跡開始時刻、通知ledger、run reportをatomic commitする。 */
  public async persistRunCompletion(
    input: PersistRunCompletionInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("run completion", {
        cause: new TypeError("state branch作成前にrun完了を保存できません"),
      });
    }
    const snapshot = createStateSnapshot(input.snapshot);
    assertPersonalReminderEvidenceClosure(snapshot);
    const notificationEvents = input.notificationEvents.map((event) => ({
      ...event,
      reasons: [...event.reasons],
    }));
    const runReport = createStateRunReport(input.runReport);
    assertRunConsistency(snapshot, runReport);
    const currentResult = await this.loadSnapshot();
    if (currentResult.status !== "available") {
      throw new StateFormatError("run completion", {
        cause: new TypeError("state branchのsnapshotを読み取れません"),
      });
    }
    const snapshotUpdates: StateFileUpdate[] = [];
    if (currentResult.snapshot.trackingStartAt.status === "not_fixed") {
      if (snapshot.trackingStartAt.status !== "fixed") {
        throw new StateSnapshotSemanticError("完全成功したrunのtracking.startAtが確定していません");
      }
      const expectedCurrentSnapshot = createStateSnapshot({
        ...snapshot,
        trackingStartAt: currentResult.snapshot.trackingStartAt,
      });
      if (
        serializeStateSnapshot(expectedCurrentSnapshot) !==
        serializeStateSnapshot(currentResult.snapshot)
      ) {
        throw new StateSnapshotSemanticError(
          "run完了時にtracking.startAt以外のsnapshot内容が変化しています",
        );
      }
      snapshotUpdates.push({
        path: this.#configuration.snapshotPath,
        bytes: encodeStateFile(serializeStateSnapshot(snapshot)),
      });
    } else if (
      serializeStateSnapshot(snapshot) !== serializeStateSnapshot(currentResult.snapshot)
    ) {
      throw new StateSnapshotSemanticError(
        "run完了時にtracking.startAt以外のsnapshot内容が変化しています",
      );
    }
    if (snapshotUpdates.length === 0) {
      snapshotUpdates.push(this.#snapshotUpdate(snapshot));
    }
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    const history = await this.#prepareNotificationHistory(
      snapshot,
      runReport.runId,
      notificationEvents,
      createUtcIsoDateTime(runReport.finishedAt),
      "run完了",
    );
    assertStatePublicSafety({
      snapshot,
      repositoryInventory: input.repositoryInventory,
      repositoryAllowlist: input.repositoryAllowlist,
      additionalValues: [...history.historyRecords, notificationLedger, runReport],
      knownSecrets: input.knownSecrets,
    });
    const updates: StateFileUpdate[] = [
      ...snapshotUpdates,
      ...(await this.#ledgerUpdates(notificationLedger, "tracking_run")),
      {
        path: joinStatePath(this.#configuration.runReportsDirectory, `${runReport.date}.json`),
        bytes: encodeStateFile(serializeStateRunReport(runReport)),
      },
      {
        path: history.historyPath,
        bytes: encodeStateFile(history.historySource),
      },
    ];
    updates.sort((left, right) => compareStrings(left.path, right.path));
    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      deletions: this.#pendingAiCacheDeletionPaths,
      message: `tracker run completion ${snapshot.run.id}`,
      committedAt: runReport.finishedAt,
      commitIdentity: createStateCommitIdentity(
        "tracking_run",
        snapshot.run.id,
        this.#head,
        `tracker run completion ${snapshot.run.id}`,
        updates,
        this.#pendingAiCacheDeletionPaths,
      ),
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    this.#consumeAiCacheMigration();
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((update) => update.path)),
    });
  }

  /** 全検証後にsnapshot・履歴・cache・ledgerをatomic commitする。 */
  public async persist(
    input: PersistStateTransactionInput,
  ): Promise<PersistStateTransactionResult> {
    const snapshot = createStateSnapshot(input.snapshot);
    assertPersonalReminderEvidenceClosure(snapshot);
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    const runDate = snapshot.generatedAt.slice(0, 10);

    const previousResult = await this.loadSnapshot();
    const previousSnapshot =
      previousResult.status === "available" ? previousResult.snapshot : undefined;
    const expectedEvidenceBySourceId = createPersonalReminderEvidenceSourceIndex([
      ...snapshot.items.map((item) => item.evidence),
      ...snapshot.relations.map((relation) => relation.evidence),
      ...(previousSnapshot?.items.map((item) => item.evidence) ?? []),
      ...(previousSnapshot?.relations.map((relation) => relation.evidence) ?? []),
    ]);
    assertPersonalReminderEvidenceRecordsClosure(snapshot, expectedEvidenceBySourceId);
    const historyRecord = createStateHistoryRecord(
      previousSnapshot == null ? undefined : version19SnapshotFields(previousSnapshot),
      version19SnapshotFields(snapshot),
      runDate,
      input.repositoryInventory,
      input.historyInputEvents,
    );
    const historyPath = joinStatePath(this.#configuration.historyDirectory, `${runDate}.jsonl`);
    const base = await this.initialPublicationBaseState(runDate);
    if (
      serializeCanonicalJsonLine(base.historyBase) !==
        serializeCanonicalJsonLine(input.expectedHistoryBase) ||
      serializeCanonicalJsonLine(base.previousInitialPagesEvidence) !==
        serializeCanonicalJsonLine(input.expectedPreviousInitialPagesEvidence) ||
      serializeCanonicalJsonLine(
        [
          ...base.oldCacheDeletionPaths,
          ...(base.previousInitialPagesEvidence.status === "present"
            ? [INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1]
            : []),
        ].sort(compareStrings),
      ) !== serializeCanonicalJsonLine(input.deletions)
    ) {
      throw new StateHistoryError("公開計画の履歴または削除pathが固定revisionと不一致です");
    }
    const existingHistorySource = await this.#readHistorySource(historyPath);
    const existingHistoryRecords =
      existingHistorySource == null ? [] : parseStateHistoryRecords(existingHistorySource);
    const pendingAiCacheEntries = [...this.#pendingAiCacheEntries.values()];
    const pendingPersonalReminderAiCacheEntries = [
      ...this.#pendingPersonalReminderAiCacheEntries.values(),
    ];

    assertStatePublicSafety({
      snapshot,
      repositoryInventory: input.repositoryInventory,
      repositoryAllowlist: input.repositoryAllowlist,
      additionalValues: [
        ...existingHistoryRecords,
        historyRecord,
        ...pendingAiCacheEntries,
        ...pendingPersonalReminderAiCacheEntries,
        notificationLedger,
      ],
      knownSecrets: input.knownSecrets,
    });

    const historySource = appendStateHistoryRecord(existingHistorySource, historyRecord);
    const updates: StateFileUpdate[] = [
      {
        path: this.#configuration.snapshotPath,
        bytes: encodeStateFile(serializeStateSnapshot(snapshot)),
      },
      {
        path: historyPath,
        bytes: encodeStateFile(historySource),
      },
      ...(await this.#ledgerUpdates(notificationLedger, "tracking_run")),
      ...pendingAiCacheEntries.map((entry) => ({
        path: cachePath(this.#configuration, entry.cacheKey),
        bytes: encodeStateFile(serializeCanonicalJsonLine(entry)),
      })),
      ...pendingPersonalReminderAiCacheEntries.map((entry) => ({
        path: personalReminderAiCachePath(this.#configuration, entry.cacheKey),
        bytes: encodeStateFile(serializeCanonicalJsonLine(entry)),
      })),
    ];
    updates.sort((left, right) => compareStrings(left.path, right.path));

    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      deletions: input.deletions,
      message: `tracker state ${runDate} ${snapshot.run.id}`,
      committedAt: snapshot.generatedAt,
      commitIdentity: createStateCommitIdentity(
        "tracking_run",
        snapshot.run.id,
        this.#head,
        `tracker state ${runDate} ${snapshot.run.id}`,
        updates,
        input.deletions,
      ),
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    this.#consumeAiCacheMigration();
    this.#pendingAiCacheEntries.clear();
    this.#pendingPersonalReminderAiCacheEntries.clear();
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((update) => update.path)),
    });
  }
}

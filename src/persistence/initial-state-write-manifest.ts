import { serializeCanonicalJson } from "../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import {
  initialStateWriteManifestSchema,
  type InitialStateWriteManifest,
} from "../publication/durable-record-schema.js";
import type { StateChangedPathManifest } from "./state-commit-metadata.js";
import type {
  StateFileReadResult,
  StateFileUpdate,
  StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { parseStateHistoryRecords } from "./history.js";
import type { StateHistoryRecord } from "./history-contracts.js";

type WrittenFile = InitialStateWriteManifest["aiCache"][number];

function fileAt(
  files: ReadonlyMap<string, StateFileReadResult>,
  path: string,
): StateFileReadResult {
  const file = files.get(path);
  if (file == null) {
    throw new TypeError(`初回write manifestのstate file読込が不足しています。対象: ${path}`);
  }
  return file;
}

function writtenFile(path: string, bytes: Uint8Array, before: StateFileReadResult): WrittenFile {
  const afterDigest = digest.sha256Bytes(bytes);
  if (before.status === "missing") {
    return { path, operation: "created", afterDigest };
  }
  const beforeDigest = digest.sha256Bytes(before.bytes);
  return {
    path,
    operation: beforeDigest === afterDigest ? "unchanged" : "modified",
    beforeDigest,
    afterDigest,
  };
}

function sortedFiles(
  updates: readonly StateFileUpdate[],
  before: ReadonlyMap<string, StateFileReadResult>,
): readonly WrittenFile[] {
  return updates
    .map((update) => writtenFile(update.path, update.bytes, fileAt(before, update.path)))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

/** 親treeと完成byteから初回履歴、cache、削除のmanifestを作る。 */
export function createInitialStateWriteManifest(
  history: StateFileUpdate,
  historyRecord: StateHistoryRecord,
  aiCache: readonly StateFileUpdate[],
  personalReminderAiCache: readonly StateFileUpdate[],
  deletionPaths: readonly string[],
  before: ReadonlyMap<string, StateFileReadResult>,
): InitialStateWriteManifest {
  const value = {
    history: {
      file: writtenFile(history.path, history.bytes, fileAt(before, history.path)),
      recordDigest: digest.sha256Utf8(serializeCanonicalJson(historyRecord)),
    },
    aiCache: sortedFiles(aiCache, before),
    personalReminderAiCache: sortedFiles(personalReminderAiCache, before),
    deletions: deletionPaths
      .map((path) => {
        const prior = fileAt(before, path);
        if (prior.status !== "present") {
          throw new TypeError(`初回write manifestの削除対象が親treeにありません。対象: ${path}`);
        }
        return { path, beforeDigest: digest.sha256Bytes(prior.bytes) };
      })
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  return initialStateWriteManifestSchema.parse(value);
}

function changedEntry(file: WrittenFile): StateChangedPathManifest["entries"][number] | undefined {
  if (file.operation === "unchanged") {
    return undefined;
  }
  if (file.operation === "created") {
    return { path: file.path, kind: "created", afterDigest: file.afterDigest };
  }
  return {
    path: file.path,
    kind: "modified",
    beforeDigest: file.beforeDigest,
    afterDigest: file.afterDigest,
  };
}

/** 保存済みmanifestを親tree、現tree、Git差分manifestへ照合する。 */
export function assertInitialStateWriteManifest(
  manifest: InitialStateWriteManifest,
  configuration: StatePersistenceConfiguration,
  expectedHistoryPath: string,
  runId: string,
  before: ReadonlyMap<string, StateFileReadResult>,
  after: ReadonlyMap<string, StateFileReadResult>,
  changed: StateChangedPathManifest,
): void {
  const historyPath = manifest.history.file.path;
  const cacheFiles = [...manifest.aiCache, ...manifest.personalReminderAiCache];
  if (
    historyPath !== expectedHistoryPath ||
    manifest.aiCache.some((file) => !file.path.startsWith(`${configuration.aiCacheDirectory}/`)) ||
    manifest.personalReminderAiCache.some(
      (file) => !file.path.startsWith(`${configuration.personalReminderAiCacheDirectory}/`),
    )
  ) {
    throw new TypeError("初回write manifestの保存先がstate設定と一致しません");
  }
  const historyAfter = fileAt(after, historyPath);
  if (historyAfter.status !== "present") {
    throw new TypeError("初回write manifestの完成履歴fileがありません");
  }
  const historyRecords = parseStateHistoryRecords(
    new TextDecoder("utf-8", { fatal: true }).decode(historyAfter.bytes),
  );
  const historyRecord = historyRecords.at(-1);
  if (historyRecord?.runId !== runId) {
    throw new TypeError("初回write manifestの履歴recordとrunが一致しません");
  }
  const expected = createInitialStateWriteManifest(
    { path: historyPath, bytes: historyAfter.bytes },
    historyRecord,
    manifest.aiCache.map((file) => {
      const current = fileAt(after, file.path);
      if (current.status !== "present") {
        throw new TypeError("初回write manifestの完成AI cacheがありません");
      }
      return { path: file.path, bytes: current.bytes };
    }),
    manifest.personalReminderAiCache.map((file) => {
      const current = fileAt(after, file.path);
      if (current.status !== "present") {
        throw new TypeError("初回write manifestの完成個人催促AI cacheがありません");
      }
      return { path: file.path, bytes: current.bytes };
    }),
    manifest.deletions.map((entry) => entry.path),
    before,
  );
  if (serializeCanonicalJson(expected) !== serializeCanonicalJson(manifest)) {
    throw new TypeError("初回write manifestの完成byteと親treeが一致しません");
  }
  for (const deletion of manifest.deletions) {
    if (fileAt(after, deletion.path).status !== "missing") {
      throw new TypeError("初回write manifestの削除対象が現treeに残っています");
    }
  }
  const expectedChanged = [manifest.history.file, ...cacheFiles].flatMap((file) => {
    const entry = changedEntry(file);
    return entry == null ? [] : [entry];
  });
  expectedChanged.push(
    ...manifest.deletions.map((entry) => ({
      path: entry.path,
      kind: "deleted" as const,
      beforeDigest: entry.beforeDigest,
    })),
  );
  expectedChanged.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const actualChanged = changed.entries.filter(
    (entry) =>
      entry.path === historyPath ||
      entry.path.startsWith(`${configuration.aiCacheDirectory}/`) ||
      entry.path.startsWith(`${configuration.personalReminderAiCacheDirectory}/`) ||
      manifest.deletions.some((deletion) => deletion.path === entry.path),
  );
  if (serializeCanonicalJson(expectedChanged) !== serializeCanonicalJson(actualChanged)) {
    throw new TypeError("初回write manifestとGit commitの変更全件が一致しません");
  }
}

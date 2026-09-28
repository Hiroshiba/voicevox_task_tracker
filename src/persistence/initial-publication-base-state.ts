import { createHash } from "node:crypto";

import { parseSha256Hash, type Sha256Hash } from "../canonical-json/index.js";
import type { StateFileReadResult } from "./branch-adapter.js";

/** 初回公開commitが固定revisionへ照合する履歴と旧cache削除対象。 */
export type InitialPublicationBaseState = Readonly<{
  historyPath: string;
  historyBase: InitialPublicationFileState;
  previousInitialPagesEvidence: InitialPublicationFileState;
  oldCacheDeletionPaths: readonly string[];
}>;

/** 固定revisionにある公開関連fileの有無とbyte digest。 */
export type InitialPublicationFileState =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "present"; digest: Sha256Hash }>;

function fileState(file: StateFileReadResult): InitialPublicationFileState {
  return file.status === "missing"
    ? Object.freeze({ status: "missing" })
    : Object.freeze({
        status: "present",
        digest: parseSha256Hash(`sha256:${createHash("sha256").update(file.bytes).digest("hex")}`),
      });
}

/** 固定revisionの履歴fileと移行で削除する旧cache pathを正規化する。 */
export function createInitialPublicationBaseState(
  historyPath: string,
  historyFile: StateFileReadResult,
  previousInitialPagesEvidenceFile: StateFileReadResult,
  oldCacheDeletionPaths: readonly string[],
): InitialPublicationBaseState {
  return Object.freeze({
    historyPath,
    historyBase: fileState(historyFile),
    previousInitialPagesEvidence: fileState(previousInitialPagesEvidenceFile),
    oldCacheDeletionPaths: Object.freeze([...oldCacheDeletionPaths].sort()),
  });
}

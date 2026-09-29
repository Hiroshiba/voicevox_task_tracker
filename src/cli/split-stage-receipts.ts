import { readFile } from "node:fs/promises";

import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { verifyReceiptChain } from "../application/tracking-run/receipt-chain.js";
import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
  type ReceiptChainEntry,
  type ReceiptChainEvidence,
} from "../application/tracking-run/receipt-chain-schema.js";
import type { Receipt } from "../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import { observeStateCommitAtRevision } from "../infrastructure/tracking-run/state-receipt-observation.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "../persistence/index.js";
import { readNotificationMessageState } from "./notification-message-state.js";

/** run別receipt chainをcanonical形式で再読込する。 */
export async function readSplitReceiptChain(
  path: string,
  runId: string,
): Promise<readonly ReceiptChainEntry[]> {
  const source = await readFile(path, "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("分割runのreceipt chainがcanonical JSONではありません");
  }
  const envelope = receiptChainEnvelopeSchema.parse(raw);
  const verified = verifyReceiptChain(envelope.entries, nodeContentDigestPort);
  if (
    verified.receipts.some(
      (receipt) => receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== runId,
    )
  ) {
    throw new TypeError("分割runのreceipt chainとrun IDが一致しません");
  }
  return envelope.entries;
}

/** receipt chainを同じ共有schemaで保存する。 */
export async function writeSplitReceiptChain(
  path: string,
  entries: readonly ReceiptChainEntry[],
  writeJsonArtifact: (path: string, value: unknown) => Promise<void>,
): Promise<void> {
  verifyReceiptChain(entries, nodeContentDigestPort);
  await writeJsonArtifact(
    path,
    receiptChainEnvelopeSchema.parse({
      schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION,
      entries,
    }),
  );
}

/** 直前receiptを保持して新しい段階のreceiptを連結する。 */
export function appendSplitReceipts(
  prior: readonly ReceiptChainEntry[],
  additions: readonly ReceiptChainEntry[],
  runId: string,
): readonly ReceiptChainEntry[] {
  if (additions.length === 0) {
    throw new TypeError("分割run段階の成功receiptがありません");
  }
  const entries = Object.freeze([...prior, ...additions]);
  const verified = verifyReceiptChain(entries, nodeContentDigestPort);
  if (
    verified.receipts.some(
      (receipt) => receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== runId,
    )
  ) {
    throw new TypeError("分割runの追加receiptとrun IDが一致しません");
  }
  return entries;
}

/** exact stateに結び付いた再観測receiptの証拠を取り出す。 */
export async function stateCommitEvidenceForSplitReceipt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  receipt: Receipt,
  initialStateRevision: string,
): Promise<ReceiptChainEvidence> {
  if (receipt.receiptKind !== "observed") {
    return { kind: "none" };
  }
  if (
    receipt.receiptType !== "initial_state_commit" &&
    receipt.receiptType !== "notification_settlement" &&
    receipt.receiptType !== "run_finalization"
  ) {
    throw new TypeError("state commit以外のreceiptへcommit証拠を要求できません");
  }
  const observed = await observeStateCommitAtRevision(
    adapter,
    configuration,
    receipt.result.resultingStateRevision,
    initialStateRevision,
    receipt.receiptType,
    {
      invocationId: receipt.invocationId,
      observedAt: receipt.observedAt,
      position:
        receipt.previousReceiptDigest == null
          ? { kind: "first" }
          : {
              kind: "after",
              previousReceiptDigest: receipt.previousReceiptDigest,
              previousPhaseSequence: receipt.phaseSequence - 1,
            },
    },
  );
  return { kind: "state_commit", state: observed.evidence };
}

/** 保存済みPages証拠とexact markerから再観測receiptを裏付ける。 */
export async function initialPagesEvidenceForSplitReceipt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  receipt: Receipt,
): Promise<ReceiptChainEvidence> {
  if (receipt.receiptKind !== "observed") {
    return { kind: "none" };
  }
  if (
    receipt.receiptType !== "pages_deployment" ||
    receipt.phase !== "initial" ||
    typeof receipt.expectedStateRevision !== "string"
  ) {
    throw new TypeError("初回Pagesの再観測receiptが不正です");
  }
  const state = await readNotificationMessageState(
    adapter,
    configuration,
    receipt.expectedStateRevision,
  );
  const marker = state.transaction.marker;
  const evidence = state.transaction.initialPagesEvidence;
  if (marker.phase === "initial_state_committed" || evidence == null) {
    throw new TypeError("初回Pagesの保存済みstate証拠がありません");
  }
  return {
    kind: "initial_pages_state",
    state: {
      exactStateRevision: receipt.expectedStateRevision,
      marker: {
        runId: marker.runId,
        checkpointDigest: marker.checkpointDigest,
        phase: marker.phase,
        initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
        initialStateRevision: marker.initialStateRevision,
      },
      evidence,
    },
  };
}

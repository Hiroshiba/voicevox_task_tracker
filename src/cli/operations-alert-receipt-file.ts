import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PublicFailureArtifact } from "../application/tracking-run/failure-artifact.js";
import { decodeReceipt } from "../application/tracking-run/receipt-codec.js";
import type { OperationsAlertReceipt } from "../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import { decodeOperationsAlertReceiptForIncident } from "./operations-alert-receipt.js";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readReceipt(
  path: string,
  artifact: PublicFailureArtifact,
  incidentId: string,
): Promise<OperationsAlertReceipt | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  const decoded = decodeReceipt(bytes, nodeContentDigestPort);
  if (decoded.receiptType !== "operations_alert") {
    throw new TypeError("以前の運用障害通知receiptの種別が不正です");
  }
  if (decoded.result.incidentId !== incidentId) {
    return undefined;
  }
  return decodeOperationsAlertReceiptForIncident(bytes, artifact, incidentId);
}

/** 同じworkflow runの既存receiptを検証してincidentごとに読む。 */
export async function readPriorOperationsAlertReceipts(
  outputPath: string,
  directory: string,
  workflowRunId: string,
  artifact: PublicFailureArtifact,
  incidentId: string,
): Promise<readonly OperationsAlertReceipt[]> {
  const receipts: OperationsAlertReceipt[] = [];
  const local = await readReceipt(outputPath, artifact, incidentId);
  if (local != null) {
    receipts.push(local);
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return Object.freeze(receipts);
    }
    throw error;
  }
  const prefix = `operations-alert-receipt-${workflowRunId}-`;
  for (const name of names.sort()) {
    if (!name.startsWith(prefix)) {
      throw new TypeError("以前の運用障害通知receiptのartifact名が不正です");
    }
    const receipt = await readReceipt(
      join(directory, name, "operations-alert-receipt.json"),
      artifact,
      incidentId,
    );
    if (
      receipt != null &&
      !receipts.some((entry) => entry.receiptDigest === receipt.receiptDigest)
    ) {
      receipts.push(receipt);
    }
  }
  return Object.freeze(receipts);
}

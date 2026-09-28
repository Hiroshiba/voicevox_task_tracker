import { z } from "zod";

import { initialPagesEvidenceStateSchema } from "./initial-pages-evidence.js";
import { stateCommitReceiptEvidenceSchema } from "./observed-state-commit.js";
import { receiptSchema } from "./receipt-schema.js";

export const RECEIPT_CHAIN_SCHEMA_VERSION = 2;

export const receiptChainEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("initial_pages_state"),
    state: initialPagesEvidenceStateSchema,
  }),
  z.strictObject({ kind: z.literal("state_commit"), state: stateCommitReceiptEvidenceSchema }),
]);

export const receiptChainEntrySchema = z.strictObject({
  receipt: receiptSchema,
  evidence: receiptChainEvidenceSchema,
});

export const receiptChainEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(RECEIPT_CHAIN_SCHEMA_VERSION),
  entries: z.array(receiptChainEntrySchema).min(1),
});

/** receiptごとの観測証拠。 */
export type ReceiptChainEvidence = z.output<typeof receiptChainEvidenceSchema>;

/** receiptと一対一に対応する観測証拠。 */
export type ReceiptChainEntry = z.output<typeof receiptChainEntrySchema>;

/** 常設検証CLIのversion付き入力。 */
export type ReceiptChainEnvelope = z.output<typeof receiptChainEnvelopeSchema>;

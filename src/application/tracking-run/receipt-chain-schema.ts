import { z } from "zod";
import { notificationDeliveryAttemptSchema } from "../../domain/notification-delivery-attempt.js";

import { initialPagesEvidenceStateSchema } from "./initial-pages-evidence.js";
import { stateCommitReceiptEvidenceSchema } from "./observed-state-commit.js";
import { receiptSchema } from "./receipt-schema.js";

export const RECEIPT_CHAIN_SCHEMA_VERSION = 3;

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const operationIdSchema = z.string().regex(/^operation:v1:[0-9a-f]{64}$/u);
const messageCommitEvidenceSchema = z.strictObject({
  revision: revisionSchema,
  parentRevision: revisionSchema,
  commitOperationId: operationIdSchema,
  markerPhaseSequence: z.number().int().positive(),
  notificationLedgerDigest: sha256Schema,
});

export const notificationMessageStateEvidenceSchema = z.strictObject({
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  checkpointDigest: sha256Schema,
  publicationRecordDigest: sha256Schema,
  initialStateRevision: revisionSchema,
  initialPagesPublicationEvidenceDigest: sha256Schema,
  deliveryId: z.string().min(1),
  attempt: notificationDeliveryAttemptSchema,
  reservation: messageCommitEvidenceSchema,
  result: messageCommitEvidenceSchema.optional(),
});

/** Git祖先とexact stateで裏付けた一messageの送達結果。 */
export type NotificationMessageStateEvidence = z.output<
  typeof notificationMessageStateEvidenceSchema
>;

export const receiptChainEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("initial_pages_state"),
    state: initialPagesEvidenceStateSchema,
  }),
  z.strictObject({ kind: z.literal("state_commit"), state: stateCommitReceiptEvidenceSchema }),
  z.strictObject({
    kind: z.literal("notification_message_state"),
    state: notificationMessageStateEvidenceSchema,
  }),
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

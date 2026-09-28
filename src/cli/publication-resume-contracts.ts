import { z } from "zod";

import { initialPagesPublicationEvidenceSchema } from "../application/tracking-run/initial-pages-evidence.js";
import { receiptSchema } from "../application/tracking-run/receipt-schema.js";
import { durablePublicationRecordSchema } from "./durable-record-schema.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const exactStateViewSchema = z.strictObject({
  revision: revisionSchema,
  snapshotDigest: sha256Schema,
  normalNotificationLedgerDigest: sha256Schema,
  marker: z.strictObject({
    runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
    checkpointDigest: sha256Schema,
    publicationRecordDigest: sha256Schema,
    phase: z.enum([
      "initial_state_committed",
      "notifications_in_progress",
      "notifications_settled",
      "run_finalized",
    ]),
    phaseSequence: z.number().int().positive(),
    initialStateRevision: revisionSchema.optional(),
    initialPagesPublicationEvidenceDigest: sha256Schema.optional(),
  }),
});

const resumeBase = {
  record: durablePublicationRecordSchema,
  state: exactStateViewSchema,
  expectedRevision: revisionSchema,
};

export const resumeInitialPagesBuildInputSchema = z.strictObject({
  ...resumeBase,
  initialStateCommitReceipt: receiptSchema.options[0],
});
export const resumeInitialPagesDeployInputSchema = z.strictObject({
  ...resumeBase,
  initialStateCommitReceipt: receiptSchema.options[0],
  initialPagesBuildReceipt: receiptSchema.options[1],
});
export const resumeNotificationsInputSchema = z.strictObject({
  ...resumeBase,
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("deployment_receipt"),
      initialPagesDeploymentReceipt: receiptSchema.options[2],
    }),
    z.strictObject({
      kind: z.literal("state_evidence"),
      initialPagesEvidence: initialPagesPublicationEvidenceSchema,
      invocationId: z.uuid(),
      localAttemptIndex: z.number().int().nonnegative(),
      phaseSequence: z.number().int().positive(),
      previousReceiptDigest: sha256Schema,
      observedAt: z.iso.datetime({ offset: true }),
    }),
  ]),
});
export const resumeFinalizationInputSchema = z.strictObject({
  ...resumeBase,
  notificationSettlementReceipt: receiptSchema.options[4],
});
export const resumeNotificationHistoryBuildInputSchema = z.strictObject({
  ...resumeBase,
  runFinalizationReceipt: receiptSchema.options[7],
});
export const resumeNotificationHistoryDeployInputSchema = z.strictObject({
  ...resumeBase,
  runFinalizationReceipt: receiptSchema.options[7],
  notificationHistoryPagesBuildReceipt: receiptSchema.options[1],
});

/** 再開時のexact revision、marker、保存内容digest。 */
export type ExactPublicationStateView = z.output<typeof exactStateViewSchema>;

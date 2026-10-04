import { z } from "zod";

export const performanceDetailEventSchema = z.strictObject({
  step: z.enum([
    "checkpoint_payload_created",
    "checkpoint_encoded",
    "checkpoint_decoded",
    "checkpoint_base_snapshot_read",
    "checkpoint_base_ledger_read",
    "checkpoint_bound",
    "closure_current_complete",
    "closure_prior_records_complete",
    "cas_previous_transaction_verified",
    "cas_adapter_commit_completed",
    "cas_candidate_tree_read",
    "cas_current_transaction_verified",
    "cas_commit_chain_verified",
    "cas_published",
    "receipt_tree_read",
    "receipt_commit_chain_verified",
    "receipt_created",
    "committed_tree_read",
    "committed_receipt_reobserved",
    "committed_public_safety_checked",
  ]),
  count: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export type PerformanceDetailEvent = z.output<typeof performanceDetailEventSchema>;

export type PerformanceDetailObserver = (event: PerformanceDetailEvent) => void;

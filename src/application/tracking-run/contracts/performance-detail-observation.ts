import { z } from "zod";

export const performanceDetailEventSchema = z.strictObject({
  step: z.enum([
    "checkpoint_payload_created",
    "checkpoint_encoded",
    "checkpoint_artifact_encoded",
    "checkpoint_sidecar_encoded",
    "checkpoint_frames_encoded",
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
    "notification_initial_tree_read",
    "notification_initial_receipt_reobserved",
    "notification_current_tree_verified",
    "notification_history_restored",
    "notification_settlement_cas_started",
    "notification_settlement_cas_completed",
    "notification_settlement_receipt_reobserved",
    "notification_finalization_ready",
    "notification_settlement_failure_classification_started",
    "notification_failure_boundary_started",
  ]),
  count: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export type PerformanceDetailEvent = z.output<typeof performanceDetailEventSchema>;

export type PerformanceDetailObserver = (event: PerformanceDetailEvent) => void;

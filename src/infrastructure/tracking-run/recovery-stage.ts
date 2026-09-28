import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { DurablePublicationRecord } from "../../cli/durable-record-schema.js";
import type {
  Receipt,
  PagesBuildReceipt,
  PagesDeploymentReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence.js";
import type { RunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import { observeInitialPagesDeployment } from "../../application/tracking-run/receipt-codec.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type { ContentDigestPort } from "../../application/tracking-run/ports.js";
import type { StateNotificationLedger } from "../../persistence/state-documents.js";

type RecoveryStageBase = Readonly<{
  record: DurablePublicationRecord;
  marker: RunTransactionMarker;
  exactStateRevision: string;
  initialStateRevision: string;
  receiptChain: readonly Receipt[];
}>;

/** exact stateとreceiptから次の副作用段階へ渡す入力。 */
export type RecoveryStageInput =
  | (RecoveryStageBase & Readonly<{ stage: "initial_pages_build" }>)
  | (RecoveryStageBase &
      Readonly<{ stage: "initial_pages_deploy"; buildReceipt: PagesBuildReceipt }>)
  | (RecoveryStageBase &
      Readonly<{
        stage: "notifications";
        source:
          | Readonly<{ kind: "deployment_receipt"; receipt: PagesDeploymentReceipt }>
          | Readonly<{
              kind: "state_evidence";
              evidence: InitialPagesPublicationEvidence;
              observedReceipt: PagesDeploymentReceipt;
            }>;
        notificationLedger: StateNotificationLedger;
      }>)
  | (RecoveryStageBase &
      Readonly<{ stage: "run_finalization"; notificationLedger: StateNotificationLedger }>)
  | (RecoveryStageBase & Readonly<{ stage: "notification_history_build" }>)
  | (RecoveryStageBase &
      Readonly<{ stage: "notification_history_deploy"; buildReceipt: PagesBuildReceipt }>)
  | (RecoveryStageBase & Readonly<{ stage: "completed" }>);

function latestPagesBuildReceipt(
  receipts: readonly Receipt[],
  phase: "initial" | "notification_history",
): PagesBuildReceipt | undefined {
  for (const receipt of [...receipts].reverse()) {
    if (receipt.receiptType === "pages_build" && receipt.phase === phase) {
      return receipt;
    }
  }
  return undefined;
}

function latestPagesDeploymentReceipt(
  receipts: readonly Receipt[],
  phase: "initial" | "notification_history",
): PagesDeploymentReceipt | undefined {
  for (const receipt of [...receipts].reverse()) {
    if (receipt.receiptType === "pages_deployment" && receipt.phase === phase) {
      return receipt;
    }
  }
  return undefined;
}

function assertNotificationReceiptsUnambiguous(receipts: readonly Receipt[]): void {
  if (
    receipts.some(
      (receipt) =>
        receipt.effectCertainty === "ambiguous" && receipt.receiptType === "notification_message",
    )
  ) {
    throw new TypeError("Discord結果が曖昧な通知を自動再開できません");
  }
}

function selectedNotificationKeys(record: DurablePublicationRecord): ReadonlySet<string> {
  if (
    record.notificationOutbox.action !== "send" ||
    record.notificationOutbox.selectedContext.action !== "create_digest"
  ) {
    return new Set<string>();
  }
  return new Set(
    record.notificationOutbox.selectedContext.candidates.flatMap((candidate) =>
      candidate.reasons.map((reason) => reason.notificationKey),
    ),
  );
}

/** 保存済みphaseと確定効果から次の一段階だけを選ぶ。 */
export function selectRecoveryStage(
  base: RecoveryStageBase,
  notificationLedger: StateNotificationLedger,
  evidence: InitialPagesPublicationEvidence | undefined,
  observation: Readonly<{ invocationId: string; observedAt: string }>,
  digest: ContentDigestPort,
): RecoveryStageInput {
  const { marker, record, receiptChain } = base;
  if (notificationLedger.entries.some((entry) => entry.status === "delivery_started")) {
    throw new TypeError("配送開始済みの通知は外部結果の手動解決が必要です");
  }
  assertNotificationReceiptsUnambiguous(receiptChain);
  if (marker.phase === "initial_state_committed") {
    const deployed = latestPagesDeploymentReceipt(receiptChain, "initial");
    if (deployed?.effectCertainty === "ambiguous") {
      throw new TypeError("初回Pages公開結果が曖昧です");
    }
    if (deployed?.receiptKind === "superseded") {
      throw new TypeError("新しいrunによって初回Pages公開が無効化されています");
    }
    if (deployed?.effectCertainty === "committed" && deployed.result != null) {
      return Object.freeze({
        ...base,
        stage: "notifications",
        source: Object.freeze({ kind: "deployment_receipt", receipt: deployed }),
        notificationLedger,
      });
    }
    const built = latestPagesBuildReceipt(receiptChain, "initial");
    if (built?.status === "built" && built.result != null) {
      return Object.freeze({ ...base, stage: "initial_pages_deploy", buildReceipt: built });
    }
    return Object.freeze({ ...base, stage: "initial_pages_build" });
  }
  if (evidence?.evidenceDigest !== marker.initialPagesPublicationEvidenceDigest) {
    throw new TypeError("通知段階のPages保存証拠が一致しません");
  }
  if (marker.phase === "notifications_in_progress") {
    const runtimeIdentityDigest = digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity));
    const stateEvidence = {
      exactStateRevision: base.exactStateRevision,
      marker: {
        runId: marker.runId,
        checkpointDigest: marker.checkpointDigest,
        phase: marker.phase,
        initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
        initialStateRevision: marker.initialStateRevision,
      },
      evidence,
    };
    const lastReceipt = receiptChain.at(-1);
    const observedReceipt = observeInitialPagesDeployment(
      {
        state: stateEvidence,
        binding: {
          bindingKind: "checkpoint",
          runId: record.runIdentity.runId,
          checkpointDigest: record.checkpointDigest,
          checkpointFileDigest: record.checkpointFileDigest,
          runtimeIdentityDigest,
        },
        invocationId: observation.invocationId,
        localAttemptIndex: 0,
        phaseSequence:
          lastReceipt == null ? marker.phaseSequence + 1 : lastReceipt.phaseSequence + 1,
        previousReceiptDigest: lastReceipt?.receiptDigest ?? evidence.deploymentReceiptDigest,
        observedAt: observation.observedAt,
      },
      digest,
    );
    verifyReceiptChain([observedReceipt], digest, {
      kind: "initial_pages_state",
      state: stateEvidence,
    });
    return Object.freeze({
      ...base,
      stage: "notifications",
      source: Object.freeze({ kind: "state_evidence", evidence, observedReceipt }),
      notificationLedger,
    });
  }
  if (marker.phase === "notifications_settled") {
    return Object.freeze({ ...base, stage: "run_finalization", notificationLedger });
  }
  const selectedKeys = selectedNotificationKeys(record);
  if (
    record.notificationHistoryPagesPolicy.requirement === "not_required" ||
    !notificationLedger.entries.some(
      (entry) => selectedKeys.has(entry.notificationKey) && entry.status === "sent",
    )
  ) {
    return Object.freeze({ ...base, stage: "completed" });
  }
  const deployed = latestPagesDeploymentReceipt(receiptChain, "notification_history");
  if (deployed?.effectCertainty === "ambiguous") {
    throw new TypeError("通知履歴Pages公開結果が曖昧です");
  }
  if (deployed?.receiptKind === "superseded") {
    throw new TypeError("新しいrunによって通知履歴Pages公開が無効化されています");
  }
  if (deployed?.effectCertainty === "committed" && deployed.result != null) {
    return Object.freeze({ ...base, stage: "completed" });
  }
  const built = latestPagesBuildReceipt(receiptChain, "notification_history");
  if (built?.status === "built" && built.result != null) {
    return Object.freeze({ ...base, stage: "notification_history_deploy", buildReceipt: built });
  }
  return Object.freeze({ ...base, stage: "notification_history_build" });
}

import { resolve } from "node:path";

import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { RuntimeRecoveryInputV2 } from "../application/tracking-run/contracts/runtime-recovery-v2.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import type { StateBranchAdapter } from "../persistence/branch-adapter.js";
import { createDefaultProductionRuntimeAdapters } from "./composition-root.js";
import { writeCliJsonArtifact } from "./file-output.js";
import { resolveManualNotificationDelivery } from "./manual-resolution.js";
import { startedManualResolutionAttempt } from "./manual-resolution-state.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { classifyNotificationRecovery } from "./notification-recovery.js";
import { restoreSplitReceipts } from "./split-stage-recovery.js";
import { splitStagePaths } from "./split-stage-paths.js";

type ManualInput = Extract<RuntimeRecoveryInputV2, { operation: "resolve_manual_delivery" }>;

/** exact stateとreceiptを照合し、開始済みの一送達だけを同じrunで解決する。 */
export async function resolveExactManualDeliveryV2(
  repositoryPath: string,
  input: ManualInput,
  adapter: StateBranchAdapter,
): Promise<
  Readonly<{
    stateRevision: string;
    receiptChainDigest: string;
    manualResolutionReceiptDigest: string;
    receiptKind: "executed" | "observed";
  }>
> {
  const adapters = createDefaultProductionRuntimeAdapters();
  const config = await adapters.loadConfig(resolve(repositoryPath, input.configPath));
  if (config.state.branch !== input.stateRef) {
    throw new TypeError("V2手動解決のstate設定が固定入力と一致しません");
  }
  const state = await readNotificationMessageState(adapter, config.state, input.exactStateRevision);
  const { marker, record, initialPagesEvidence } = state.transaction;
  if (
    marker.phase !== "notifications_in_progress" ||
    marker.runId !== input.runId ||
    marker.checkpointDigest !== input.target.checkpointDigest ||
    record.recordDigest !== input.expectedRecordDigest ||
    record.runIdentity.runId !== input.runId ||
    record.checkpointDigest !== input.target.checkpointDigest ||
    digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) !==
      input.expectedRuntimeIdentityDigest ||
    serializeCanonicalJson(record.runtimeRecoveryPlan) !==
      serializeCanonicalJson(input.runtimeRecoveryPlan) ||
    state.snapshot.run.id !== input.runId ||
    initialPagesEvidence == null
  ) {
    throw new TypeError("V2手動解決のrecord、marker、snapshotまたはPages証拠が一致しません");
  }
  if (new Set(input.target.notificationKeys).size !== input.target.notificationKeys.length) {
    throw new TypeError("V2手動解決のnotification keyが重複しています");
  }
  const target = {
    runId: input.runId,
    checkpointDigest: input.target.checkpointDigest,
    deliveryId: input.target.deliveryId,
    attemptId: input.target.attemptId,
    notificationKeys: input.target.notificationKeys,
    decision: input.target.decision,
  };
  const paths = splitStagePaths(repositoryPath, input.runId);
  const entries = await restoreSplitReceipts(adapters, paths, input.runId, input.configPath, {
    adapter,
    configuration: config.state,
    headRevision: input.exactStateRevision,
    initialStateRevision: marker.initialStateRevision,
  });
  const initialReceipt = entries[0]?.receipt;
  const pagesReceipt = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
  )?.receipt;
  if (
    initialReceipt?.receiptType !== "initial_state_commit" ||
    pagesReceipt?.receiptType !== "pages_deployment" ||
    pagesReceipt.phase !== "initial"
  ) {
    throw new TypeError("V2手動解決の初回stateまたはPages receiptがありません");
  }
  const port = {
    adapter,
    configuration: config.state,
    knownSecrets: [],
    now: adapters.now,
  };
  const existing = state.ledger.entries.some(
    (entry) =>
      entry.notificationKey === target.notificationKeys[0] &&
      entry.manualResolution?.deliveryId === target.deliveryId &&
      entry.manualResolution.attemptId === target.attemptId,
  );
  if (!existing) {
    startedManualResolutionAttempt(state, target);
    const decision = await classifyNotificationRecovery(
      {
        record,
        initialStateReceipt: initialReceipt,
        pagesReceipt,
        pagesEvidence: initialPagesEvidence,
        casOutcome: "observed",
        httpOutcome: "ambiguous",
      },
      adapter,
      config.state,
    );
    if (decision.recoveryDisposition !== "manual_resolution_required") {
      throw new TypeError("V2手動解決のGit祖先と開始済み送達を検証できません");
    }
  }
  const resolved = await resolveManualNotificationDelivery(port, target);
  const decision = await classifyNotificationRecovery(
    {
      record,
      initialStateReceipt: initialReceipt,
      pagesReceipt,
      pagesEvidence: initialPagesEvidence,
      lastVerifiedReceipt: resolved.receipt,
      casOutcome: "observed",
      httpOutcome: "ambiguous",
    },
    adapter,
    config.state,
  );
  if (decision.recoveryDisposition !== "resume_from_receipt") {
    throw new TypeError("V2手動解決後のGit祖先とreceiptを検証できません");
  }
  if (resolved.receipt.receiptKind !== "executed" && resolved.receipt.receiptKind !== "observed") {
    throw new TypeError("V2手動解決receiptの観測種別が不正です");
  }
  await writeCliJsonArtifact(paths.manualResolutionReceipt, resolved.receipt);
  return {
    stateRevision: resolved.stateRevision,
    receiptChainDigest: digest.sha256Utf8(serializeCanonicalJson(entries)),
    manualResolutionReceiptDigest: resolved.receipt.receiptDigest,
    receiptKind: resolved.receipt.receiptKind,
  };
}

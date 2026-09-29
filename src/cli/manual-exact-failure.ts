import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  createFailedRun,
  createPublicFailureArtifact,
  type FailedRun,
} from "../application/tracking-run/failure-artifact.js";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import { decodeReceipt } from "../application/tracking-run/receipt-codec.js";
import type { Receipt } from "../application/tracking-run/receipt-schema.js";
import {
  readDurablePublicationRecoveryBootstrap,
  readRunTransactionMarkerRecoveryBootstrap,
} from "../application/tracking-run/recovery-bootstrap.js";
import { createDiagnosticsRecorder } from "../diagnostics/recorder.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import { GitStateBranchAdapter } from "../persistence/index.js";
import { writeCliJsonArtifact } from "./file-output.js";
import type { BootstrapFailureObservation } from "./failure-context-state.js";
import {
  readManualFinalReceiptChain,
  readManualPagesRecordEvidence,
  type ManualPagesRecordPaths,
} from "./manual-exact-evidence.js";
import type { ManualExactCommand } from "./manual-exact-runtime.js";

const execFileAsync = promisify(execFile);

type ManualExactFailureInput = Readonly<{
  runId?: string;
  checkpointDigest?: string;
  diagnosticsPath: string;
  failureDirectory: string;
  inputInvalid: boolean;
  childStarted: boolean;
  pagesRecordPaths?: ManualPagesRecordPaths;
}>;

function failedStage(command: ManualExactCommand | undefined): FailedRun["failedStage"] {
  switch (command) {
    case undefined:
      return "prepare";
    case "verify-checkpoint":
      return "checkpoint_binding";
    case "select-runtime":
      return "runtime_selection";
    case "resolve-discord-delivery":
    case "settle-notifications":
      return "notifications_settled";
    case "finalize-run":
      return "run_finalized";
    case "prepare-notification-history-pages":
      return "notification_history_pages_prepared";
    case "preflight-notification-history-deployment":
    case "record-notification-history-deployment":
      return "notification_history_pages_published";
    case "encrypt-diagnostics":
      return "workflow_effect_observation";
  }
}

function precedingReceiptPath(command: ManualExactCommand | undefined): string | undefined {
  switch (command) {
    case undefined:
    case "verify-checkpoint":
    case "select-runtime":
    case "encrypt-diagnostics":
      return undefined;
    case "resolve-discord-delivery":
      return "artifacts/workflow/initial-state-commit-receipt.json";
    case "settle-notifications":
      return "artifacts/workflow/manual-resolution-receipt.json";
    case "finalize-run":
      return "artifacts/workflow/notification-settlement-receipt.json";
    case "prepare-notification-history-pages":
    case "preflight-notification-history-deployment":
    case "record-notification-history-deployment":
      return "artifacts/workflow/run-finalization-receipt.json";
  }
}

/** 失敗観測で実証したstate revisionを返す。 */
export function revision(observation: BootstrapFailureObservation | undefined): string | undefined {
  return observation?.stateObservation.kind === "not_observed"
    ? undefined
    : observation?.stateObservation.revision;
}

/** 観測したcheckpointが手動解決対象に一致するか判定する。 */
export function isExpectedCheckpoint(
  observation: BootstrapFailureObservation | undefined,
  runId: string,
  checkpointDigest: string,
): boolean {
  return (
    observation?.evidence?.bindingKind === "checkpoint" &&
    observation.evidence.runId === runId &&
    observation.evidence.checkpointDigest === checkpointDigest &&
    observation.stateObservation.kind === "consistent_pending"
  );
}
function receiptStateRevision(receipt: Receipt): string {
  if (receipt.result != null && "resultingStateRevision" in receipt.result) {
    return receipt.result.resultingStateRevision;
  }
  throw new TypeError("旧runtimeの直前receiptに確定済みstate revisionがありません");
}

function receiptMarkerPhase(receipt: Receipt): string {
  switch (receipt.receiptType) {
    case "initial_state_commit":
      return "initial_state_committed";
    case "manual_resolution":
      return "notifications_in_progress";
    case "notification_settlement":
      return "notifications_settled";
    case "run_finalization":
      return "run_finalized";
    default:
      throw new TypeError("旧runtimeの直前receiptがstate commitではありません");
  }
}

async function precedingReceipt(
  command: ManualExactCommand | undefined,
  evidence: Extract<FailedRun["evidence"], { bindingKind: "checkpoint" }> | undefined,
  observedStateRevision: string,
): Promise<Receipt | undefined> {
  const path = precedingReceiptPath(command);
  if (path == null || evidence == null) {
    return undefined;
  }
  const receipt = decodeReceipt(await readFile(path), nodeContentDigestPort);
  if (
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== evidence.runId ||
    receipt.binding.checkpointDigest !== evidence.checkpointDigest ||
    receipt.binding.checkpointFileDigest !== evidence.checkpointFileDigest ||
    receipt.binding.runtimeIdentityDigest !== evidence.runtimeIdentityDigest
  ) {
    throw new TypeError("旧runtimeの直前receiptとcheckpoint結合が一致しません");
  }
  const receiptRevision = receiptStateRevision(receipt);
  const adapter = new GitStateBranchAdapter({
    repositoryPath: process.cwd(),
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const files = await adapter.readFiles(receiptRevision, [
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  ]);
  const markerFile = files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const recordFile = files.get(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  if (markerFile?.status !== "present" || recordFile?.status !== "present") {
    throw new TypeError("旧runtimeの直前receiptに対応するstate bootstrapがありません");
  }
  const marker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
  const record = readDurablePublicationRecoveryBootstrap(recordFile.bytes, nodeContentDigestPort);
  if (
    marker.runId !== evidence.runId ||
    marker.checkpointDigest !== evidence.checkpointDigest ||
    marker.phase !== receiptMarkerPhase(receipt) ||
    marker.publicationRecordDigest !== record.recordDigest ||
    record.checkpointFileDigest !== evidence.checkpointFileDigest ||
    record.runtimeIdentityDigest !== evidence.runtimeIdentityDigest ||
    marker.phaseSequence > receipt.phaseSequence
  ) {
    throw new TypeError("旧runtimeの直前receiptとexact stateが一致しません");
  }
  try {
    await execFileAsync("git", [
      "merge-base",
      "--is-ancestor",
      receiptRevision,
      observedStateRevision,
    ]);
  } catch (error: unknown) {
    throw new TypeError("旧runtimeの直前receiptが観測stateの祖先にありません", {
      cause: error,
    });
  }
  return receipt;
}

/** 手動workflowの未報告失敗を実証済みstateから記録する。 */
export async function reportManualExactFailure(
  command: ManualExactCommand | undefined,
  error: unknown,
  before: BootstrapFailureObservation | undefined,
  after: BootstrapFailureObservation | undefined,
  input: ManualExactFailureInput,
): Promise<void> {
  const invocationId = randomUUID();
  const matchingAfter =
    input.runId != null &&
    input.checkpointDigest != null &&
    isExpectedCheckpoint(after, input.runId, input.checkpointDigest);
  const matchingBefore =
    input.runId != null &&
    input.checkpointDigest != null &&
    isExpectedCheckpoint(before, input.runId, input.checkpointDigest);
  const observed = matchingAfter ? after : matchingBefore ? before : undefined;
  const evidence = observed?.evidence?.bindingKind === "checkpoint" ? observed.evidence : undefined;
  const bootstrapAlert =
    after?.evidence?.bindingKind === "state_bootstrap_alert" ? after : undefined;
  const encryptionFailed = command === "encrypt-diagnostics";
  const historyCommand =
    command === "prepare-notification-history-pages" ||
    command === "preflight-notification-history-deployment" ||
    command === "record-notification-history-deployment";
  let receipt: Receipt | undefined;
  let finalStateRevision: string | undefined;
  let pagesEffectCertainty: FailedRun["failedOperationEffectCertainty"] | undefined;
  let diagnosticError = error;
  if (!encryptionFailed && !historyCommand && evidence != null && bootstrapAlert == null) {
    try {
      const observedRevision = revision(observed);
      if (observedRevision == null) {
        throw new TypeError("旧runtimeの直前receiptの比較先stateがありません");
      }
      receipt = await precedingReceipt(command, evidence, observedRevision);
    } catch (receiptError: unknown) {
      diagnosticError = new AggregateError(
        [error, receiptError],
        "旧runtimeの失敗と直前receiptの検証に失敗しました",
        { cause: error },
      );
    }
  }
  if (evidence != null && bootstrapAlert == null) {
    const observedRevision = revision(observed);
    if (observedRevision == null) {
      throw new TypeError("旧runtimeの最終証拠の比較先stateがありません");
    }
    if (
      encryptionFailed ||
      (historyCommand &&
        (command !== "record-notification-history-deployment" || !input.childStarted))
    ) {
      const final = await readManualFinalReceiptChain(evidence, observedRevision);
      if (final != null) {
        finalStateRevision = final.finalStateRevision;
        receipt = final.lastReceipt;
      }
    }
    if (command === "record-notification-history-deployment" && input.childStarted) {
      if (input.pagesRecordPaths == null) {
        throw new TypeError("旧runtimeの通知履歴Pages結果の保存先がありません");
      }
      const pages = await readManualPagesRecordEvidence(
        input.pagesRecordPaths,
        evidence,
        observedRevision,
      );
      finalStateRevision = pages.finalStateRevision;
      receipt = pages.lastReceipt;
      pagesEffectCertainty = pages.certainty;
    }
  } else if (command === "record-notification-history-deployment" && input.childStarted) {
    throw new TypeError("旧runtimeの通知履歴Pages結果をcheckpointへ結び付けられません");
  }
  const recordId = encryptionFailed ? undefined : randomUUID();
  if (recordId != null) {
    const recorder = await createDiagnosticsRecorder({ path: input.diagnosticsPath });
    try {
      await recorder.append({
        event: "tracking_run.manual_exact_runtime_failed",
        details: {
          recordId,
          invocationId,
          command: command ?? null,
          beforeStateRevision: revision(before) ?? null,
          afterStateRevision: revision(after) ?? null,
        },
        error: diagnosticError,
      });
    } finally {
      await recorder.close();
    }
  }
  const stateObservation = after?.stateObservation ??
    before?.stateObservation ?? { kind: "not_observed" as const };
  const sameHead = revision(before) != null && revision(before) === revision(after);
  const readOnly =
    command === "verify-checkpoint" ||
    command === "select-runtime" ||
    command === "prepare-notification-history-pages" ||
    command === "preflight-notification-history-deployment" ||
    encryptionFailed;
  const effectCertainty: FailedRun["failedOperationEffectCertainty"] =
    pagesEffectCertainty ??
    (!input.childStarted ||
    readOnly ||
    (command === "resolve-discord-delivery" && sameHead && matchingAfter)
      ? "no_effect"
      : "ambiguous");
  const common = {
    invocationId,
    failedStage: bootstrapAlert == null ? failedStage(command) : "runtime_bootstrap",
    failedOperationEffectCertainty: effectCertainty,
    evidence: bootstrapAlert?.evidence ?? evidence ?? { bindingKind: "invocation_pre_run_alert" },
    ...(bootstrapAlert != null || evidence == null
      ? {}
      : {
          runId: evidence.runId,
          checkpointDigest: evidence.checkpointDigest,
          checkpointFileDigest: evidence.checkpointFileDigest,
        }),
    lastVerifiedReceipt: receipt,
    ...(finalStateRevision == null ? {} : { finalStateRevision }),
    stateObservation: bootstrapAlert == null ? stateObservation : bootstrapAlert.stateObservation,
  };
  let failure: FailedRun;
  if (encryptionFailed) {
    failure = createFailedRun({
      ...common,
      failureKind: "diagnostics_encryption_failure",
      failedOperationEffectCertainty: "no_effect",
      publicDiagnostics: { code: "diagnostics_encryption_failure" },
    });
  } else {
    if (recordId == null) {
      throw new TypeError("暗号化診断の記録IDがありません");
    }
    let failureKind: "invalid_input" | "unexpected" | "content_integrity";
    let publicCode: "invalid_input" | "unexpected_failure" | "invalid_record";
    if (input.inputInvalid) {
      failureKind = "invalid_input";
      publicCode = "invalid_input";
    } else if (bootstrapAlert != null) {
      failureKind = "content_integrity";
      publicCode = "invalid_record";
    } else {
      failureKind = "unexpected";
      publicCode = "unexpected_failure";
    }
    failure = createFailedRun({
      ...common,
      failureKind,
      publicDiagnostics: { code: publicCode },
      encryptedDiagnosticsRecordIds: [recordId],
    });
  }
  const artifact = createPublicFailureArtifact(failure, nodeContentDigestPort);
  await writeCliJsonArtifact(resolve(input.failureDirectory, `${invocationId}.json`), artifact);
}

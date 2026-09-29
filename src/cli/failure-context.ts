import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  DiscordOperationsPostSendError,
  DiscordWebhookDeliveryUnknownError,
} from "../discord/index.js";
import type {
  FailedRun,
  FailureStateObservation,
} from "../application/tracking-run/failure-artifact.js";
import { decodeReceipt } from "../application/tracking-run/receipt-codec.js";
import type { Receipt } from "../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import { StateBranchConflictError } from "../persistence/index.js";
import { decodeInitialPagesBuildArtifact } from "./initial-pages-build-artifact.js";
import {
  InitialPagesDeploymentFailureError,
  readInitialPagesDeploymentOutcome,
} from "./initial-pages-deployment.js";
import { PagesEffectNotStartedError } from "../application/tracking-run/pages-effect.js";
import { NotificationHistoryPagesFailureError } from "./run-publication/daily-history-pages.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "./notification-history-pages-deployment-outcome.js";
import type { CliCommand } from "./command.js";
import {
  BoundPublicationFailureError,
  OperationsAlertReceiptFailureError,
  VerifiedPendingRuntimeFailureError,
} from "./failure-context-error.js";
import { observeBootstrap } from "./failure-context-state.js";
import { stageFromCommand, stageFromReport } from "./failure-stage.js";
import {
  primaryAlertFailure,
  readWorkflowFailureArtifacts,
} from "./operations-failure-selection.js";
import { NotificationSettlementFailureError } from "./notification-settlement.js";
import {
  OperationsAlertCommitFailureError,
  OperationsAlertNoEffectError,
  OperationsAlertPendingDeliveryError,
} from "./notification-delivery-runtime.js";
import { isPublicBoundaryViolation } from "./public-boundary-error.js";
import type { CliExecutionResult } from "./application.js";
import { CliUsageError, CliWorkflowArtifactError, CliCodexAuthenticationError } from "./errors.js";
import { readSplitReceiptChain } from "./split-stage-receipts.js";
import { splitStagePaths } from "./split-stage-paths.js";

export type CliFailureContext = Readonly<{
  failedStage: FailedRun["failedStage"];
  failureKind: Exclude<FailedRun["failureKind"], "diagnostics_encryption_failure">;
  failedOperationEffectCertainty: FailedRun["failedOperationEffectCertainty"];
  evidence: FailedRun["evidence"];
  runId?: string;
  checkpointDigest?: string;
  checkpointFileDigest?: string;
  finalStateRevision?: string;
  causedByFailureArtifactDigest?: string;
  lastVerifiedReceipt: Receipt | undefined;
  stateObservation: FailureStateObservation;
  bootstrapError?: unknown;
}>;

function failureKind(error: unknown): CliFailureContext["failureKind"] {
  if (isPublicBoundaryViolation(error)) {
    return "public_boundary";
  }
  if (error instanceof BoundPublicationFailureError) {
    return failureKind(error.cause);
  }
  if (error instanceof VerifiedPendingRuntimeFailureError) {
    return error.failedStage === "workflow_effect_observation"
      ? "content_integrity"
      : "runtime_unavailable";
  }
  const operationError = error instanceof BoundPublicationFailureError ? error.cause : error;
  if (operationError instanceof StateBranchConflictError) {
    return "state_conflict";
  }
  if (error instanceof CliUsageError) {
    return "invalid_input";
  }
  if (error instanceof z.ZodError) {
    return "schema_validation";
  }
  if (error instanceof CliWorkflowArtifactError) {
    return "content_integrity";
  }
  if (error instanceof CliCodexAuthenticationError) {
    return "runtime_unavailable";
  }
  if (error instanceof NotificationSettlementFailureError) {
    return "external_effect";
  }
  if (
    error instanceof OperationsAlertCommitFailureError ||
    error instanceof OperationsAlertPendingDeliveryError ||
    error instanceof OperationsAlertNoEffectError ||
    error instanceof DiscordOperationsPostSendError ||
    error instanceof DiscordWebhookDeliveryUnknownError
  ) {
    return "external_effect";
  }
  if (error instanceof OperationsAlertReceiptFailureError) {
    return error.effectCertainty === "no_effect" ? "unexpected" : "external_effect";
  }
  return "unexpected";
}

function revisionFromReceipt(receipt: Receipt): string | undefined {
  if (receipt.result != null && "resultingStateRevision" in receipt.result) {
    return receipt.result.resultingStateRevision;
  }
  if (receipt.result != null && "sourceStateRevision" in receipt.result) {
    return receipt.result.sourceStateRevision;
  }
  return typeof receipt.expectedStateRevision === "string"
    ? receipt.expectedStateRevision
    : undefined;
}

function receiptContext(receipt: Receipt): Partial<CliFailureContext> {
  if (receipt.binding.bindingKind !== "checkpoint") {
    throw new TypeError("追跡runの直前receiptにcheckpoint結合がありません");
  }
  return {
    evidence: receipt.binding,
    runId: receipt.binding.runId,
    checkpointDigest: receipt.binding.checkpointDigest,
    checkpointFileDigest: receipt.binding.checkpointFileDigest,
    lastVerifiedReceipt: receipt,
    stateObservation: { kind: "not_observed" },
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function optionalBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function optionalReceipt(path: string): Promise<Receipt | undefined> {
  const bytes = await optionalBytes(path);
  return bytes == null ? undefined : decodeReceipt(bytes, nodeContentDigestPort);
}

async function previousReceipt(command: CliCommand | undefined): Promise<Receipt | undefined> {
  switch (command?.kind) {
    case "run-stage": {
      if (command.runId == null) {
        return undefined;
      }
      const path = splitStagePaths(process.cwd(), command.runId).receiptChain;
      try {
        const entries = await readSplitReceiptChain(path, command.runId);
        return entries.at(-1)?.receipt;
      } catch (error: unknown) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    }
    case "build-pages":
    case "preflight-pages-deployment":
    case "settle-notifications":
    case "finalize-run":
      return optionalReceipt(
        command.kind === "finalize-run"
          ? command.settlementReceiptPath
          : command.initialStateReceiptPath,
      );
    case "record-pages-deployment": {
      const bytes = await optionalBytes(command.buildArtifactPath);
      return bytes == null ? undefined : decodeInitialPagesBuildArtifact(bytes).receipt;
    }
    case "prepare-notification-history-pages":
    case "preflight-notification-history-deployment":
      return optionalReceipt(command.finalizationReceiptPath);
    case "record-notification-history-deployment": {
      const bytes = await optionalBytes(command.buildArtifactPath);
      return bytes == null ? undefined : decodeNotificationHistoryPagesBuildArtifact(bytes).receipt;
    }
    default:
      return undefined;
  }
}

function configPath(command: CliCommand | undefined): string | undefined {
  if (command?.kind === "verify-runtime-recovery") {
    return process.env["VOICEVOX_EXPECTED_RUN_ID"] == null ? undefined : "config.yml";
  }
  return command != null && "configPath" in command ? command.configPath : undefined;
}

function expectedRunId(
  command: CliCommand | undefined,
  context: Partial<CliFailureContext>,
): string | undefined {
  if (command?.kind === "resolve-discord-delivery") {
    return command.runId;
  }
  if (command?.kind === "run-stage") {
    return command.runId;
  }
  if (command?.kind === "inspect-run-state" && command.recoveryIntent.kind === "retry_run") {
    return command.recoveryIntent.runId;
  }
  if (command?.kind === "verify-checkpoint" || command?.kind === "verify-runtime-recovery") {
    return process.env["VOICEVOX_EXPECTED_RUN_ID"];
  }
  return context.runId;
}

/** commandの実結果、receipt、exact bootstrapから確認できた失敗文脈を作る。 */
export async function observeCliFailureContext(
  command: CliCommand | undefined,
  error: unknown,
  result: CliExecutionResult | undefined,
  exactStage?: FailedRun["failedStage"],
  latestReceipt?: Receipt,
): Promise<CliFailureContext> {
  const report = result != null && "result" in result ? result.result.report : undefined;
  let stage =
    exactStage ??
    (report?.status === "failure"
      ? stageFromReport(
          report.failedStage,
          result != null && "result" in result && result.result.effects.stateCommitted,
        )
      : stageFromCommand(command));
  let kind: CliFailureContext["failureKind"] = failureKind(error);
  if (report?.status === "failure") {
    kind = report.failureKind === "public_boundary" ? "public_boundary" : "unexpected";
  }
  let effectCertainty: FailedRun["failedOperationEffectCertainty"] =
    stage === "initial_state_committed" ||
    stage === "initial_pages_published" ||
    stage === "notifications_settled" ||
    stage === "run_finalized" ||
    stage === "notification_history_pages_published"
      ? "ambiguous"
      : "no_effect";
  if (
    error instanceof VerifiedPendingRuntimeFailureError &&
    error.failedStage === "workflow_effect_observation"
  ) {
    effectCertainty = "ambiguous";
  }
  if (error instanceof StateBranchConflictError) {
    effectCertainty = "no_effect";
  }
  if (error instanceof PagesEffectNotStartedError) {
    effectCertainty = "no_effect";
  }
  if (error instanceof InitialPagesDeploymentFailureError) {
    effectCertainty = error.outcome.effectCertainty;
    kind = "external_effect";
  }
  if (error instanceof NotificationHistoryPagesFailureError) {
    effectCertainty = error.outcome.failedOperationEffectCertainty;
    kind = "external_effect";
  }
  if (error instanceof CliWorkflowArtifactError && command?.kind === "daily") {
    effectCertainty = "no_effect";
  }
  if (
    error instanceof OperationsAlertCommitFailureError ||
    error instanceof OperationsAlertPendingDeliveryError ||
    error instanceof DiscordOperationsPostSendError ||
    error instanceof DiscordWebhookDeliveryUnknownError
  ) {
    effectCertainty = "ambiguous";
  }
  if (error instanceof OperationsAlertReceiptFailureError) {
    effectCertainty = error.effectCertainty;
  }
  if (
    (latestReceipt?.receiptType === "initial_state_commit" ||
      latestReceipt?.receiptType === "pages_deployment" ||
      latestReceipt?.receiptType === "notification_settlement" ||
      latestReceipt?.receiptType === "run_finalization") &&
    latestReceipt.stage === stage &&
    latestReceipt.effectCertainty === "committed"
  ) {
    effectCertainty = "committed";
  }
  let receipt = latestReceipt ?? (await previousReceipt(command));
  let finalStateRevision =
    (command?.kind === "prepare-notification-history-pages" ||
      command?.kind === "preflight-notification-history-deployment" ||
      command?.kind === "record-notification-history-deployment") &&
    receipt != null
      ? revisionFromReceipt(receipt)
      : undefined;
  if (error instanceof NotificationHistoryPagesFailureError) {
    finalStateRevision = error.outcome.sourceStateRevision;
  }
  let observedRevision: string | undefined;
  if (error instanceof NotificationSettlementFailureError) {
    const outcome = error.outcome;
    receipt =
      outcome.kind === "manual_resolution_required"
        ? outcome.receipt
        : (outcome.lastReceipt ?? receipt);
    observedRevision = outcome.stateRevision;
    if (outcome.kind === "manual_resolution_required") {
      effectCertainty = "ambiguous";
    } else if (outcome.kind === "state_unconfirmed") {
      effectCertainty = outcome.effectCertainty;
    } else {
      effectCertainty = outcome.failedOperationEffectCertainty;
    }
    kind = "external_effect";
  }
  if (command?.kind === "record-pages-deployment") {
    const bytes = await optionalBytes(command.buildArtifactPath);
    if (bytes != null) {
      const artifact = decodeInitialPagesBuildArtifact(bytes);
      const outcomeBytes = await optionalBytes(command.outcomePath);
      if (outcomeBytes != null) {
        const outcome = await readInitialPagesDeploymentOutcome(command.outcomePath, artifact);
        if (outcome.kind === "failure") {
          effectCertainty = outcome.effectCertainty;
          observedRevision = outcome.observedHeadRevision;
          receipt = outcome.receipt ?? receipt;
          kind =
            outcome.reason === "superseded_by_newer_run"
              ? "superseded_by_newer_run"
              : "external_effect";
        }
      }
    }
  }
  if (command?.kind === "record-notification-history-deployment") {
    const bytes = await optionalBytes(command.buildArtifactPath);
    if (bytes != null) {
      const artifact = decodeNotificationHistoryPagesBuildArtifact(bytes);
      const outcomeBytes = await optionalBytes(command.outcomePath);
      if (outcomeBytes != null) {
        const outcome = decodeNotificationHistoryPagesDeploymentOutcome(outcomeBytes, artifact);
        if (outcome.kind === "failure") {
          effectCertainty = outcome.failedOperationEffectCertainty;
          observedRevision = outcome.observedHeadRevision;
          finalStateRevision = outcome.sourceStateRevision;
          receipt = outcome.receipt ?? receipt;
          kind =
            outcome.reason === "superseded_by_newer_run"
              ? "superseded_by_newer_run"
              : "external_effect";
        }
      }
    }
  }
  let context: Partial<CliFailureContext> = receipt == null ? {} : receiptContext(receipt);
  if (
    report?.status === "failure" &&
    stage !== "prepare" &&
    /^tracker-run:[0-9a-f]{64}$/u.test(report.runId)
  ) {
    context = { ...context, runId: report.runId };
  }
  if (result != null && "result" in result && result.result.failureEvidence != null) {
    const evidence = result.result.failureEvidence;
    context = {
      ...context,
      evidence,
      ...(evidence.bindingKind === "run_pre_checkpoint_alert" ? { runId: evidence.runId } : {}),
    };
  }
  if (error instanceof BoundPublicationFailureError) {
    context = {
      ...context,
      evidence: { bindingKind: "checkpoint", ...error.binding },
      runId: error.binding.runId,
      checkpointDigest: error.binding.checkpointDigest,
      checkpointFileDigest: error.binding.checkpointFileDigest,
    };
  }
  if (error instanceof VerifiedPendingRuntimeFailureError) {
    context = {
      ...context,
      evidence: error.binding,
      runId: error.binding.runId,
      checkpointDigest: error.binding.checkpointDigest,
      checkpointFileDigest: error.binding.checkpointFileDigest,
    };
    stage = error.failedStage;
    kind = failureKind(error);
  }
  const path = configPath(command);
  const runId = expectedRunId(command, context);
  if (
    path != null &&
    context.evidence?.bindingKind !== "run_pre_checkpoint_alert" &&
    (runId != null || command?.kind === "inspect-run-state")
  ) {
    let bootstrap;
    try {
      bootstrap = await observeBootstrap(path, runId);
    } catch (bootstrapError: unknown) {
      context = { ...context, bootstrapError };
    }
    if (bootstrap != null) {
      if (
        bootstrap.evidence?.bindingKind === "state_bootstrap_alert" &&
        !(error instanceof VerifiedPendingRuntimeFailureError)
      ) {
        context = bootstrap;
        stage = "runtime_bootstrap";
        kind = kind === "public_boundary" ? kind : "content_integrity";
        effectCertainty = "no_effect";
        receipt = undefined;
        finalStateRevision = undefined;
      } else if (bootstrap.evidence?.bindingKind === "state_bootstrap_alert") {
        context = {
          ...context,
          stateObservation: bootstrap.stateObservation,
          bootstrapError: bootstrap.bootstrapError,
        };
      } else {
        context = { ...context, ...bootstrap };
      }
    }
  }
  let stateObservation: FailureStateObservation;
  if (observedRevision == null) {
    stateObservation = context.stateObservation ?? { kind: "not_observed" };
  } else if (
    context.stateObservation?.kind === "consistent_pending" &&
    context.stateObservation.revision === observedRevision
  ) {
    stateObservation = context.stateObservation;
  } else {
    stateObservation = { kind: "observed_head", revision: observedRevision };
  }
  if (
    isPublicBoundaryViolation(error) ||
    (report?.status === "failure" && report.failureKind === "public_boundary")
  ) {
    kind = "public_boundary";
  }
  let causedByFailureArtifactDigest: string | undefined;
  if (command?.kind === "notify-operations") {
    const sourceArtifacts = await readWorkflowFailureArtifacts(resolve(command.failureDirectory));
    const source = sourceArtifacts.length === 0 ? undefined : primaryAlertFailure(sourceArtifacts);
    const outputArtifacts =
      source == null
        ? await readWorkflowFailureArtifacts(resolve(command.outputFailureDirectory))
        : [];
    const primary =
      source ?? (outputArtifacts.length === 0 ? undefined : primaryAlertFailure(outputArtifacts));
    causedByFailureArtifactDigest = primary?.failureArtifactDigest;
  }
  return {
    failedStage: stage,
    failureKind: kind,
    failedOperationEffectCertainty: effectCertainty,
    evidence: context.evidence ?? { bindingKind: "invocation_pre_run_alert" },
    ...(context.runId == null ? {} : { runId: context.runId }),
    ...(context.checkpointDigest == null ? {} : { checkpointDigest: context.checkpointDigest }),
    ...(context.checkpointFileDigest == null
      ? {}
      : { checkpointFileDigest: context.checkpointFileDigest }),
    ...(finalStateRevision == null ? {} : { finalStateRevision }),
    ...(causedByFailureArtifactDigest == null ? {} : { causedByFailureArtifactDigest }),
    lastVerifiedReceipt: receipt,
    stateObservation,
    ...(context.bootstrapError == null ? {} : { bootstrapError: context.bootstrapError }),
  };
}

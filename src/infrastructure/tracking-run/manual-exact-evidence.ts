import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  Receipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import {
  readDurablePublicationRecoveryBootstrap,
  readRunTransactionMarkerRecoveryBootstrap,
} from "../../application/tracking-run/recovery-bootstrap.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { GitStateBranchAdapter } from "../../persistence/index.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  decodeNotificationHistoryPagesBuildArtifact,
  type NotificationHistoryPagesBuildArtifact,
} from "./notification-history-pages-build-artifact.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "./notification-history-pages-deployment-outcome.js";
import { parseNotificationHistoryPagesDeploymentPreflight } from "./notification-history-pages-deployment.js";

const execFileAsync = promisify(execFile);
const finalizationPath = "artifacts/workflow/run-finalization-receipt.json";
const historyBuildPath = "artifacts/workflow/notification-history-pages-build.json";
const historyOutcomePath = "artifacts/workflow/notification-history-pages-deployment.json";

export type ManualCheckpointEvidence = Readonly<{
  bindingKind: "checkpoint";
  runId: string;
  checkpointDigest: string;
  checkpointFileDigest: string;
  runtimeIdentityDigest: string;
}>;

export type ManualPagesRecordPaths = Readonly<{
  buildArtifactPath: string;
  preflightPath: string;
  outcomePath: string;
}>;

type FinalEvidence = Readonly<{
  receipt: RunFinalizationReceipt;
  revision: string;
  recordDigest: string;
  adapterIdentityDigest: string;
}>;

async function optionalFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** 旧record commandの開始前に結果が存在しないことを確認する。 */
export async function assertManualPagesOutcomeAbsent(path: string): Promise<void> {
  if ((await optionalFile(path)) != null) {
    throw new TypeError("旧runtimeの通知履歴Pages結果が実行前から存在します");
  }
}

async function assertAncestor(ancestor: string, revision: string): Promise<void> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, revision]);
  } catch (error: unknown) {
    throw new TypeError("旧runtimeの証拠が観測stateの祖先にありません", { cause: error });
  }
}

function assertCheckpointBinding(receipt: Receipt, evidence: ManualCheckpointEvidence): void {
  if (
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== evidence.runId ||
    receipt.binding.checkpointDigest !== evidence.checkpointDigest ||
    receipt.binding.checkpointFileDigest !== evidence.checkpointFileDigest ||
    receipt.binding.runtimeIdentityDigest !== evidence.runtimeIdentityDigest
  ) {
    throw new TypeError("旧runtimeのreceiptとcheckpoint結合が一致しません");
  }
}

async function readManualFinalEvidence(
  evidence: ManualCheckpointEvidence,
  observedRevision: string,
): Promise<FinalEvidence | undefined> {
  const bytes = await optionalFile(finalizationPath);
  if (bytes == null) {
    return undefined;
  }
  const receipt = decodeReceipt(bytes, nodeContentDigestPort);
  if (receipt.receiptType !== "run_finalization") {
    throw new TypeError("旧runtimeの最終receiptの種別が一致しません");
  }
  assertCheckpointBinding(receipt, evidence);
  const revision = receipt.result.resultingStateRevision;
  const adapter = new GitStateBranchAdapter({
    repositoryPath: process.cwd(),
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const [files, commit] = await Promise.all([
    adapter.readFiles(revision, [
      RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    ]),
    adapter.readCommit(revision),
  ]);
  const markerFile = files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const recordFile = files.get(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  if (markerFile?.status !== "present" || recordFile?.status !== "present") {
    throw new TypeError("旧runtimeの最終receiptに対応するstate bootstrapがありません");
  }
  const marker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
  const record = readDurablePublicationRecoveryBootstrap(recordFile.bytes, nodeContentDigestPort);
  if (
    marker.phase !== "run_finalized" ||
    marker.runId !== evidence.runId ||
    marker.checkpointDigest !== evidence.checkpointDigest ||
    marker.publicationRecordDigest !== record.recordDigest ||
    record.checkpointFileDigest !== evidence.checkpointFileDigest ||
    record.runtimeIdentityDigest !== evidence.runtimeIdentityDigest ||
    receipt.result.commitScope !== "tracking_run" ||
    receipt.result.commitRunId !== evidence.runId ||
    receipt.result.commitOperationId !== commit.metadata.operationId ||
    receipt.result.changedPathManifestDigest !== commit.metadata.changedPathManifestDigest ||
    receipt.result.actualParentStateRevision !==
      (commit.parent.status === "present" ? commit.parent.revision : "unborn") ||
    commit.metadata.commitScope !== "tracking_run" ||
    commit.metadata.runId !== evidence.runId ||
    !commit.changedPathManifest.entries.some(
      (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    )
  ) {
    throw new TypeError("旧runtimeの最終receiptとexact Git stateが一致しません");
  }
  await assertAncestor(revision, observedRevision);
  const plan = record.runtimeRecoveryPlan;
  if (plan.kind === "not_reproducible") {
    throw new TypeError("旧runtimeの最終recordに復旧可能な実行計画がありません");
  }
  return {
    receipt,
    revision,
    recordDigest: record.recordDigest,
    adapterIdentityDigest: plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
  };
}

async function historyBuild(
  final: FinalEvidence,
  evidence: ManualCheckpointEvidence,
): Promise<NotificationHistoryPagesBuildArtifact | undefined> {
  const bytes = await optionalFile(historyBuildPath);
  if (bytes == null) {
    return undefined;
  }
  const artifact = decodeNotificationHistoryPagesBuildArtifact(bytes);
  assertCheckpointBinding(artifact.receipt, evidence);
  if (
    artifact.sourceStateRevision !== final.revision ||
    artifact.receipt.previousReceiptDigest !== final.receipt.receiptDigest ||
    artifact.receipt.phaseSequence !== final.receipt.phaseSequence + 1 ||
    serializeCanonicalJson(artifact.receipt.binding) !==
      serializeCanonicalJson(final.receipt.binding) ||
    (artifact.status === "built" && artifact.intent.recordDigest !== final.recordDigest)
  ) {
    throw new TypeError("旧runtimeの通知履歴Pages buildが最終stateと一致しません");
  }
  return artifact;
}

/** 最終stateから履歴Pagesまで検証できた最後のreceiptを返す。 */
export async function readManualFinalReceiptChain(
  evidence: ManualCheckpointEvidence,
  observedRevision: string,
): Promise<Readonly<{ finalStateRevision: string; lastReceipt: Receipt }> | undefined> {
  const final = await readManualFinalEvidence(evidence, observedRevision);
  if (final == null) {
    return undefined;
  }
  let lastReceipt: Receipt = final.receipt;
  const build = await historyBuild(final, evidence);
  const outcomeBytes = await optionalFile(historyOutcomePath);
  if (build != null) {
    lastReceipt = build.receipt;
  }
  if (outcomeBytes != null) {
    if (build == null) {
      throw new TypeError("旧runtimeの通知履歴Pages結果にbuildがありません");
    }
    const outcome = decodeNotificationHistoryPagesDeploymentOutcome(outcomeBytes, build);
    if (outcome.kind === "failure") {
      if (outcome.receipt != null) {
        lastReceipt = outcome.receipt;
      }
    } else {
      if (
        outcome.kind === "deployed" &&
        (outcome.receipt.result?.externalReference.kind !== "github_pages_actions" ||
          outcome.receipt.result.externalReference.adapterIdentityDigest !==
            final.adapterIdentityDigest)
      ) {
        throw new TypeError("旧runtimeの通知履歴Pages公開adapterが一致しません");
      }
      lastReceipt = outcome.receipt;
    }
  }
  return { finalStateRevision: final.revision, lastReceipt };
}

/** 旧recordが新規保存したPages結果を入力証拠とfinal Gitへ照合する。 */
export async function readManualPagesRecordEvidence(
  paths: ManualPagesRecordPaths,
  evidence: ManualCheckpointEvidence,
  observedRevision: string,
): Promise<
  Readonly<{
    certainty: "no_effect" | "committed" | "ambiguous";
    lastReceipt: Receipt;
    finalStateRevision: string;
  }>
> {
  const final = await readManualFinalEvidence(evidence, observedRevision);
  if (final == null) {
    throw new TypeError("旧runtimeの通知履歴Pages結果に最終receiptがありません");
  }
  const artifact = decodeNotificationHistoryPagesBuildArtifact(
    await readFile(paths.buildArtifactPath),
  );
  assertCheckpointBinding(artifact.receipt, evidence);
  if (
    artifact.sourceStateRevision !== final.revision ||
    artifact.receipt.previousReceiptDigest !== final.receipt.receiptDigest ||
    artifact.receipt.phaseSequence !== final.receipt.phaseSequence + 1 ||
    serializeCanonicalJson(artifact.receipt.binding) !==
      serializeCanonicalJson(final.receipt.binding) ||
    (artifact.status === "built" && artifact.intent.recordDigest !== final.recordDigest)
  ) {
    throw new TypeError("旧runtimeの通知履歴Pages結果と最終stateが一致しません");
  }
  const preflightBytes = await readFile(paths.preflightPath);
  const preflightSource = new TextDecoder("utf-8", { fatal: true }).decode(preflightBytes);
  const preflightRaw: unknown = JSON.parse(preflightSource);
  if (preflightSource !== serializeCanonicalJsonLine(preflightRaw)) {
    throw new TypeError("旧runtimeの通知履歴Pages preflightがcanonical JSONではありません");
  }
  const preflight = parseNotificationHistoryPagesDeploymentPreflight(preflightRaw, artifact);
  await assertAncestor(final.revision, preflight.observedHeadRevision);
  await assertAncestor(preflight.observedHeadRevision, observedRevision);
  const outcome = decodeNotificationHistoryPagesDeploymentOutcome(
    await readFile(paths.outcomePath),
    artifact,
  );
  if (
    (outcome.kind === "failure" &&
      (outcome.observedHeadRevision !== preflight.observedHeadRevision ||
        (outcome.reason === "superseded_by_newer_run") !== (preflight.kind === "superseded") ||
        (outcome.reason === "action_failed" && preflight.kind !== "ready"))) ||
    (outcome.kind === "deployed" && preflight.kind !== "ready" && preflight.kind !== "observed") ||
    (outcome.kind === "not_required" && preflight.kind !== "not_required")
  ) {
    throw new TypeError("旧runtimeの通知履歴Pages結果とpreflightが一致しません");
  }
  if (outcome.kind === "deployed") {
    if (
      outcome.receipt.result?.externalReference.kind !== "github_pages_actions" ||
      outcome.receipt.result.externalReference.adapterIdentityDigest !== final.adapterIdentityDigest
    ) {
      throw new TypeError("旧runtimeの通知履歴Pages公開adapterが一致しません");
    }
    return {
      certainty: "committed",
      lastReceipt: outcome.receipt,
      finalStateRevision: final.revision,
    };
  }
  if (outcome.kind === "not_required") {
    return {
      certainty: "no_effect",
      lastReceipt: outcome.receipt,
      finalStateRevision: final.revision,
    };
  }
  return {
    certainty: outcome.failedOperationEffectCertainty,
    lastReceipt: outcome.receipt ?? artifact.receipt,
    finalStateRevision: final.revision,
  };
}

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { z } from "zod";

import { sha256 } from "./sandbox-continuity-result.mjs";

const scenarioIds = [
  "send-clear-rejection",
  "hold",
  "acknowledge-current",
  "ambiguous-retry",
  "ambiguous-acknowledge",
];
const stageNames = [
  "bootstrap",
  "prepare",
  "checkpoint",
  "initial_state",
  "initial_pages",
  "notification",
  "settlement",
  "finalization",
  "history_pages",
  "complete",
];
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const priorSchema = z.strictObject({
  scenarioId: z.enum(scenarioIds.slice(0, 4)),
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  finalStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  coverageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

function required(name) {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function same(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertScenario(coverage, result, scenarioId, codeRevision) {
  same(coverage.scenarioId, scenarioId, "通知matrixのscenario ID");
  same(result.scenarioId, scenarioId, "通知matrixのresult scenario ID");
  same(coverage.run.codeRevision, codeRevision, "通知matrixのcode revision");
  same(coverage.run.actionsRunId, result.actionsRunId, "通知matrixのActions run ID");
  same(coverage.run.actionsRunAttempt, result.actionsRunAttempt, "通知matrixのActions attempt");
  same(coverage.run.environmentId, result.environmentId, "通知matrixのenvironment ID");
  same(
    coverage.run.stateRef,
    `sandbox-state/${coverage.run.environmentId}`,
    "通知matrixのsandbox state branch",
  );
  same(
    coverage.run.invocationBaseStateRevision,
    result.baseStateRevision,
    "通知matrixのbase state revision",
  );
  same(coverage.run.trackingRunId, result.trackingRunId, "通知matrixのtracking run ID");
  same(coverage.run.finalStateRevision, result.finalStateRevision, "通知matrixのfinal revision");
  same(
    digestSchema.parse(coverage.checkpoint.checkpointDigest),
    result.checkpointDigest,
    "通知matrixのcheckpoint digest",
  );
  same(
    digestSchema.parse(coverage.checkpoint.checkpointFileDigest),
    result.checkpointFileDigest,
    "通知matrixのcheckpoint file digest",
  );
  same(
    digestSchema.parse(coverage.state.publicationRecordDigest),
    result.publicationRecordDigest,
    "通知matrixのrecord digest",
  );
  same(
    digestSchema.parse(coverage.receiptChain.digest),
    result.receiptChainDigest,
    "通知matrixのreceipt chain digest",
  );
  same(
    digestSchema.parse(coverage.state.markerDigest),
    result.markerDigest,
    "通知matrixのmarker digest",
  );
  z.array(revisionSchema).min(3).parse(coverage.state.stateCommitRevisions);
  if (
    coverage.unexecutedStages.length !== 0 ||
    coverage.stages.length !== stageNames.length ||
    coverage.stages.some(
      (stage, index) => stage.stage !== stageNames[index] || stage.executed !== true,
    ) ||
    coverage.notification.selectedCandidateCount === 0 ||
    coverage.productionAdapters.pagesDeployExecuted !== false ||
    coverage.productionAdapters.discordSendExecuted !== false ||
    result.productionPagesDeployed !== false ||
    result.productionDiscordSent !== false
  ) {
    throw new TypeError("通知matrixのstage、候補またはproduction隔離が不正です");
  }
  const branches = coverage.notification.branchCounts;
  switch (scenarioId) {
    case "send-clear-rejection":
      if (branches.recordedClearRejection < 1) {
        throw new TypeError("通知matrixにclear rejectionがありません");
      }
      break;
    case "hold":
      same(branches.hold, 1, "通知matrixのhold回数");
      break;
    case "acknowledge-current":
      same(branches.acknowledgeCurrent, 1, "通知matrixのacknowledge-current回数");
      break;
    case "ambiguous-retry":
      if (
        branches.recordedAmbiguous !== 1 ||
        branches.manualRetry !== 1 ||
        branches.recordedSuccess < 1 ||
        coverage.completedResolutionProof?.originalOperationReservationCommitCount !== 1
      ) {
        throw new TypeError("通知matrixにambiguous retryと成功結果がありません");
      }
      break;
    case "ambiguous-acknowledge":
      if (
        branches.recordedAmbiguous !== 1 ||
        branches.manualAcknowledge !== 1 ||
        coverage.completedResolutionProof?.originalOperationReservationCommitCount !== 1
      ) {
        throw new TypeError("通知matrixにambiguous acknowledgeがありません");
      }
      break;
    default:
      throw new TypeError("通知matrixのscenario IDが不正です");
  }
}

function main() {
  const control = readJson(required("SANDBOX_CONTROL_PATH"));
  const prior = z.array(priorSchema).length(4).parse(control.notificationPrior);
  const codeRevision = required("GITHUB_SHA");
  const priorRoot = required("SANDBOX_PRIOR_ROOT");
  const entries = [];
  for (const [index, reference] of prior.entries()) {
    same(reference.scenarioId, scenarioIds[index], "通知matrixのscenario順");
    const directory = join(priorRoot, reference.scenarioId);
    const coverageBytes = readFileSync(join(directory, "sandbox-coverage.json"));
    same(sha256(coverageBytes), reference.coverageDigest, "通知matrixの先行coverage digest");
    const coverage = JSON.parse(coverageBytes.toString("utf8"));
    const result = readJson(join(directory, "sandbox-result.json"));
    same(result.coverageDigest, reference.coverageDigest, "通知matrixの先行result digest");
    same(result.actionsRunId, reference.actionsRunId, "通知matrixの先行Actions run ID");
    same(result.actionsRunAttempt, reference.actionsRunAttempt, "通知matrixの先行Actions attempt");
    same(result.environmentId, reference.environmentId, "通知matrixの先行environment ID");
    same(result.finalStateRevision, reference.finalStateRevision, "通知matrixの先行final revision");
    assertScenario(coverage, result, reference.scenarioId, codeRevision);
    entries.push({ reference, coverage });
  }
  const currentBytes = readFileSync(required("SANDBOX_CURRENT_COVERAGE_PATH"));
  const current = JSON.parse(currentBytes.toString("utf8"));
  const currentResult = readJson(required("SANDBOX_CURRENT_RESULT_PATH"));
  assertScenario(current, currentResult, "ambiguous-acknowledge", codeRevision);
  same(currentResult.coverageDigest, sha256(currentBytes), "通知matrixの最終coverage digest");
  same(currentResult.actionsRunId, required("GITHUB_RUN_ID"), "通知matrixの最終Actions run ID");
  const environmentIds = [...prior.map((entry) => entry.environmentId), current.run.environmentId];
  if (new Set(environmentIds).size !== 5) {
    throw new TypeError("通知matrixのsandbox branchがscenarioごとに分離されていません");
  }
  const coverages = [...entries.map((entry) => entry.coverage), current];
  const branchCounts = {
    recordedSuccess: 0,
    recordedClearRejection: 0,
    recordedAmbiguous: 0,
    hold: 0,
    acknowledgeCurrent: 0,
    manualRetry: 0,
    manualAcknowledge: 0,
  };
  for (const coverage of coverages) {
    for (const branch of Object.keys(branchCounts)) {
      branchCounts[branch] += coverage.notification.branchCounts[branch];
    }
  }
  const matrix = {
    schemaVersion: 1,
    scenarioIds,
    results: coverages.map((coverage) => ({
      scenarioId: coverage.scenarioId,
      actionsRunId: coverage.run.actionsRunId,
      actionsRunAttempt: coverage.run.actionsRunAttempt,
      environmentId: coverage.run.environmentId,
      stateRef: coverage.run.stateRef,
      trackingRunId: coverage.run.trackingRunId,
      baseStateRevision: coverage.run.originalBaseStateRevision,
      finalStateRevision: coverage.run.finalStateRevision,
      selectedCandidateCount: coverage.notification.selectedCandidateCount,
      stages: coverage.stages,
      unexecutedStages: coverage.unexecutedStages,
      checkpoint: coverage.checkpoint,
      publicationRecordDigest: coverage.state.publicationRecordDigest,
      receiptChainDigest: coverage.receiptChain.digest,
      markerDigest: coverage.state.markerDigest,
      stateCommitRevisions: coverage.state.stateCommitRevisions,
      notificationHistoryPagesStatus: coverage.pages.notificationHistory.status,
      coverageDigest:
        coverage.scenarioId === "ambiguous-acknowledge"
          ? sha256(currentBytes)
          : prior.find((entry) => entry.scenarioId === coverage.scenarioId).coverageDigest,
      manualResolutionDecision: coverage.notification.manualResolutionDecision,
      originalDeliveryOperationId: coverage.notification.originalDeliveryOperationId,
      originalOperationReservationCommitCount:
        coverage.notification.originalOperationReservationCommitCount,
    })),
    branchCounts,
    productionAdapters: { pagesDeployExecuted: false, discordSendExecuted: false },
    allCanonicalStagesExecuted: true,
    allSandboxBranchesIsolated: true,
  };
  writeFileSync(required("SANDBOX_MATRIX_OUTPUT_PATH"), `${JSON.stringify(matrix)}\n`);
}

main();

import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";

import { parseDurablePublicationRecord } from "../../dist/publication/durable-record-schema.js";
import {
  publicationArtifactSchema,
  publicationArtifactSidecarSchema,
} from "../../dist/infrastructure/tracking-run/publication-checkpoint-schema.js";
import { nodeContentDigestPort } from "../../dist/infrastructure/tracking-run/content-digest.js";
import { trackingRunStageNames } from "../../dist/application/tracking-run/contracts/closed-values.js";

import { sha256 } from "./sandbox-continuity-result.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

/** remote exact stateの実行記録を正本とし、残るcheckpoint artifactを照合する。 */
export function readSandboxCheckpointEvidence(recordValue, checkpointPath, sidecarPath) {
  const record = parseDurablePublicationRecord(recordValue, nodeContentDigestPort);
  if (record.schemaVersion === 2) {
    return { kind: "legacy_without_analysis_proof", record };
  }
  if (record.schemaVersion !== 3) {
    throw new TypeError("V1永続recordからsandbox coverageを作成できません");
  }
  const analysis = record.analysisStageRecord;
  const checkpointExists = existsSync(checkpointPath);
  const sidecarExists = existsSync(sidecarPath);
  if (checkpointExists !== sidecarExists) {
    throw new TypeError("checkpoint artifactとsidecarの片方だけがあります");
  }
  if (!checkpointExists) {
    return { kind: "remote_exact_state", record, analysis };
  }
  const bytes = readFileSync(checkpointPath);
  const source = bytes.toString("utf8");
  const raw = JSON.parse(source);
  same(source, `${canonicalJson(raw)}\n`, "checkpoint canonical bytes");
  const checkpoint = publicationArtifactSchema.parse(raw);
  const sidecarSource = readFileSync(sidecarPath, "utf8");
  const sidecarRaw = JSON.parse(sidecarSource);
  same(sidecarSource, `${canonicalJson(sidecarRaw)}\n`, "checkpoint sidecar canonical bytes");
  const sidecar = publicationArtifactSidecarSchema.parse(sidecarRaw);
  const { checkpointDigest, ...envelope } = checkpoint;
  same(checkpointDigest, sha256(Buffer.from(canonicalJson(envelope))), "checkpoint content digest");
  same(sha256(bytes), sidecar.checkpointFileDigest, "checkpoint file digest");
  same(bytes.length, sidecar.byteLength, "checkpoint byteLength");
  same(sidecar.artifactFileName, "validated-run.json", "checkpoint file name");
  same(checkpointDigest, record.checkpointDigest, "永続record checkpoint digest");
  same(
    sidecar.checkpointFileDigest,
    record.checkpointFileDigest,
    "永続record checkpoint file digest",
  );
  same(checkpoint.payload.runIdentity.runId, analysis.runId, "解析記録 run ID");
  same(
    checkpoint.payload.runIdentity.invocationId,
    analysis.invocationId,
    "解析記録 invocation ID",
  );
  same(
    canonicalJson(checkpoint.payload.baseStateRevision),
    canonicalJson(analysis.baseStateRevision),
    "解析記録 parent revision",
  );
  same(
    canonicalJson(checkpoint.payload.analysisCompletedStages),
    canonicalJson(analysis.completedStages),
    "解析段階の実行順序",
  );
  const metrics = checkpoint.payload.validatedPayload.runMetadata.metrics;
  same(
    checkpoint.payload.validatedPayload.validation.core.aiBudgetSummary.logicalCandidateCount,
    analysis.plannedLogicalCandidateCount,
    "解析候補数",
  );
  for (const key of [
    "itemCount",
    "changedItemCount",
    "aiProcessAttemptCount",
    "aiCacheHitCount",
    "aiRetainedResultCount",
    "personalReminderAiCallCount",
    "personalReminderAiCacheHitCount",
    "personalReminderAssessmentReuseCount",
    "personalReminderUnknownCount",
  ]) {
    same(metrics[key], record.runFinalizationPolicy.report.metrics[key], `解析件数 ${key}`);
  }
  return { kind: "artifact_cross_checked", record, analysis, byteLength: sidecar.byteLength };
}

/** 旧V2 runの解析段階が検証不能であることを公開reportへ示す。 */
export function unavailableLegacyStageCoverage(record, scenarioId) {
  return {
    schemaVersion: 2,
    scenarioId,
    analysisEvidenceStatus: "unavailable_legacy_v2",
    trackingRunId: record.runIdentity.runId,
    checkpointDigest: record.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    stages: trackingRunStageNames.map((stage) => ({ stage, executed: null, evidence: null })),
    unverifiedStages: [...trackingRunStageNames],
    productionAdapters: { pagesDeployExecuted: false, discordSendExecuted: false },
  };
}

import { z } from "zod";

import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  runtimeIdentitySchema,
  runtimeToolchainIdentitySchema,
} from "./contracts/runtime-identity.js";
import type { ContentDigestPort } from "./ports.js";

const MAX_BOOTSTRAP_BYTES = 8 * 1024 * 1024;
const MAX_BOOTSTRAP_DEPTH = 64;
const MAX_BOOTSTRAP_NODES = 100_000;
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const nonEmptyStringSchema = z.string().min(1).max(1000);
const positiveIntegerSchema = z.number().int().positive();
const normalizedBundlePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "bundle内の正規化された相対pathが必要です",
  );

const protocolSchema = z.strictObject({
  protocolVersion: z.literal(1),
  entrypointRelativePath: normalizedBundlePathSchema,
  entrypointSha256: sha256Schema,
  inputContract: z.literal("tracking-run-recovery-input-v1"),
  outputContract: z.literal("tracking-run-recovery-output-v1"),
  workflowEffectObservationContract: z.literal("tracking-run-workflow-effect-observation-v1"),
  workflowEffectAdapterIdentityDigest: sha256Schema,
});

const recoveryPlanSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("workflow_bundle"),
    workflowRunId: nonEmptyStringSchema,
    workflowRunAttempt: positiveIntegerSchema,
    artifactName: nonEmptyStringSchema,
    bundleSha256: sha256Schema,
    codeRevision: nonEmptyStringSchema,
    lockfileSha256: sha256Schema,
    toolchain: runtimeToolchainIdentitySchema,
    recoveryProtocol: protocolSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("rebuild_exact"),
    codeRevision: nonEmptyStringSchema,
    lockfileSha256: sha256Schema,
    toolchain: runtimeToolchainIdentitySchema,
    expectedRuntimeManifestSha256: sha256Schema,
    recoveryProtocol: protocolSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("not_reproducible"),
    reason: z.enum(["dirty_worktree", "runtime_artifact_unavailable"]),
    runtimeIdentityDigest: sha256Schema,
  }),
]);

const recordBootstrapSchema = z.looseObject({
  recoveryBootstrapVersion: z.literal(1),
  schemaVersion: positiveIntegerSchema,
  runIdentity: z.looseObject({ runId: nonEmptyStringSchema }),
  checkpointDigest: sha256Schema,
  checkpointFileDigest: sha256Schema,
  runtimeIdentity: runtimeIdentitySchema,
  runtimeRecoveryPlan: recoveryPlanSchema,
  recordDigest: sha256Schema,
});

const markerBootstrapSchema = z.looseObject({
  recoveryBootstrapVersion: z.literal(1),
  schemaVersion: positiveIntegerSchema,
  runId: nonEmptyStringSchema,
  checkpointDigest: sha256Schema,
  phase: z.enum([
    "initial_state_committed",
    "notifications_in_progress",
    "notifications_settled",
    "run_finalized",
  ]),
  phaseSequence: positiveIntegerSchema,
  publicationRecordDigest: sha256Schema,
});

/** 旧runtimeを選ぶためだけに読む永続recordの安定部分。 */
export type DurablePublicationRecoveryBootstrapV1 = Readonly<{
  recoveryBootstrapVersion: 1;
  recordSchemaVersion: number;
  runId: string;
  checkpointDigest: string;
  checkpointFileDigest: string;
  runtimeRecoveryPlan: z.output<typeof recoveryPlanSchema>;
  runtimeIdentityDigest: string;
  recordDigest: string;
}>;

/** 旧runtimeを選ぶためだけに読むtransaction markerの安定部分。 */
export type RunTransactionMarkerRecoveryBootstrapV1 = Readonly<{
  recoveryBootstrapVersion: 1;
  markerSchemaVersion: number;
  runId: string;
  checkpointDigest: string;
  phase: z.output<typeof markerBootstrapSchema>["phase"];
  phaseSequence: number;
  publicationRecordDigest: string;
}>;

function assertBounded(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) {
      throw new TypeError("bootstrap JSONの探索状態が不正です");
    }
    nodes += 1;
    if (nodes > MAX_BOOTSTRAP_NODES || current.depth > MAX_BOOTSTRAP_DEPTH) {
      throw new TypeError("bootstrap JSONが許容する大きさを超えています");
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    } else if (current.value != null && typeof current.value === "object") {
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function parseCanonicalBootstrap(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_BOOTSTRAP_BYTES) {
    throw new TypeError("bootstrap JSONが許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(source);
  assertBounded(value);
  if (source !== `${serializeCanonicalJson(value)}\n`) {
    throw new TypeError("bootstrap JSONがcanonical形式ではありません");
  }
  return value;
}

/** 永続recordのbusiness payloadを解釈せず回復用fieldを読む。 */
export function readDurablePublicationRecoveryBootstrap(
  bytes: Uint8Array,
  digest: ContentDigestPort,
): DurablePublicationRecoveryBootstrapV1 {
  const record = recordBootstrapSchema.parse(parseCanonicalBootstrap(bytes));
  const { recordDigest, ...content } = record;
  if (digest.sha256Utf8(serializeCanonicalJson(content)) !== recordDigest) {
    throw new TypeError("durable publication recordのdigestが一致しません");
  }
  const runtimeIdentityDigest = digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity));
  if (record.runtimeRecoveryPlan.kind === "workflow_bundle") {
    if (
      record.runtimeIdentity.kind !== "workflow_bundle" ||
      record.runtimeRecoveryPlan.codeRevision !== record.runtimeIdentity.codeRevision ||
      record.runtimeRecoveryPlan.bundleSha256 !== record.runtimeIdentity.bundleSha256 ||
      record.runtimeRecoveryPlan.lockfileSha256 !== record.runtimeIdentity.lockfileSha256 ||
      serializeCanonicalJson(record.runtimeRecoveryPlan.toolchain) !==
        serializeCanonicalJson(record.runtimeIdentity.toolchain)
    ) {
      throw new TypeError("workflow bundleの回復計画とruntime identityが一致しません");
    }
  }
  if (record.runtimeRecoveryPlan.kind === "rebuild_exact") {
    if (
      record.runtimeIdentity.kind !== "source_process" ||
      record.runtimeRecoveryPlan.codeRevision !== record.runtimeIdentity.codeRevision ||
      record.runtimeRecoveryPlan.expectedRuntimeManifestSha256 !==
        record.runtimeIdentity.runtimeManifestSha256 ||
      record.runtimeRecoveryPlan.lockfileSha256 !== record.runtimeIdentity.lockfileSha256 ||
      serializeCanonicalJson(record.runtimeRecoveryPlan.toolchain) !==
        serializeCanonicalJson(record.runtimeIdentity.toolchain)
    ) {
      throw new TypeError("source processの回復計画とruntime identityが一致しません");
    }
  }
  if (
    record.runtimeRecoveryPlan.kind === "not_reproducible" &&
    record.runtimeRecoveryPlan.runtimeIdentityDigest !== runtimeIdentityDigest
  ) {
    throw new TypeError("runtime identityのdigestが回復計画と一致しません");
  }
  return Object.freeze({
    recoveryBootstrapVersion: 1,
    recordSchemaVersion: record.schemaVersion,
    runId: record.runIdentity.runId,
    checkpointDigest: record.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    runtimeRecoveryPlan: record.runtimeRecoveryPlan,
    runtimeIdentityDigest,
    recordDigest,
  });
}

/** transaction markerのbusiness payloadを解釈せず回復用fieldを読む。 */
export function readRunTransactionMarkerRecoveryBootstrap(
  bytes: Uint8Array,
): RunTransactionMarkerRecoveryBootstrapV1 {
  const marker = markerBootstrapSchema.parse(parseCanonicalBootstrap(bytes));
  return Object.freeze({
    recoveryBootstrapVersion: 1,
    markerSchemaVersion: marker.schemaVersion,
    runId: marker.runId,
    checkpointDigest: marker.checkpointDigest,
    phase: marker.phase,
    phaseSequence: marker.phaseSequence,
    publicationRecordDigest: marker.publicationRecordDigest,
  });
}

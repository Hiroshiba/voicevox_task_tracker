import { z } from "zod";

import type { PreparedRun } from "../../../application/tracking-run/prepare-run.js";
import { parseSha256Hash } from "../../../canonical-json/sha256.js";
import { assertNonNullable } from "../../../util/assert-non-nullable.js";
import type { SandboxRunContext } from "../sandbox-context.js";

import { SANDBOX_FIXED_SOURCE_DATASET, SANDBOX_FIXED_SOURCE_DATASET_DIGEST } from "./dataset.js";

/** 固定source指定を受け取る環境変数。 */
export const SANDBOX_FIXED_SOURCE_DESCRIPTOR_ENV = "SANDBOX_FIXED_SOURCE_DESCRIPTOR";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .transform(parseSha256Hash);
const descriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("sandbox_fixed_source"),
  datasetDigest: digestSchema,
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  sourceRef: z.string().min(1).regex(/^\S+$/u),
  seedRevision: revisionSchema,
  codeRevision: revisionSchema,
  configDigest: digestSchema,
  workflowRunId: z.string().regex(/^[1-9][0-9]*$/u),
  workflowRunAttempt: z.number().int().positive(),
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  runSlot: z.enum(["first", "second"]),
});

/** sandbox contextと対象runへ固定sourceを結び付ける記述子。 */
export type SandboxFixedSourceDescriptor = Readonly<z.output<typeof descriptorSchema>>;

/** 固定source記述子を検証し、コード内datasetとの一致を確定する。 */
export function parseSandboxFixedSourceDescriptor(value: unknown): SandboxFixedSourceDescriptor {
  const descriptor = descriptorSchema.parse(value);
  if (descriptor.datasetDigest !== SANDBOX_FIXED_SOURCE_DATASET_DIGEST) {
    throw new TypeError("固定source記述子と合成datasetのdigestが一致しません");
  }
  return Object.freeze(descriptor);
}

/** 固定source記述子をActions環境とsandbox branchへ結び付ける。 */
export function assertSandboxFixedSourceEnvironment(
  descriptor: SandboxFixedSourceDescriptor,
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  if (
    environment["TRACKING_EFFECT_TARGET"] !== "sandbox" ||
    environment["GITHUB_REPOSITORY"] !== "Hiroshiba/voicevox_task_tracker" ||
    environment["TRACKING_STATE_REF"] !== `sandbox-state/${descriptor.environmentId}` ||
    environment["GITHUB_RUN_ID"] !== descriptor.workflowRunId ||
    environment["GITHUB_RUN_ATTEMPT"] !== descriptor.workflowRunAttempt.toString() ||
    environment["GITHUB_SHA"] !== descriptor.codeRevision
  ) {
    throw new TypeError("固定source記述子とActions実行環境が一致しません");
  }
}

function assertClosedPreviousState(prepared: PreparedRun): void {
  const previous = prepared.core.baseState.previousState.snapshot;
  if (previous.status !== "available") {
    throw new TypeError("固定sourceには4件の追跡済みseedが必要です");
  }
  const expectedIds = new Set(SANDBOX_FIXED_SOURCE_DATASET.items.map((item) => item.nodeId));
  const trackedIds = new Set(previous.trackedItems.map((item) => item.nodeId));
  const repository = previous.collectionRepositories[0];
  assertNonNullable(repository, "固定sourceの前回repository収集結果がありません");
  const collectionIds = new Set(repository.items.map((item) => item.nodeId));
  const isolatedNodeId = SANDBOX_FIXED_SOURCE_DATASET.items[3].nodeId;
  if (
    previous.trackedItems.length !== expectedIds.size ||
    trackedIds.size !== expectedIds.size ||
    [...trackedIds].some((id) => !expectedIds.has(id)) ||
    previous.trackedItems.some(
      (item) => item.repositoryId !== SANDBOX_FIXED_SOURCE_DATASET.repository.nodeId,
    ) ||
    previous.collectionRepositories.length !== 1 ||
    repository.repositoryId !== SANDBOX_FIXED_SOURCE_DATASET.repository.nodeId ||
    repository.items.length !== expectedIds.size ||
    collectionIds.size !== expectedIds.size ||
    [...collectionIds].some((id) => !expectedIds.has(id)) ||
    previous.externalReferences.length !== 0 ||
    previous.verifiedExternalReferences.length !== 0 ||
    previous.relations.some(
      (relation) =>
        !expectedIds.has(relation.fromNodeId) ||
        !expectedIds.has(relation.toNodeId) ||
        relation.fromNodeId === isolatedNodeId ||
        relation.toNodeId === isolatedNodeId,
    )
  ) {
    throw new TypeError("固定sourceの前回stateが4件の閉集合と一致しません");
  }
}

/** 固定source記述子をsandbox contextと準備済みrunへ結び付ける。 */
export function assertSandboxFixedSourceBinding(
  descriptor: SandboxFixedSourceDescriptor,
  sandboxContext: SandboxRunContext | undefined,
  prepared: PreparedRun,
): void {
  if (prepared.core.executionPolicy.effectTarget !== "sandbox" || sandboxContext == null) {
    throw new TypeError("固定sourceはsandbox実行だけに指定できます");
  }
  const times = SANDBOX_FIXED_SOURCE_DATASET.clock[descriptor.runSlot];
  if (
    descriptor.environmentId !== sandboxContext.environmentId ||
    descriptor.sourceRef !== sandboxContext.sourceRef ||
    descriptor.seedRevision !== sandboxContext.seedRevision ||
    descriptor.codeRevision !== sandboxContext.codeRevision ||
    descriptor.workflowRunId !== sandboxContext.workflowRunId ||
    descriptor.workflowRunAttempt !== sandboxContext.workflowRunAttempt ||
    descriptor.runId !== prepared.core.identity.runId ||
    descriptor.configDigest !== prepared.core.configDigest ||
    prepared.core.config.organization !== SANDBOX_FIXED_SOURCE_DATASET.organization ||
    prepared.core.config.state.branch !== `sandbox-state/${descriptor.environmentId}` ||
    prepared.core.identity.startedAt !== times.startedAt
  ) {
    throw new TypeError("固定source記述子とsandbox実行の識別情報が一致しません");
  }
  assertClosedPreviousState(prepared);
}

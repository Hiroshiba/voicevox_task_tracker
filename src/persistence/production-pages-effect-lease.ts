import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type { PagesDeploymentIntent } from "../application/tracking-run/pages-build-contracts.js";
import type { PagesDeploymentReceipt } from "../application/tracking-run/receipt-schema.js";
import {
  PRODUCTION_PAGES_EFFECT_LEASE_BRANCH,
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
} from "./branch-adapter.js";
import { StateBranchConflictError } from "./errors.js";
import { createStateCommitIdentity } from "./state-commit-metadata.js";

export const PRODUCTION_PAGES_EFFECT_LEASE_PATH = "state/production-pages-effect-lease-v1.json";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const keySchema = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const actionsRunIdSchema = z.string().regex(/^[1-9][0-9]*$/u);
const effectSchema = z.strictObject({
  phase: z.enum(["initial", "notification_history"]),
  sourceStateRevision: revisionSchema,
  deploymentIntentDigest: sha256Schema,
  idempotencyKey: keySchema,
  childRunId: actionsRunIdSchema.optional(),
  childRunAttempt: z.number().int().positive().optional(),
});
const leaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(["active", "released"]),
  runId: runIdSchema,
  checkpointDigest: sha256Schema,
  parentRunId: actionsRunIdSchema,
  parentRunAttempt: z.number().int().positive(),
  codeRevision: revisionSchema,
  effect: effectSchema,
});

/** production Pages childが排他的に所有する効果の記録。 */
export type ProductionPagesEffectLease = z.output<typeof leaseSchema>;
export type ProductionPagesEffectReservation = Readonly<{
  lease: ProductionPagesEffectLease;
  created: boolean;
}>;

/** canonical lease fileを検証して読む。 */
export function parseProductionPagesEffectLease(bytes: Uint8Array): ProductionPagesEffectLease {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bytes.byteLength > 4096) {
    throw new TypeError("production Pages leaseが上限を超えています");
  }
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("production Pages leaseがcanonical JSONではありません");
  }
  const lease = leaseSchema.parse(raw);
  if (
    lease.effect.idempotencyKey !==
      nodeContentDigestPort
        .sha256Utf8(
          serializeCanonicalJsonLine({
            runId: lease.runId,
            phase: lease.effect.phase,
            deploymentIntentDigest: lease.effect.deploymentIntentDigest,
          }),
        )
        .slice("sha256:".length) ||
    (lease.effect.childRunId == null) !== (lease.effect.childRunAttempt == null)
  ) {
    throw new TypeError("production Pages leaseの効果識別子が不正です");
  }
  return lease;
}

async function leaseAt(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
): Promise<ProductionPagesEffectLease | undefined> {
  if (head.status === "missing") {
    return undefined;
  }
  const file = await adapter.readFile(head.revision, PRODUCTION_PAGES_EFFECT_LEASE_PATH);
  return file.status === "present" ? parseProductionPagesEffectLease(file.bytes) : undefined;
}

/** 専用branchのleaseを読み取る。 */
export async function readProductionPagesEffectLease(
  adapter: StateBranchAdapter,
): Promise<ProductionPagesEffectLease | undefined> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  return leaseAt(adapter, head);
}

/** 専用branchからactive leaseを読み取る。 */
export async function readActiveProductionPagesEffectLease(
  adapter: StateBranchAdapter,
): Promise<ProductionPagesEffectLease> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const lease = await leaseAt(adapter, head);
  if (lease?.status !== "active") {
    throw new TypeError("production Pagesのactive leaseがありません");
  }
  return lease;
}

/** active leaseがなければproduction入口を許可する。 */
export async function assertNoProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  branch: string,
): Promise<void> {
  if (branch !== "tracker-state") {
    throw new TypeError("production Pages leaseのstate branchが不正です");
  }
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  if ((await leaseAt(adapter, head))?.status === "active") {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages childの効果が未確定です"),
    });
  }
}

async function changeLease(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
  next: ProductionPagesEffectLease,
  now: Date,
): Promise<void> {
  const updates = [
    {
      path: PRODUCTION_PAGES_EFFECT_LEASE_PATH,
      bytes: new TextEncoder().encode(serializeCanonicalJsonLine(next)),
    },
  ];
  const deletions: string[] = [];
  const message =
    next.status === "released" ? "production Pages leaseを解放" : "production Pages leaseを更新";
  const result = await adapter.commit({
    branch: PRODUCTION_PAGES_EFFECT_LEASE_BRANCH,
    expectedHead: head,
    updates,
    deletions,
    message,
    committedAt: now.toISOString(),
    commitIdentity: createStateCommitIdentity(
      "production_pages_effect",
      undefined,
      head,
      message,
      updates,
      deletions,
    ),
  });
  await adapter.publish({
    branch: PRODUCTION_PAGES_EFFECT_LEASE_BRANCH,
    revision: result.revision,
  });
}

/** child dispatch前に効果をCASで予約する。 */
export async function reserveProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  intent: PagesDeploymentIntent,
  owner: Readonly<{ parentRunId: string; parentRunAttempt: number; codeRevision: string }>,
  initialDeploymentReceipt: PagesDeploymentReceipt | undefined,
  now: Date,
): Promise<ProductionPagesEffectReservation> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const previous = await leaseAt(adapter, head);
  if (
    previous?.status === "active" &&
    (previous.runId !== intent.runId ||
      previous.checkpointDigest !== intent.checkpointDigest ||
      (previous.effect.phase === "notification_history" && intent.phase === "initial"))
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages leaseを別の実行が保持しています"),
    });
  }
  const idempotencyKey = nodeContentDigestPort
    .sha256Utf8(
      serializeCanonicalJsonLine({
        runId: intent.runId,
        phase: intent.phase,
        deploymentIntentDigest: intent.deploymentIntentDigest,
      }),
    )
    .slice("sha256:".length);
  if (
    previous?.status === "active" &&
    previous.effect.phase === intent.phase &&
    previous.effect.deploymentIntentDigest === intent.deploymentIntentDigest &&
    previous.effect.sourceStateRevision === intent.sourceStateRevision
  ) {
    return Object.freeze({ lease: previous, created: false });
  }
  if (previous?.status === "active" && previous.effect.phase === intent.phase) {
    throw new StateBranchConflictError({
      cause: new TypeError("同じPages phaseへ異なるintentを予約できません"),
    });
  }
  if (
    previous?.status === "active" &&
    (previous.effect.childRunId == null ||
      initialDeploymentReceipt?.receiptType !== "pages_deployment" ||
      initialDeploymentReceipt.phase !== "initial" ||
      (initialDeploymentReceipt.status !== "deployed" &&
        initialDeploymentReceipt.status !== "replayed_same_content") ||
      initialDeploymentReceipt.effectCertainty !== "committed" ||
      initialDeploymentReceipt.binding.bindingKind !== "checkpoint" ||
      initialDeploymentReceipt.binding.runId !== previous.runId ||
      initialDeploymentReceipt.binding.checkpointDigest !== previous.checkpointDigest ||
      initialDeploymentReceipt.logicalTarget !== previous.effect.deploymentIntentDigest ||
      initialDeploymentReceipt.result?.deploymentIntentDigest !==
        previous.effect.deploymentIntentDigest ||
      initialDeploymentReceipt.result.sourceStateRevision !== previous.effect.sourceStateRevision)
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("成功した初回Pages receiptがないため履歴Pagesを予約できません"),
    });
  }
  const lease = leaseSchema.parse({
    schemaVersion: 1,
    status: "active",
    runId: intent.runId,
    checkpointDigest: intent.checkpointDigest,
    parentRunId: owner.parentRunId,
    parentRunAttempt: owner.parentRunAttempt,
    codeRevision: owner.codeRevision,
    effect: {
      phase: intent.phase,
      sourceStateRevision: intent.sourceStateRevision,
      deploymentIntentDigest: intent.deploymentIntentDigest,
      idempotencyKey,
    },
  });
  await changeLease(adapter, head, lease, now);
  return Object.freeze({ lease, created: true });
}

/** childが実行IDをCASで確保し重複deployを拒否する。 */
export async function claimProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  expected: ProductionPagesEffectLease,
  childRunId: string,
  childRunAttempt: number,
  now: Date,
): Promise<void> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const current = await leaseAt(adapter, head);
  if (
    current?.status !== "active" ||
    current.effect.idempotencyKey !== expected.effect.idempotencyKey ||
    current.parentRunId !== expected.parentRunId ||
    current.parentRunAttempt !== expected.parentRunAttempt ||
    current.codeRevision !== expected.codeRevision ||
    current.effect.childRunId != null
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages childの効果予約が一致しません"),
    });
  }
  await changeLease(
    adapter,
    head,
    leaseSchema.parse({
      ...current,
      effect: { ...current.effect, childRunId, childRunAttempt },
    }),
    now,
  );
}

/** 検証済みの継続attemptが同一leaseだけをCASで解放する。 */
export async function releaseProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  expected: ProductionPagesEffectLease,
  now: Date,
): Promise<void> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const current = await leaseAt(adapter, head);
  if (
    current?.status !== "active" ||
    serializeCanonicalJsonLine(current) !== serializeCanonicalJsonLine(expected) ||
    current.effect.childRunId == null
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("解放対象のproduction Pages leaseが一致しません"),
    });
  }
  await changeLease(adapter, head, leaseSchema.parse({ ...current, status: "released" }), now);
}

/** exact revisionのlease fileを読み取る。 */
export function parseProductionPagesEffectLeaseFile(
  file: StateFileReadResult,
): ProductionPagesEffectLease {
  if (file.status !== "present") {
    throw new TypeError("production Pages leaseがありません");
  }
  return parseProductionPagesEffectLease(file.bytes);
}

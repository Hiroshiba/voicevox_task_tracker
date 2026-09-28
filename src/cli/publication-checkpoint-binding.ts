import { z } from "zod";

import { serializeCanonicalJson } from "../canonical-json/value.js";
import { parseSha256Hash, type Sha256Hash } from "../canonical-json/sha256.js";
import {
  baseStateRevisionSchema,
  type BaseStateRevision,
} from "../application/tracking-run/contracts/run-core.js";
import type { HistoricalAiSnapshotInput } from "../application/tracking-run/contracts/evidence-closure.js";
import type { RuntimeIdentity } from "../application/tracking-run/contracts/runtime-identity.js";
import { runtimeRecoveryPlanSchema } from "../application/tracking-run/recovery-bootstrap.js";
import type { ContentDigestPort } from "../application/tracking-run/ports.js";
import { assertHistoricalAiWitnessMatchesBaseSnapshot } from "../application/tracking-run/stages/run-validation-artifact-witness.js";
import type { PublicationPlannedRun } from "../publication/publication-plan-contracts.js";
import {
  assertDecodedPublicationArtifact,
  type DecodedPublicationArtifact,
} from "./publication-checkpoint-codec.js";

const checkpointBindingProofBrand: unique symbol = Symbol("checkpointBindingProof");
const issuedBindings = new WeakSet<object>();
const sha256Schema = z.string().transform(parseSha256Hash);

export const checkpointBindingMetadataSchema = z.strictObject({
  checkpointFileDigest: sha256Schema,
  runtimeRecoveryPlan: runtimeRecoveryPlanSchema,
});

/** checkpointのtransportと回復計画だけを追加する結合情報。 */
export type CheckpointBindingMetadata = z.output<typeof checkpointBindingMetadataSchema>;

/** binderだけが発行するcheckpoint結合証明。 */
export type CheckpointBindingProof = Readonly<{
  checkpointDigest: Sha256Hash;
  checkpointFileDigest: Sha256Hash;
  runtimeIdentityDigest: Sha256Hash;
  runtimeRecoveryPlanDigest: Sha256Hash;
  readonly [checkpointBindingProofBrand]: true;
}>;

/** 後続のstate commitへ渡す単一の検証済み入力。 */
export type BoundPublicationCheckpoint = Readonly<{
  checkpoint: DecodedPublicationArtifact["checkpoint"];
  validatedPayload: DecodedPublicationArtifact["validatedPayload"];
  validated: DecodedPublicationArtifact["validated"];
  publicationPlan: DecodedPublicationArtifact["publicationPlan"];
  planned: PublicationPlannedRun;
  runtimeIdentity: RuntimeIdentity;
  checkpointDigest: Sha256Hash;
  binding: CheckpointBindingMetadata;
  bindingProof: CheckpointBindingProof;
}>;

/** exact base treeから読んだ前回AI履歴の検証文脈。 */
export type CheckpointBaseWitness = Readonly<{
  revision: BaseStateRevision;
  previousAiSnapshot: HistoricalAiSnapshotInput | undefined;
}>;

function assertRecoveryPlanMatchesRuntime(
  runtime: RuntimeIdentity,
  plan: CheckpointBindingMetadata["runtimeRecoveryPlan"],
  digest: ContentDigestPort,
): void {
  if (plan.kind === "workflow_bundle") {
    if (
      runtime.kind !== "workflow_bundle" ||
      plan.codeRevision !== runtime.codeRevision ||
      plan.bundleSha256 !== runtime.bundleSha256 ||
      plan.lockfileSha256 !== runtime.lockfileSha256 ||
      serializeCanonicalJson(plan.toolchain) !== serializeCanonicalJson(runtime.toolchain)
    ) {
      throw new TypeError("workflow bundleの回復計画がruntime identityと一致しません");
    }
    return;
  }
  if (plan.kind === "rebuild_exact") {
    if (
      runtime.kind !== "source_process" ||
      plan.codeRevision !== runtime.codeRevision ||
      plan.expectedRuntimeManifestSha256 !== runtime.runtimeManifestSha256 ||
      plan.lockfileSha256 !== runtime.lockfileSha256 ||
      serializeCanonicalJson(plan.toolchain) !== serializeCanonicalJson(runtime.toolchain)
    ) {
      throw new TypeError("source processの回復計画がruntime identityと一致しません");
    }
    return;
  }
  if (plan.runtimeIdentityDigest !== digest.sha256Utf8(serializeCanonicalJson(runtime))) {
    throw new TypeError("回復不能計画のruntime identity digestが一致しません");
  }
}

/** artifact、sidecar、exact base、前回AI、回復計画を結合する。 */
export function bindPublicationCheckpoint(
  decoded: DecodedPublicationArtifact,
  metadataValue: unknown,
  baseWitness: CheckpointBaseWitness,
  digest: ContentDigestPort,
): BoundPublicationCheckpoint {
  assertDecodedPublicationArtifact(decoded);
  const metadata = checkpointBindingMetadataSchema.parse(metadataValue);
  const revision = baseStateRevisionSchema.parse(baseWitness.revision);
  if (
    decoded.checkpointFileDigest !== metadata.checkpointFileDigest ||
    serializeCanonicalJson(decoded.checkpoint.baseStateRevision) !==
      serializeCanonicalJson(revision)
  ) {
    throw new TypeError("checkpointとsidecarまたはexact base revisionが一致しません");
  }
  if (revision.status === "missing" && baseWitness.previousAiSnapshot != null) {
    throw new TypeError("存在しないbase revisionに前回AI snapshotがあります");
  }
  assertHistoricalAiWitnessMatchesBaseSnapshot(
    decoded.validated.evidenceClosureWitness,
    baseWitness.previousAiSnapshot,
  );
  assertRecoveryPlanMatchesRuntime(decoded.runtimeIdentity, metadata.runtimeRecoveryPlan, digest);
  if (
    metadata.runtimeRecoveryPlan.kind === "not_reproducible" &&
    decoded.checkpoint.executionPolicy.effectTarget !== "recording"
  ) {
    throw new TypeError("永続効果のあるrunに回復不能なruntimeは使えません");
  }
  const proof = Object.freeze<CheckpointBindingProof>({
    checkpointDigest: decoded.checkpointDigest,
    checkpointFileDigest: decoded.checkpointFileDigest,
    runtimeIdentityDigest: digest.sha256Utf8(serializeCanonicalJson(decoded.runtimeIdentity)),
    runtimeRecoveryPlanDigest: digest.sha256Utf8(
      serializeCanonicalJson(metadata.runtimeRecoveryPlan),
    ),
    [checkpointBindingProofBrand]: true,
  });
  const bound = Object.freeze({
    checkpoint: decoded.checkpoint,
    validatedPayload: decoded.validatedPayload,
    validated: decoded.validated,
    publicationPlan: decoded.publicationPlan,
    planned: Object.freeze({
      validated: decoded.validated,
      publicationPlan: decoded.publicationPlan,
    }),
    runtimeIdentity: decoded.runtimeIdentity,
    checkpointDigest: decoded.checkpointDigest,
    binding: metadata,
    bindingProof: proof,
  });
  issuedBindings.add(bound);
  return bound;
}

/** 後続stageへ偽造されたcheckpointを渡さない。 */
export function assertBoundPublicationCheckpoint(value: BoundPublicationCheckpoint): void {
  if (!issuedBindings.has(value)) {
    throw new TypeError("checkpointがbinderで検証されていません");
  }
}

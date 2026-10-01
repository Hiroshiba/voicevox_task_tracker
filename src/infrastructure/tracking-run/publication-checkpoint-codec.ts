import { z } from "zod";
import type { AnalysisRunStageName } from "../../application/tracking-run/contracts/closed-values.js";
import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import type { RuntimeIdentity } from "../../application/tracking-run/contracts/runtime-identity.js";
import type { ContentDigestPort } from "../../application/tracking-run/ports.js";
import type { Sha256Hash } from "../../canonical-json/sha256.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { planPublication } from "../../publication/plan-publication.js";
import type {
  PublicationPlan,
  PublicationPlannedRun,
} from "../../publication/publication-plan-contracts.js";
import {
  publicationArtifactSchema,
  publicationArtifactSidecarSchema,
  publicationCheckpointSchema,
  type PublicationArtifactSidecar,
  type PublicationCheckpoint,
} from "./publication-checkpoint-schema.js";
import {
  parseValidatedRunPayload,
  validatedRunSerializablePayload,
  type ValidatedRunPayload,
} from "./validated-run-payload.js";

const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;
const issuedArtifacts = new WeakSet<object>();

/** 保存前のv20 checkpoint入力。 */
export type EncodePublicationCheckpointInput = Readonly<{
  planned: PublicationPlannedRun;
  validatedPayload: ValidatedRunPayload;
  runtimeIdentity: RuntimeIdentity;
  artifactFileName: string;
  analysisCompletedStages?: readonly AnalysisRunStageName[];
}>;

/** sidecarとruntimeを照合して復元したartifact。 */
export type DecodedPublicationArtifact = Readonly<{
  checkpoint: PublicationCheckpoint;
  validatedPayload: ValidatedRunPayload;
  validated: ValidatedRunPayload["validated"];
  publicationPlan: PublicationPlan;
  runtimeIdentity: RuntimeIdentity;
  checkpointDigest: Sha256Hash;
  checkpointFileDigest: Sha256Hash;
  artifactFileName: string;
}>;

/** 保存先へ渡すcanonical artifactとsidecar bytes。 */
export type EncodedPublicationCheckpoint = Readonly<{
  artifactBytes: Uint8Array;
  sidecarBytes: Uint8Array;
  decoded: DecodedPublicationArtifact;
}>;

/** 外部から期待するrun、base、設定、runtimeの識別。 */
export type ExpectedPublicationCheckpoint = Readonly<{
  runtimeIdentity: RuntimeIdentity;
  expectedRunId: string;
  baseStateRevision: BaseStateRevision;
  configDigest: Sha256Hash;
  artifactFileName: string;
}>;

function parseCanonicalLine(bytes: Uint8Array, label: string): unknown {
  if (bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new TypeError(`${label}が許容するbyte数を超えています`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(value)) {
    throw new TypeError(`${label}がcanonical JSONではありません`);
  }
  return value;
}

function assertSameValue(actual: unknown, expected: unknown, label: string): void {
  if (serializeCanonicalJson(actual) !== serializeCanonicalJson(expected)) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function parsePublicationCheckpoint(
  value: unknown,
  digest: ContentDigestPort,
): Readonly<{
  checkpoint: PublicationCheckpoint;
  validatedPayload: ValidatedRunPayload;
  validated: ValidatedRunPayload["validated"];
  publicationPlan: PublicationPlan;
}> {
  const checkpoint = publicationCheckpointSchema.parse(value);
  const validatedPayload = parseValidatedRunPayload(checkpoint.validatedPayload, digest);
  const validated = validatedPayload.validated;
  assertSameValue(checkpoint.runIdentity, validated.core.identity, "checkpointのrun identity");
  assertSameValue(
    checkpoint.executionPolicy,
    validated.core.executionPolicy,
    "checkpointの実行policy",
  );
  assertSameValue(
    checkpoint.baseStateRevision,
    validated.core.baseRevision,
    "checkpointのbase revision",
  );
  assertSameValue(checkpoint.configDigest, validated.core.configDigest, "checkpointの設定digest");
  const planned = planPublication(validated, digest);
  const publicationPlan = z
    .custom<PublicationPlan>(
      (candidate) =>
        serializeCanonicalJson(candidate) === serializeCanonicalJson(planned.publicationPlan),
    )
    .parse(checkpoint.publicationPlan);
  return Object.freeze({
    checkpoint,
    validatedPayload,
    validated,
    publicationPlan,
  });
}

/** v20 checkpointとsidecarを同じcodecから生成する。 */
export function encodePublicationCheckpoint(
  input: EncodePublicationCheckpointInput,
  digest: ContentDigestPort,
): EncodedPublicationCheckpoint {
  assertSameValue(
    input.validatedPayload.validated.core,
    input.planned.validated.core,
    "公開計画のrun",
  );
  assertSameValue(
    input.planned.publicationPlan,
    planPublication(input.planned.validated, digest).publicationPlan,
    "公開計画",
  );
  const checkpoint = publicationCheckpointSchema.parse({
    runIdentity: input.planned.validated.core.identity,
    executionPolicy: input.planned.validated.core.executionPolicy,
    baseStateRevision: input.planned.validated.core.baseRevision,
    configDigest: input.planned.validated.core.configDigest,
    ...(input.analysisCompletedStages == null
      ? {}
      : { analysisCompletedStages: input.analysisCompletedStages }),
    validatedPayload: validatedRunSerializablePayload(input.validatedPayload),
    publicationPlan: input.planned.publicationPlan,
  });
  const envelope = Object.freeze({
    schemaVersion: 20,
    kind: "publication_planned_tracking_run",
    runtimeIdentity: input.runtimeIdentity,
    payload: checkpoint,
  });
  const artifact = publicationArtifactSchema.parse({
    ...envelope,
    checkpointDigest: digest.sha256Utf8(serializeCanonicalJson(envelope)),
  });
  const artifactBytes = new TextEncoder().encode(serializeCanonicalJsonLine(artifact));
  const sidecar = publicationArtifactSidecarSchema.parse({
    artifactFileName: input.artifactFileName,
    byteLength: artifactBytes.length,
    checkpointFileDigest: digest.sha256Bytes(artifactBytes),
  });
  const sidecarBytes = new TextEncoder().encode(serializeCanonicalJsonLine(sidecar));
  const decoded = decodePublicationArtifact(
    artifactBytes,
    sidecarBytes,
    {
      runtimeIdentity: input.runtimeIdentity,
      expectedRunId: input.planned.validated.core.identity.runId,
      baseStateRevision: input.planned.validated.core.baseRevision,
      configDigest: input.planned.validated.core.configDigest,
      artifactFileName: input.artifactFileName,
    },
    digest,
  );
  return Object.freeze({ artifactBytes, sidecarBytes, decoded });
}

/** sidecar、二重digest、識別と参照閉包を検証してv20 artifactを読む。 */
export function decodePublicationArtifact(
  artifactBytes: Uint8Array,
  sidecarBytes: Uint8Array,
  expected: ExpectedPublicationCheckpoint,
  digest: ContentDigestPort,
): DecodedPublicationArtifact {
  const artifact = publicationArtifactSchema.parse(
    parseCanonicalLine(artifactBytes, "checkpoint artifact"),
  );
  const sidecar: PublicationArtifactSidecar = publicationArtifactSidecarSchema.parse(
    parseCanonicalLine(sidecarBytes, "checkpoint sidecar"),
  );
  if (
    sidecar.artifactFileName !== expected.artifactFileName ||
    sidecar.byteLength !== artifactBytes.length ||
    sidecar.checkpointFileDigest !== digest.sha256Bytes(artifactBytes)
  ) {
    throw new TypeError("checkpoint sidecarとartifact bytesが一致しません");
  }
  const { checkpointDigest, ...envelope } = artifact;
  if (checkpointDigest !== digest.sha256Utf8(serializeCanonicalJson(envelope))) {
    throw new TypeError("checkpoint digestがenvelopeと一致しません");
  }
  assertSameValue(
    artifact.runtimeIdentity,
    expected.runtimeIdentity,
    "checkpointのruntime identity",
  );
  if (artifact.payload.runIdentity.runId !== expected.expectedRunId) {
    throw new TypeError("checkpointのrun IDが期待値と一致しません");
  }
  assertSameValue(
    artifact.payload.baseStateRevision,
    expected.baseStateRevision,
    "checkpointのbase revision",
  );
  assertSameValue(artifact.payload.configDigest, expected.configDigest, "checkpointの設定digest");
  const parsed = parsePublicationCheckpoint(artifact.payload, digest);
  const decoded = Object.freeze({
    checkpoint: parsed.checkpoint,
    validatedPayload: parsed.validatedPayload,
    validated: parsed.validated,
    publicationPlan: parsed.publicationPlan,
    runtimeIdentity: artifact.runtimeIdentity,
    checkpointDigest,
    checkpointFileDigest: sidecar.checkpointFileDigest,
    artifactFileName: sidecar.artifactFileName,
  });
  issuedArtifacts.add(decoded);
  return decoded;
}

/** binderへ渡せる復元済みartifactだけを許可する。 */
export function assertDecodedPublicationArtifact(value: DecodedPublicationArtifact): void {
  if (!issuedArtifacts.has(value)) {
    throw new TypeError("checkpoint artifactがcodecで検証されていません");
  }
}

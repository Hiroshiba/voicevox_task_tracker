import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import type { RunExecutionPolicy, RunIdentity } from "../../application/tracking-run/request.js";
import type { Sha256Hash } from "../../canonical-json/sha256.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { CliWorkflowArtifactError } from "./errors.js";
import {
  bindPublicationCheckpoint,
  type BoundPublicationCheckpoint,
  type CheckpointBaseWitness,
} from "./publication-checkpoint-binding.js";
import {
  decodePublicationArtifact,
  type EncodedPublicationCheckpoint,
} from "./publication-checkpoint-codec.js";
import { publicationArtifactSchema } from "./publication-checkpoint-schema.js";
import type { PublicationRuntimeContext } from "./publication-runtime.js";

/** 読込前の効果境界で照合する外部識別。 */
export type PublicationCheckpointFileExpectation = Readonly<{
  expectedRunId: string;
  baseStateRevision: BaseStateRevision;
  configDigest: Sha256Hash;
  runtime: PublicationRuntimeContext;
  baseWitness: CheckpointBaseWitness;
}>;

/** sidecarの固定path。 */
export function publicationCheckpointSidecarPath(path: string): string {
  return `${path}.sidecar.json`;
}

function artifactFileError(path: string, error: unknown): CliWorkflowArtifactError {
  const missing =
    typeof error === "object" && error != null && "code" in error && error.code === "ENOENT";
  return new CliWorkflowArtifactError(path, missing ? "missing" : "invalid", { cause: error });
}

/** checkpoint artifactとsidecarを同じ保存先へ書く。 */
export async function writePublicationCheckpointFile(
  path: string,
  encoded: EncodedPublicationCheckpoint,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, encoded.artifactBytes, { flag: "w" });
    await writeFile(publicationCheckpointSidecarPath(path), encoded.sidecarBytes, { flag: "w" });
  } catch (error: unknown) {
    throw artifactFileError(path, error);
  }
}

/** 効果前の期待値を組み立てるため、未結合の識別だけを読む。 */
export async function readPublicationCheckpointHeader(path: string): Promise<
  Readonly<{
    runIdentity: RunIdentity;
    executionPolicy: RunExecutionPolicy;
    baseStateRevision: BaseStateRevision;
  }>
> {
  try {
    const bytes = await readFile(path);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(source);
    const artifact = publicationArtifactSchema.parse(value);
    return Object.freeze({
      runIdentity: artifact.payload.runIdentity,
      executionPolicy: artifact.payload.executionPolicy,
      baseStateRevision: artifact.payload.baseStateRevision,
    });
  } catch (error: unknown) {
    throw artifactFileError(path, error);
  }
}

/** v22 artifactとsidecarを検証し、exact baseへ結合して返す。 */
export async function readPublicationCheckpointFile(
  path: string,
  expected: PublicationCheckpointFileExpectation,
): Promise<BoundPublicationCheckpoint> {
  try {
    const [artifactBytes, sidecarBytes] = await Promise.all([
      readFile(path),
      readFile(publicationCheckpointSidecarPath(path)),
    ]);
    const decoded = decodePublicationArtifact(
      artifactBytes,
      sidecarBytes,
      {
        runtimeIdentity: expected.runtime.runtimeIdentity,
        expectedRunId: expected.expectedRunId,
        baseStateRevision: expected.baseStateRevision,
        configDigest: expected.configDigest,
        artifactFileName: basename(path),
      },
      nodeContentDigestPort,
    );
    return bindPublicationCheckpoint(
      decoded,
      {
        checkpointFileDigest: decoded.checkpointFileDigest,
        runtimeRecoveryPlan: expected.runtime.runtimeRecoveryPlan,
      },
      expected.baseWitness,
      nodeContentDigestPort,
    );
  } catch (error: unknown) {
    throw artifactFileError(path, error);
  }
}

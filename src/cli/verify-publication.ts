import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { verifyReceiptChain } from "../application/tracking-run/receipt-chain.js";
import { initialPagesPublicationEvidenceSchema } from "../application/tracking-run/initial-pages-evidence.js";
import {
  createPublicFailureArtifact,
  failedRunSchema,
} from "../application/tracking-run/failure-artifact.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type {
  ReportFailureCliCommand,
  VerifyCheckpointCliCommand,
  VerifyReceiptChainCliCommand,
  VerifyRuntimeRecoveryCliCommand,
} from "./command.js";
import { writeCliJsonArtifact } from "./file-output.js";
import { verifyWorkflowCheckpoint } from "./run-publication/workflow-stage-handlers.js";
import { launchRuntimeRecoveryV1 } from "./runtime-recovery-launcher-v1.js";
import type { ProductionRuntimeAdapters } from "./production-runtime/adapters.js";

/** v19 checkpointの実fileとexact baseへの結合を検証する。 */
export async function verifyCheckpointCommand(
  adapters: ProductionRuntimeAdapters,
  command: VerifyCheckpointCliCommand,
): Promise<void> {
  await verifyWorkflowCheckpoint({ adapters }, command);
  await adapters.writeStandardOutput("checkpointの検証に成功しました\n");
}

/** 固定V1入力でexact runtimeを起動し回復protocolを検証する。 */
export async function verifyRuntimeRecoveryCommand(
  adapters: ProductionRuntimeAdapters,
  command: VerifyRuntimeRecoveryCliCommand,
): Promise<void> {
  const source = await readFile(resolve(adapters.repositoryPath, command.inputPath), "utf8");
  const value: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(value)) {
    throw new TypeError("V1回復入力がcanonical JSONではありません");
  }
  const output = await launchRuntimeRecoveryV1(
    adapters.repositoryPath,
    resolve(adapters.repositoryPath, command.bundleRoot),
    value,
  );
  await adapters.writeStandardOutput(serializeCanonicalJsonLine(output));
}

/** 保存したreceipt列を実codecと同じ規則で検証する。 */
export async function verifyReceiptChainCommand(
  adapters: ProductionRuntimeAdapters,
  command: VerifyReceiptChainCliCommand,
): Promise<void> {
  const source = await readFile(resolve(adapters.repositoryPath, command.inputPath), "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("receipt chainがcanonical JSONではありません");
  }
  const input = z
    .strictObject({
      schemaVersion: z.literal(1),
      receipts: z.array(z.unknown()).min(1),
      evidence: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("none") }),
        z.strictObject({
          kind: z.literal("initial_pages_state"),
          state: z.strictObject({
            exactStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
            marker: z.strictObject({
              runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
              checkpointDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
              phase: z.enum([
                "notifications_in_progress",
                "notifications_settled",
                "run_finalized",
              ]),
              initialPagesPublicationEvidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
              initialStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
            }),
            evidence: initialPagesPublicationEvidenceSchema,
          }),
        }),
      ]),
    })
    .parse(raw);
  const verified = verifyReceiptChain(input.receipts, nodeContentDigestPort, input.evidence);
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({
      lastReceiptDigest: verified.proof.lastReceiptDigest,
      completedPhaseSequence: verified.proof.completedPhaseSequence,
    }),
  );
}

/** 記録済み失敗runから公開可能fieldだけのartifactを出力する。 */
export async function reportFailureCommand(
  adapters: ProductionRuntimeAdapters,
  command: ReportFailureCliCommand,
): Promise<void> {
  const source = await readFile(resolve(adapters.repositoryPath, command.inputPath), "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("失敗runがcanonical JSONではありません");
  }
  const failure = failedRunSchema.parse(raw);
  if (failure.encryptedDiagnosticsRecordIds.length === 0) {
    throw new TypeError("公開失敗artifactには記録済みの暗号化診断参照が必要です");
  }
  const artifact = createPublicFailureArtifact(failure, nodeContentDigestPort);
  await writeCliJsonArtifact(resolve(adapters.repositoryPath, command.outputPath), artifact);
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({ failureArtifactDigest: artifact.failureArtifactDigest }),
  );
}

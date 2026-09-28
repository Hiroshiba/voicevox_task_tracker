import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import type { VerifyCheckpointCliCommand, VerifyRuntimeRecoveryCliCommand } from "./command.js";
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

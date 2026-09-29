import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { decodePublicFailureArtifact } from "../application/tracking-run/failure-artifact.js";
import {
  runtimeRecoveryInputV1Schema,
  runtimeRecoveryOutputV1Schema,
} from "../application/tracking-run/contracts/runtime-recovery-v1.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import { writeCliTextFile } from "./file-output.js";
import { observeBootstrap, type BootstrapFailureObservation } from "./failure-context-state.js";
import {
  isExpectedCheckpoint,
  reportManualExactFailure,
  revision,
} from "./manual-exact-failure.js";

const commandSchema = z.enum([
  "verify-checkpoint",
  "select-runtime",
  "resolve-discord-delivery",
  "settle-notifications",
  "finalize-run",
  "prepare-notification-history-pages",
  "preflight-notification-history-deployment",
  "record-notification-history-deployment",
]);
const environmentSchema = z.strictObject({
  checkout: z.string().min(1),
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  checkpointDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  codeRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  diagnosticsPath: z.string().min(1),
  failureDirectory: z.string().min(1),
});

export type ManualExactCommand = z.output<typeof commandSchema>;

class ExactCommandExitError extends Error {
  public constructor(command: string, exitCode: number | null, signal: string | null) {
    super(
      `旧runtimeの${command}が失敗しました。exit code: ${String(exitCode)}、signal: ${String(signal)}`,
    );
  }
}
async function failureNames(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function runExactCli(
  entrypoint: string,
  args: readonly string[],
  captureOutput: boolean,
): Promise<string> {
  const child = spawn(process.execPath, ["--enable-source-maps", entrypoint, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", captureOutput ? "pipe" : "inherit", "inherit"],
  });
  const chunks: Buffer[] = [];
  let byteLength = 0;
  if (captureOutput) {
    const stdout = child.stdout;
    if (stdout == null) {
      throw new TypeError("旧runtimeの標準出力を取得できません");
    }
    stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > 1024 * 1024) {
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
  }
  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.on("exit", (code, signal) => {
        resolveExit({ code, signal });
      });
    },
  );
  if (result.code !== 0 || byteLength > 1024 * 1024) {
    throw new ExactCommandExitError(args[0] ?? "unknown", result.code, result.signal);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function selectRuntime(
  entrypoint: string,
  runId: string,
  codeRevision: string,
  stateRevision: string,
): Promise<void> {
  const source = await runExactCli(
    entrypoint,
    ["inspect-run-state", "--run-id", runId, "--state-revision", stateRevision],
    true,
  );
  const value: unknown = JSON.parse(source);
  const decision = z
    .looseObject({
      kind: z.literal("resume_with_exact_runtime"),
      recoveryInput: runtimeRecoveryInputV1Schema,
    })
    .parse(value);
  const input = decision.recoveryInput;
  if (
    input.runId !== runId ||
    input.exactStateRevision !== stateRevision ||
    input.runtimeRecoveryPlan.kind === "not_reproducible" ||
    input.runtimeRecoveryPlan.codeRevision !== codeRevision
  ) {
    throw new TypeError("旧runのruntime選択が指定したrunとcode revisionに一致しません");
  }
  await writeCliTextFile(
    "artifacts/workflow/manual-recovery-input.json",
    serializeCanonicalJsonLine(input),
  );
  const verification = await runExactCli(
    entrypoint,
    [
      "verify-runtime-recovery",
      "--input",
      "artifacts/workflow/manual-recovery-input.json",
      "--bundle-root",
      "artifacts/workflow/runtime",
    ],
    true,
  );
  const output: unknown = JSON.parse(verification);
  const verified = runtimeRecoveryOutputV1Schema.parse(output);
  if (verified.status === "manual_resolution_required" && verified.reason !== "effect_uncertain") {
    throw new TypeError("旧runtimeのV1回復入口を検証できません");
  }
}

/** 旧exact CLIを隔離checkoutで実行し、未報告の失敗だけを現行契約で記録する。 */
export async function runManualExactRuntime(args: readonly string[]): Promise<number> {
  const command = commandSchema.parse(args[0]);
  const input = environmentSchema.parse({
    checkout: process.env["VOICEVOX_MANUAL_EXACT_CHECKOUT"],
    runId: process.env["VOICEVOX_EXPECTED_RUN_ID"],
    checkpointDigest: process.env["VOICEVOX_MANUAL_CHECKPOINT_DIGEST"],
    codeRevision: process.env["VOICEVOX_MANUAL_CODE_REVISION"],
    diagnosticsPath: process.env["VOICEVOX_TASK_TRACKER_DIAGNOSTICS_PATH"],
    failureDirectory: process.env["VOICEVOX_TASK_TRACKER_FAILURE_DIRECTORY"],
  });
  const checkout = resolve(input.checkout);
  const entrypoint = resolve(checkout, "artifacts/workflow/runtime/tracker-run.mjs");
  const existingFailures = new Set(await failureNames(input.failureDirectory));
  process.chdir(checkout);
  let before: BootstrapFailureObservation | undefined;
  let after: BootstrapFailureObservation | undefined;
  let failure: unknown;
  try {
    before = await observeBootstrap("config.yml", input.runId);
    if (!isExpectedCheckpoint(before, input.runId, input.checkpointDigest)) {
      throw new TypeError("手動解決前のstateと指定したrun/checkpointが一致しません");
    }
    if (command === "select-runtime") {
      const stateRevision = revision(before);
      if (stateRevision == null) {
        throw new TypeError("旧runtime選択に必要なstate revisionがありません");
      }
      await selectRuntime(entrypoint, input.runId, input.codeRevision, stateRevision);
    } else {
      await runExactCli(entrypoint, [command, ...args.slice(1)], false);
    }
    return 0;
  } catch (error: unknown) {
    failure = error;
  }
  try {
    after = await observeBootstrap("config.yml", input.runId);
  } catch (error: unknown) {
    failure = new AggregateError([failure, error], "旧runtime失敗後のstate観測にも失敗しました", {
      cause: failure,
    });
  }
  const createdFailures = (await failureNames(input.failureDirectory)).filter(
    (name) => !existingFailures.has(name),
  );
  if (createdFailures.length > 0) {
    for (const name of createdFailures) {
      decodePublicFailureArtifact(
        await readFile(resolve(input.failureDirectory, name)),
        nodeContentDigestPort,
      );
    }
    throw failure;
  }
  await reportManualExactFailure(command, failure, before, after, input);
  throw failure;
}

if (process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runManualExactRuntime(process.argv.slice(2));
}

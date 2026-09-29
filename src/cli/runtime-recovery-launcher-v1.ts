import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { loadConfig } from "../config/index.js";
import {
  inspectRunState,
  type RunStateDecision,
} from "../infrastructure/tracking-run/inspect-run-state.js";
import { GitStateBranchAdapter } from "../persistence/index.js";
import {
  runtimeRecoveryInputV1Schema,
  runtimeRecoveryOutputV1Schema,
  type RuntimeRecoveryInputV1,
  type RuntimeRecoveryOutputV1,
} from "../application/tracking-run/contracts/runtime-recovery-v1.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  verifyRebuiltRuntime,
  verifyRecoveryBundle,
  workflowAdapterIdentity,
  assertRecoveryToolchain,
} from "./publication-runtime.js";

const MAX_PROTOCOL_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

function recoveryDecisionOutput(decision: RunStateDecision): RuntimeRecoveryOutputV1 {
  if (decision.kind === "resume_pending") {
    if (decision.stageInput.stage === "completed") {
      return runtimeRecoveryOutputV1Schema.parse({
        protocolVersion: 1,
        outputContract: "tracking-run-recovery-output-v1",
        status: "completed",
        stateRevision: decision.stageInput.exactStateRevision,
      });
    }
    return runtimeRecoveryOutputV1Schema.parse({
      protocolVersion: 1,
      outputContract: "tracking-run-recovery-output-v1",
      status: "ready",
      stateRevision: decision.stageInput.exactStateRevision,
      nextStage: decision.stageInput.stage,
    });
  }
  return runtimeRecoveryOutputV1Schema.parse({
    protocolVersion: 1,
    outputContract: "tracking-run-recovery-output-v1",
    status: "manual_resolution_required",
    reason:
      decision.kind === "operator_conflict_resolution" ? "state_conflict" : "effect_uncertain",
  });
}

function runtimeIdentity(input: RuntimeRecoveryInputV1): object {
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind === "workflow_bundle") {
    return Object.freeze({
      kind: "workflow_bundle",
      codeRevision: plan.codeRevision,
      bundleSha256: plan.bundleSha256,
      lockfileSha256: plan.lockfileSha256,
      toolchain: plan.toolchain,
    });
  }
  if (plan.kind === "rebuild_exact") {
    return Object.freeze({
      kind: "source_process",
      codeRevision: plan.codeRevision,
      runtimeManifestSha256: plan.expectedRuntimeManifestSha256,
      lockfileSha256: plan.lockfileSha256,
      toolchain: plan.toolchain,
    });
  }
  throw new TypeError("回復不能なruntimeからV1 entrypointは起動できません");
}

async function assertRecoveryRuntime(
  repositoryPath: string,
  bundleRoot: string,
  input: RuntimeRecoveryInputV1,
): Promise<string> {
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind === "not_reproducible") {
    throw new TypeError("回復不能なruntimeからV1 entrypointは起動できません");
  }
  if (
    input.expectedRuntimeIdentityDigest !==
      nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(runtimeIdentity(input))) ||
    input.expectedWorkflowEffectAdapterIdentityDigest !==
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest
  ) {
    throw new TypeError("V1回復入力のruntimeまたはworkflow adapter identityが一致しません");
  }
  await assertRecoveryToolchain(repositoryPath, plan);
  const [checkoutRevision, checkoutStatus] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: repositoryPath,
    }),
  ]);
  if (
    checkoutRevision.stdout.trim() !== plan.codeRevision ||
    checkoutStatus.stdout.length !== 0 ||
    (plan.kind === "rebuild_exact" &&
      input.expectedWorkflowEffectAdapterIdentityDigest !==
        (await workflowAdapterIdentity(repositoryPath, nodeContentDigestPort)))
  ) {
    throw new TypeError("exact checkoutのrevisionまたはworkflow adapter identityが一致しません");
  }
  if (plan.kind === "workflow_bundle") {
    await verifyRecoveryBundle(bundleRoot, plan);
  } else {
    if (resolve(bundleRoot) !== resolve(repositoryPath, "dist")) {
      throw new TypeError("再build runtimeのrootが固定pathと一致しません");
    }
    await verifyRebuiltRuntime(repositoryPath, plan);
  }
  const root = await realpath(bundleRoot);
  const entrypointPath = resolve(root, plan.recoveryProtocol.entrypointRelativePath);
  const entrypoint = await realpath(entrypointPath);
  const relativePath = relative(root, entrypoint);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new TypeError("V1回復entrypointがruntime rootの外を参照しています");
  }
  if (
    nodeContentDigestPort.sha256Bytes(await readFile(entrypoint)) !==
    plan.recoveryProtocol.entrypointSha256
  ) {
    throw new TypeError("V1回復entrypointの実byte列が回復計画と一致しません");
  }
  return entrypoint;
}

/** 固定V1入力とexact runtimeの識別を副作用なしで検証する。 */
export async function verifyRuntimeRecoveryV1(
  repositoryPath: string,
  bundleRoot: string,
  value: unknown,
): Promise<void> {
  const input = runtimeRecoveryInputV1Schema.parse(value);
  await assertRecoveryRuntime(repositoryPath, bundleRoot, input);
}

/** 固定I/Oだけでexact runtimeのV1 entrypointを起動する。 */
export async function launchRuntimeRecoveryV1(
  repositoryPath: string,
  bundleRoot: string,
  value: unknown,
): Promise<RuntimeRecoveryOutputV1> {
  const input = runtimeRecoveryInputV1Schema.parse(value);
  const entrypoint = await assertRecoveryRuntime(repositoryPath, bundleRoot, input);
  const directory = await mkdtemp(join(tmpdir(), "voicevox-runtime-protocol-"));
  try {
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "output.json");
    await writeFile(inputPath, serializeCanonicalJsonLine(input), { flag: "wx", mode: 0o600 });
    const inputFile = await open(inputPath, "r");
    const outputFile = await open(outputPath, "wx", 0o600);
    let exitCode: number;
    try {
      const child = spawn(process.execPath, [entrypoint], {
        cwd: repositoryPath,
        env: {
          ...process.env,
          VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V1: "1",
          VOICEVOX_RUNTIME_BUNDLE_ROOT: bundleRoot,
        },
        stdio: [inputFile.fd, outputFile.fd, "inherit"],
      });
      exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code) => {
          resolveExit(code ?? 1);
        });
      });
    } finally {
      await inputFile.close();
      await outputFile.close();
    }
    if (exitCode !== 0 || (await stat(outputPath)).size > MAX_PROTOCOL_BYTES) {
      throw new TypeError("V1回復entrypointが固定I/Oを完了できませんでした");
    }
    const source = await readFile(outputPath, "utf8");
    const valueOutput: unknown = JSON.parse(source);
    if (source !== serializeCanonicalJsonLine(valueOutput)) {
      throw new TypeError("V1回復出力がcanonical JSONではありません");
    }
    return runtimeRecoveryOutputV1Schema.parse(valueOutput);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** exact runtime内の固定V1入力を受理し、効果実行前に識別を照合する。 */
export async function runRuntimeRecoveryEntrypointV1(
  repositoryPath: string,
  bundleRoot: string,
): Promise<void> {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += String(chunk);
    if (Buffer.byteLength(source, "utf8") > MAX_PROTOCOL_BYTES) {
      throw new TypeError("V1回復入力が許容するbyte数を超えています");
    }
  }
  const value: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(value)) {
    throw new TypeError("V1回復入力がcanonical JSONではありません");
  }
  const input = runtimeRecoveryInputV1Schema.parse(value);
  await assertRecoveryRuntime(repositoryPath, bundleRoot, input);
  const config = await loadConfig(resolve(repositoryPath, "config.yml"));
  const adapter = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const decision = await inspectRunState(
    adapter,
    { ...config.state, branch: input.stateRef },
    {
      kind: "resume_run",
      runtime: "exact",
      runId: input.runId,
      exactStateRevision: input.exactStateRevision,
      expectedRecordDigest: input.expectedRecordDigest,
      expectedRuntimeIdentityDigest: input.expectedRuntimeIdentityDigest,
      expectedWorkflowEffectAdapterIdentityDigest:
        input.expectedWorkflowEffectAdapterIdentityDigest,
      runtimeRecoveryPlan: input.runtimeRecoveryPlan,
      observation: { invocationId: input.invocationId, observedAt: new Date().toISOString() },
      receipts: [],
    },
  );
  const output =
    decision.kind === "resume_pending" &&
    decision.stageInput.record.executionPolicy.executionShape === "sequential"
      ? await (
          await import("./runtime-recovery-sequential-v1.js")
        ).resumeExactSequentialRunV1(repositoryPath, input, decision)
      : recoveryDecisionOutput(decision);
  process.stdout.write(serializeCanonicalJsonLine(output));
}

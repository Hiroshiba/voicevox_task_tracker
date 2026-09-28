import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  runtimeRecoveryInputV1Schema,
  runtimeRecoveryOutputV1Schema,
  type RuntimeRecoveryInputV1,
  type RuntimeRecoveryOutputV1,
} from "../application/tracking-run/contracts/runtime-recovery-v1.js";
import {
  assertRecoveryToolchain,
  verifyRebuiltRuntime,
  verifyRecoveryBundle,
} from "./publication-runtime.js";
import { launchRuntimeRecoveryV1 } from "./runtime-recovery-launcher-v1.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(executable, [...arguments_], {
    cwd,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  return result.stdout.trim();
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureCodeRevision(repositoryPath: string, revision: string): Promise<void> {
  try {
    await runCommand("git", ["cat-file", "-e", `${revision}^{commit}`], repositoryPath);
  } catch {
    await runCommand("git", ["fetch", "--no-tags", "origin", revision], repositoryPath);
    await runCommand("git", ["cat-file", "-e", `${revision}^{commit}`], repositoryPath);
  }
}

async function withExactWorktree<T>(
  repositoryPath: string,
  revision: string,
  execute: (checkoutPath: string) => Promise<T>,
): Promise<T> {
  await ensureCodeRevision(repositoryPath, revision);
  const gitDirectory = await runCommand(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repositoryPath,
  );
  const worktreeDirectory = join(dirname(gitDirectory), "hiho_git_worktrees");
  await mkdir(worktreeDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(worktreeDirectory, "hiho_runtime_recovery_"));
  const checkoutPath = join(temporaryDirectory, "checkout");
  let created = false;
  try {
    await runCommand(
      "git",
      ["worktree", "add", "--detach", checkoutPath, revision],
      repositoryPath,
    );
    created = true;
    return await execute(checkoutPath);
  } finally {
    if (created) {
      await runCommand("git", ["worktree", "remove", "--force", checkoutPath], repositoryPath);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function installExactDependencies(
  checkoutPath: string,
  lockfileSha256: string,
): Promise<void> {
  const lockfile = await readFile(join(checkoutPath, "pnpm-lock.yaml"));
  if (nodeContentDigestPort.sha256Bytes(lockfile) !== lockfileSha256) {
    throw new TypeError("exact revisionのlockfile digestが回復計画と一致しません");
  }
  await runCommand("pnpm", ["install", "--frozen-lockfile"], checkoutPath);
}

async function rebuildWorkflowBundle(
  checkoutPath: string,
  plan: Extract<RuntimeRecoveryInputV1["runtimeRecoveryPlan"], { kind: "workflow_bundle" }>,
): Promise<string> {
  await installExactDependencies(checkoutPath, plan.lockfileSha256);
  await runCommand("pnpm", ["build"], checkoutPath);
  await runCommand("pnpm", ["build:workflow-cli"], checkoutPath);
  await runCommand(
    "node",
    [
      "--input-type=module",
      "-e",
      "import { writeWorkflowRuntimeManifest } from './dist/cli/publication-runtime.js'; await writeWorkflowRuntimeManifest(process.cwd());",
    ],
    checkoutPath,
  );
  const root = join(checkoutPath, "artifacts/workflow/runtime");
  await verifyRecoveryBundle(root, plan);
  return root;
}

async function rebuildSourceRuntime(
  checkoutPath: string,
  plan: Extract<RuntimeRecoveryInputV1["runtimeRecoveryPlan"], { kind: "rebuild_exact" }>,
): Promise<string> {
  await installExactDependencies(checkoutPath, plan.lockfileSha256);
  await runCommand("pnpm", ["build"], checkoutPath);
  await verifyRebuiltRuntime(checkoutPath, plan);
  return join(checkoutPath, "dist");
}

async function downloadWorkflowBundle(
  checkoutPath: string,
  plan: Extract<RuntimeRecoveryInputV1["runtimeRecoveryPlan"], { kind: "workflow_bundle" }>,
  destination: string,
): Promise<string | undefined> {
  try {
    await runCommand(
      "gh",
      ["run", "download", plan.workflowRunId, "--name", plan.artifactName, "--dir", destination],
      checkoutPath,
    );
  } catch {
    process.stderr.write("旧workflow artifactを取得できないためexact revisionから再buildします\n");
    return undefined;
  }
  const root = join(destination, "runtime");
  await verifyRecoveryBundle(root, plan);
  return root;
}

/** 記録済みrevisionを隔離し、元artifactまたは一致する再buildからV1入口を起動する。 */
export async function recoverRuntimeV1(
  repositoryPath: string,
  bundleRoot: string | undefined,
  value: unknown,
): Promise<RuntimeRecoveryOutputV1> {
  const input = runtimeRecoveryInputV1Schema.parse(value);
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind === "not_reproducible") {
    return runtimeRecoveryOutputV1Schema.parse({
      protocolVersion: 1,
      outputContract: "tracking-run-recovery-output-v1",
      status: "manual_resolution_required",
      reason: "recovery_stage_unavailable",
    });
  }
  try {
    await assertRecoveryToolchain(repositoryPath, plan);
    return await withExactWorktree(repositoryPath, plan.codeRevision, async (checkoutPath) => {
      if (plan.kind === "rebuild_exact") {
        const root = await rebuildSourceRuntime(checkoutPath, plan);
        return launchRuntimeRecoveryV1(checkoutPath, root, input);
      }
      let root: string | undefined;
      if (bundleRoot != null) {
        if (!(await isPresent(bundleRoot))) {
          throw new TypeError("指定した旧workflow bundleがありません");
        }
        root = resolve(bundleRoot);
        await verifyRecoveryBundle(root, plan);
      } else {
        const downloadDirectory = await mkdtemp(join(tmpdir(), "voicevox-runtime-download-"));
        try {
          root = await downloadWorkflowBundle(checkoutPath, plan, downloadDirectory);
          if (root != null) {
            return await launchRuntimeRecoveryV1(checkoutPath, root, input);
          }
        } finally {
          await rm(downloadDirectory, { recursive: true, force: true });
        }
      }
      root ??= await rebuildWorkflowBundle(checkoutPath, plan);
      return launchRuntimeRecoveryV1(checkoutPath, root, input);
    });
  } catch (error: unknown) {
    console.error(error);
    return runtimeRecoveryOutputV1Schema.parse({
      protocolVersion: 1,
      outputContract: "tracking-run-recovery-output-v1",
      status: "manual_resolution_required",
      reason: "recovery_stage_unavailable",
    });
  }
}

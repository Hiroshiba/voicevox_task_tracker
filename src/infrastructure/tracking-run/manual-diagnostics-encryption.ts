import { rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { runDiagnosticsCli } from "../../diagnostics/cli.js";

const environmentSchema = z.strictObject({
  runnerTemp: z.string().min(1),
  job: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  runId: z.string().regex(/^[1-9][0-9]*$/u),
  runAttempt: z.string().regex(/^[1-9][0-9]*$/u),
});

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 手動workflowの診断があれば暗号化し、平文を削除する。 */
export async function encryptManualDiagnostics(
  diagnosticsPath: string,
  hasFailureArtifact: boolean,
): Promise<void> {
  const environment = environmentSchema.parse({
    runnerTemp: process.env["RUNNER_TEMP"],
    job: process.env["GITHUB_JOB"],
    runId: process.env["GITHUB_RUN_ID"],
    runAttempt: process.env["GITHUB_RUN_ATTEMPT"],
  });
  if (!isAbsolute(environment.runnerTemp)) {
    throw new TypeError("RUNNER_TEMPは絶対パスにしてください");
  }
  const expectedPath = join(
    environment.runnerTemp,
    `voicevox-task-tracker-diagnostics-${environment.job}.jsonl`,
  );
  if (resolve(diagnosticsPath) !== expectedPath) {
    throw new TypeError("手動workflowの診断先がjobと一致しません");
  }
  try {
    const source = await stat(diagnosticsPath);
    if (!source.isFile()) {
      throw new TypeError("診断JSONLは通常ファイルにしてください");
    }
  } catch (error: unknown) {
    if (!isFileMissing(error)) {
      throw error;
    }
    if (!hasFailureArtifact) {
      return;
    }
    throw new TypeError("公開失敗artifactに対応する診断JSONLがありません", { cause: error });
  }
  let encryptionError: unknown;
  try {
    await runDiagnosticsCli(
      [
        "encrypt",
        "--input",
        diagnosticsPath,
        "--output",
        join(environment.runnerTemp, `voicevox-task-tracker-diagnostics-${environment.job}.bundle`),
        "--run-id",
        environment.runId,
        "--run-attempt",
        environment.runAttempt,
        "--job",
        environment.job,
        "--invocation-id",
        `daily:${environment.runId}:${environment.runAttempt}:${environment.job}`,
      ],
      process.env,
    );
  } catch (error: unknown) {
    encryptionError = error;
  }
  try {
    await rm(diagnosticsPath);
  } catch (removalError: unknown) {
    if (encryptionError != null) {
      throw new AggregateError(
        [encryptionError, removalError],
        "診断暗号化と平文削除に失敗しました",
        { cause: encryptionError },
      );
    }
    throw removalError;
  }
  if (encryptionError != null) {
    if (encryptionError instanceof Error) {
      throw encryptionError;
    }
    throw new Error("診断暗号化に失敗しました", { cause: encryptionError });
  }
}

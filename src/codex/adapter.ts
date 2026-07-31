import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  CodexAttemptError,
  CodexInvalidJsonError,
  CodexNonZeroExitError,
  CodexProcessStartError,
  CodexResourceError,
  CodexTemporaryWorkspaceError,
  CodexTimeoutError,
} from "./errors.js";
import {
  type CodexAnalysisInput,
  createCodexAnalysisInput,
  serializeCodexAnalysisInput,
} from "./input.js";
import {
  type CodexProcessRequest,
  type CodexProcessResult,
  type CodexProcessRunner,
} from "./process-runner.js";

const CODEX_COMMAND = "codex";
const CODEX_TEMPORARY_DIRECTORY_PREFIX = "voicevox-task-tracker-codex-";
const SYSTEM_PROMPT_URL = new URL("../../prompts/codex-system.md", import.meta.url);
const OUTPUT_SCHEMA_URL = new URL("../../schemas/codex-analysis.schema.json", import.meta.url);
const OUTPUT_LAST_MESSAGE_FILE_NAME = "last-message.json";
const MAX_TIMEOUT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

/** Codex subprocessへ渡すことを許可した環境変数名。 */
export const CODEX_ENVIRONMENT_VARIABLE_ALLOWLIST = ["HOME", "OPENAI_API_KEY", "PATH"] as const;

const codexAdapterConfigurationSchema = z.strictObject({
  model: z.string().min(1, "modelは空にできません"),
  execution: z.strictObject({
    timeoutSeconds: z.number().int().positive().max(MAX_TIMEOUT_SECONDS),
    maxAttempts: z.number().int().positive(),
    sandbox: z.literal("read-only"),
    approvalPolicy: z.literal("never"),
  }),
});

/** Codex adapterのモデルと隔離実行設定。 */
export type CodexAdapterConfiguration = z.output<typeof codexAdapterConfigurationSchema>;

/** Codex adapterへ注入する副作用境界。 */
export type CodexAdapterDependencies = Readonly<{
  environment: NodeJS.ProcessEnv;
  processRunner: CodexProcessRunner;
}>;

type AttemptOutcome =
  | Readonly<{
      success: true;
      value: unknown;
    }>
  | Readonly<{
      success: false;
      error: unknown;
    }>;

function createCodexEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const home = sourceEnvironment["HOME"];
  if (home == null || home.length === 0) {
    throw new TypeError("Codex subprocess用のHOMEがありません");
  }
  const path = sourceEnvironment["PATH"];
  if (path == null || path.length === 0) {
    throw new TypeError("Codex subprocess用のPATHがありません");
  }

  const environment: Record<string, string> = {
    HOME: home,
    PATH: path,
  };
  const openAiApiKey = sourceEnvironment["OPENAI_API_KEY"];
  if (openAiApiKey != null) {
    environment["OPENAI_API_KEY"] = openAiApiKey;
  }
  return environment;
}

async function readFixedSystemPrompt(): Promise<string> {
  try {
    return await readFile(fileURLToPath(SYSTEM_PROMPT_URL), "utf8");
  } catch (error: unknown) {
    throw new CodexResourceError("prompts/codex-system.md", { cause: error });
  }
}

async function assertOutputSchemaIsReadable(): Promise<void> {
  try {
    await access(fileURLToPath(OUTPUT_SCHEMA_URL), constants.R_OK);
  } catch (error: unknown) {
    throw new CodexResourceError("schemas/codex-analysis.schema.json", { cause: error });
  }
}

async function createTemporaryWorkspace(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), CODEX_TEMPORARY_DIRECTORY_PREFIX));
  } catch (error: unknown) {
    throw new CodexTemporaryWorkspaceError("create", { cause: error });
  }
}

function createProcessRequest(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  workingDirectory: string,
): CodexProcessRequest {
  const outputLastMessagePath = join(workingDirectory, OUTPUT_LAST_MESSAGE_FILE_NAME);
  return {
    command: CODEX_COMMAND,
    arguments: [
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--model",
      configuration.model,
      "-s",
      configuration.execution.sandbox,
      "-c",
      `approval_policy="${configuration.execution.approvalPolicy}"`,
      "-C",
      workingDirectory,
      "--output-schema",
      fileURLToPath(OUTPUT_SCHEMA_URL),
      "--output-last-message",
      outputLastMessagePath,
      "--color",
      "never",
      systemPrompt,
    ],
    workingDirectory,
    environment: createCodexEnvironment(dependencies.environment),
    standardInput: inputJson,
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
  };
}

async function runProcess(
  request: CodexProcessRequest,
  processRunner: CodexProcessRunner,
  attempts: number,
): Promise<CodexProcessResult> {
  try {
    return await processRunner(request);
  } catch (error: unknown) {
    throw new CodexProcessStartError(attempts, { cause: error });
  }
}

function assertSuccessfulProcess(
  result: CodexProcessResult,
  request: CodexProcessRequest,
  attempts: number,
): void {
  if (result.timedOut) {
    throw new CodexTimeoutError(attempts, request.timeoutMilliseconds);
  }
  if (result.exitCode !== 0 || result.signal != null) {
    throw new CodexNonZeroExitError(attempts, result.exitCode, result.signal);
  }
}

function createSafeJsonParseCause(error: unknown): Error {
  const errorName = error instanceof Error ? error.name : typeof error;
  return new Error(`Codex最終メッセージのJSON解析に失敗しました。エラー種別: ${errorName}`);
}

async function readLastMessage(request: CodexProcessRequest, attempts: number): Promise<unknown> {
  const outputPathIndex = request.arguments.indexOf("--output-last-message");
  const outputPath = request.arguments.at(outputPathIndex + 1);
  if (outputPathIndex < 0 || outputPath == null) {
    throw new TypeError("Codex CLI引数に最終メッセージの出力先がありません");
  }

  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch (error: unknown) {
    throw new CodexInvalidJsonError(attempts, { cause: error });
  }

  const parseJson: (value: string) => unknown = JSON.parse;
  try {
    return parseJson(source);
  } catch (error: unknown) {
    throw new CodexInvalidJsonError(attempts, {
      cause: createSafeJsonParseCause(error),
    });
  }
}

async function executeAttempt(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  attempts: number,
): Promise<unknown> {
  const workingDirectory = await createTemporaryWorkspace();
  let outcome: AttemptOutcome;
  try {
    const request = createProcessRequest(
      configuration,
      dependencies,
      systemPrompt,
      inputJson,
      workingDirectory,
    );
    const result = await runProcess(request, dependencies.processRunner, attempts);
    assertSuccessfulProcess(result, request, attempts);
    outcome = {
      success: true,
      value: await readLastMessage(request, attempts),
    };
  } catch (error: unknown) {
    outcome = {
      success: false,
      error,
    };
  }

  try {
    await rm(workingDirectory, {
      recursive: true,
      force: true,
    });
  } catch (cleanupError: unknown) {
    const causes = outcome.success ? [cleanupError] : [outcome.error, cleanupError];
    const message = outcome.success
      ? "Codex用の一時作業ディレクトリを削除できませんでした"
      : "Codex実行後に一時作業ディレクトリを削除できませんでした";
    throw new CodexTemporaryWorkspaceError("cleanup", {
      cause: new AggregateError(causes, message),
    });
  }

  if (!outcome.success) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Codexを隔離実行し、最終メッセージをJSON値として返す。 */
export async function executeCodexAnalysis(
  input: CodexAnalysisInput,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<unknown> {
  const configuration = codexAdapterConfigurationSchema.parse({
    model: configurationValue.model,
    execution: configurationValue.execution,
  });
  const validatedInput = createCodexAnalysisInput(input);
  const inputJson = serializeCodexAnalysisInput(validatedInput);
  const systemPrompt = await readFixedSystemPrompt();
  await assertOutputSchemaIsReadable();

  for (let attempts = 1; ; attempts += 1) {
    try {
      return await executeAttempt(configuration, dependencies, systemPrompt, inputJson, attempts);
    } catch (error: unknown) {
      if (!(error instanceof CodexAttemptError)) {
        throw error;
      }
      if (attempts === configuration.execution.maxAttempts) {
        throw error;
      }
    }
  }
}

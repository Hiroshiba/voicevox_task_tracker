import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { serializeCanonicalJson } from "../canonical-json/index.js";
import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import { UnreachableError } from "../util/index.js";
import type {
  CodexAdapterConfiguration,
  CodexAdapterDependencies,
  CodexAuthentication,
} from "./adapter.js";
import {
  CodexInvalidJsonError,
  CodexResourceError,
  CodexTemporaryWorkspaceError,
} from "./errors.js";
import { CODEX_AUTHENTICATION_PREFLIGHT_PROMPT } from "./preflight.js";
import type { CodexApiErrorDiagnostic, CodexProcessRequest } from "./process-runner.js";
import { listCodexSemanticValidationIssueGlossary } from "./semantic-validation-issues.js";

export const CODEX_COMMAND = "codex";
const CODEX_TEMPORARY_DIRECTORY_PREFIX = "voicevox-task-tracker-codex-";
const SYSTEM_PROMPT_URL = new URL("../../prompts/codex-system.md", import.meta.url);
const SEMANTIC_CORRECTION_PROMPT_URL = new URL(
  "../../prompts/codex-semantic-correction.md",
  import.meta.url,
);
const PERSONAL_REMINDER_SYSTEM_PROMPT_URL = new URL(
  "../../prompts/personal-reminder-causes.md",
  import.meta.url,
);
const OUTPUT_LAST_MESSAGE_FILE_NAME = "last-message.json";

/** 認証方式に応じてCodex subprocessへ渡せる環境変数名を返す。 */
export function getCodexEnvironmentVariableAllowlist(
  authentication: CodexAuthentication,
): readonly string[] {
  switch (authentication) {
    case "api-key":
      return Object.freeze(["HOME", "OPENAI_API_KEY", "PATH"]);
    case "auth-json":
      return Object.freeze(["CODEX_HOME", "HOME", "PATH"]);
    default:
      throw new UnreachableError(authentication);
  }
}

/** 認証方式に応じてCodex subprocessへ渡す環境を組み立てる。 */
export function createCodexEnvironment(
  authentication: CodexAuthentication,
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const variableName of getCodexEnvironmentVariableAllowlist(authentication)) {
    const value = sourceEnvironment[variableName];
    if (value == null || value.trim().length === 0) {
      throw new TypeError(`Codex subprocess用の${variableName}がありません`);
    }
    environment[variableName] = value;
  }
  return Object.freeze(environment);
}

async function readFixedPrompt(promptUrl: URL, resource: string): Promise<string> {
  try {
    return await readFile(fileURLToPath(promptUrl), "utf8");
  } catch (error: unknown) {
    throw new CodexResourceError(resource, { cause: error });
  }
}

export async function readFixedSystemPrompt(): Promise<string> {
  return readFixedPrompt(SYSTEM_PROMPT_URL, "prompts/codex-system.md");
}

export async function readFixedSemanticCorrectionPrompt(): Promise<string> {
  return readFixedPrompt(SEMANTIC_CORRECTION_PROMPT_URL, "prompts/codex-semantic-correction.md");
}

export function createSemanticCorrectionSystemPrompt(
  systemPrompt: string,
  correctionPrompt: string,
): string {
  const glossary = serializeCanonicalJson(listCodexSemanticValidationIssueGlossary());
  return `${systemPrompt}\n\n${correctionPrompt}\n\n固定semantic issue glossary:\n${glossary}`;
}

export async function readFixedPersonalReminderPrompt(): Promise<string> {
  return readFixedPrompt(
    PERSONAL_REMINDER_SYSTEM_PROMPT_URL,
    "prompts/personal-reminder-causes.md",
  );
}

export async function writeOutputSchema(
  workingDirectory: string,
  schema: Readonly<Record<string, unknown>>,
  fileName: string,
  resource: string,
): Promise<string> {
  const outputSchemaPath = join(workingDirectory, fileName);
  try {
    await writeFile(outputSchemaPath, `${JSON.stringify(schema)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return outputSchemaPath;
  } catch (error: unknown) {
    throw new CodexResourceError(resource, { cause: error });
  }
}

export async function createTemporaryWorkspace(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), CODEX_TEMPORARY_DIRECTORY_PREFIX));
  } catch (error: unknown) {
    throw new CodexTemporaryWorkspaceError("create", { cause: error });
  }
}

export function createProcessRequest(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  workingDirectory: string,
  outputSchemaPath: string,
): CodexProcessRequest {
  const outputLastMessagePath = join(workingDirectory, OUTPUT_LAST_MESSAGE_FILE_NAME);
  return {
    command: CODEX_COMMAND,
    arguments: [
      "exec",
      "--json",
      "--output-last-message",
      outputLastMessagePath,
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
      "-c",
      `model_reasoning_effort="${configuration.execution.reasoningEffort}"`,
      "-C",
      workingDirectory,
      "--output-schema",
      outputSchemaPath,
      "--color",
      "never",
      systemPrompt,
    ],
    workingDirectory,
    environment: Object.freeze({
      ...createCodexEnvironment(configuration.authentication, dependencies.environment),
      HOME: workingDirectory,
    }),
    standardInput: inputJson,
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
  };
}

export function createAuthenticationPreflightProcessRequest(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  workingDirectory: string,
): CodexProcessRequest {
  return {
    command: CODEX_COMMAND,
    arguments: [
      "exec",
      "--json",
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
      "-c",
      `model_reasoning_effort="${configuration.execution.reasoningEffort}"`,
      "-C",
      workingDirectory,
      "--color",
      "never",
      CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
    ],
    workingDirectory,
    environment: Object.freeze({
      ...createCodexEnvironment(configuration.authentication, dependencies.environment),
      HOME: workingDirectory,
    }),
    standardInput: "",
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
  };
}

function createSafeJsonParseCause(error: unknown): Error {
  const errorName = error instanceof Error ? error.name : typeof error;
  return new Error(`Codex最終メッセージのJSON解析に失敗しました。エラー種別: ${errorName}`, {
    cause: error,
  });
}

export type LastMessageReadResult =
  | Readonly<{
      status: "read";
      source: string;
      value: unknown;
    }>
  | Readonly<{
      status: "read_failed" | "json_parse_failed";
      source: string;
      error: Error;
    }>;

export async function readLastMessage(
  request: CodexProcessRequest,
  attempts: number,
): Promise<LastMessageReadResult> {
  const outputPathIndex = request.arguments.indexOf("--output-last-message");
  const outputPath = request.arguments.at(outputPathIndex + 1);
  if (outputPathIndex < 0 || outputPath == null) {
    throw new TypeError("Codex CLI引数に最終メッセージの出力先がありません");
  }

  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch (error: unknown) {
    return {
      status: "read_failed",
      source: "",
      error: new CodexInvalidJsonError(attempts, { cause: error }),
    };
  }

  const parseJson: (value: string) => unknown = JSON.parse;
  try {
    return {
      status: "read",
      source,
      value: parseJson(source),
    };
  } catch (error: unknown) {
    return {
      status: "json_parse_failed",
      source,
      error: new CodexInvalidJsonError(attempts, {
        cause: createSafeJsonParseCause(error),
      }),
    };
  }
}

const CODEX_API_ERROR_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const codexJsonObjectSchema = z.record(z.string(), z.unknown());
const CODEX_API_ERROR_EVENT_TYPES = new Set(["error", "turn.failed"]);
export const PERMANENT_CODEX_API_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "insufficient_quota",
  "context_length_exceeded",
  "model_not_found",
  "invalid_api_key",
]);

export type CodexStdoutInspection = Readonly<{
  apiError: CodexApiErrorDiagnostic | undefined;
  apiEvents: readonly ("turn.failed" | "error")[];
  parseErrors: readonly Error[];
}>;

function safeApiErrorValue(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 300 &&
    CODEX_API_ERROR_VALUE_PATTERN.test(value)
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  return undefined;
}

function apiErrorValue(
  source: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  return safeApiErrorValue(source[field]);
}

export function mergeCodexApiErrors(
  primary: CodexApiErrorDiagnostic | undefined,
  secondary: CodexApiErrorDiagnostic | undefined,
): CodexApiErrorDiagnostic | undefined {
  if (primary == null) {
    return secondary;
  }
  if (secondary == null) {
    return primary;
  }
  const primaryTypeIsGeneric =
    primary.type != null && CODEX_API_ERROR_EVENT_TYPES.has(primary.type);
  const type = primaryTypeIsGeneric ? (secondary.type ?? primary.type) : primary.type;
  const code = primary.code ?? secondary.code;
  const status = primary.status ?? secondary.status;
  return Object.freeze({
    ...(type == null ? {} : { type }),
    ...(code == null ? {} : { code }),
    ...(status == null ? {} : { status }),
  });
}

export function inspectCodexStdout(source: string): CodexStdoutInspection {
  const apiEvents: ("turn.failed" | "error")[] = [];
  const parseErrors: Error[] = [];
  let apiError: CodexApiErrorDiagnostic | undefined;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      parseErrors.push(
        new Error(`Codex --json stdoutのJSONL解析に失敗しました。行: ${(index + 1).toString()}`, {
          cause: error,
        }),
      );
      continue;
    }
    const objectResult = codexJsonObjectSchema.safeParse(value);
    if (!objectResult.success) {
      continue;
    }
    const eventType = objectResult.data["type"] ?? objectResult.data["event"];
    if (eventType !== "turn.failed" && eventType !== "error") {
      continue;
    }
    apiEvents.push(eventType);
    const nested = codexJsonObjectSchema.safeParse(objectResult.data["error"]);
    const errorObject = nested.success ? nested.data : objectResult.data;
    const type = apiErrorValue(errorObject, "type");
    const code = apiErrorValue(errorObject, "code");
    const status = apiErrorValue(errorObject, "status");
    apiError = mergeCodexApiErrors(
      apiError,
      Object.freeze({
        type: type ?? eventType,
        ...(code == null ? {} : { code }),
        ...(status == null ? {} : { status }),
      }),
    );
  }
  return Object.freeze({
    apiError,
    apiEvents: Object.freeze(apiEvents),
    parseErrors: Object.freeze(parseErrors),
  });
}

export function normalizedProcessOutput(value: string | undefined, name: string): string {
  if (value == null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`Codex process resultの${name}は文字列にしてください`);
  }
  return value;
}

export function safeApiErrorDetails(
  apiError: CodexApiErrorDiagnostic | undefined,
): Readonly<Record<string, DiagnosticsJsonValue>> | undefined {
  if (apiError == null) {
    return undefined;
  }
  const details: Record<string, DiagnosticsJsonValue> = {};
  if (apiError.type != null) {
    details["type"] = apiError.type;
  }
  if (apiError.code != null) {
    details["code"] = apiError.code;
  }
  if (apiError.status != null) {
    details["status"] = apiError.status;
  }
  return Object.freeze(details);
}

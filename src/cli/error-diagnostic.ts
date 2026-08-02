import {
  GitHubGraphQLResponseError,
  GitHubRequestError,
  GitHubResponseSchemaValidationError,
  GitHubRetryExhaustedError,
} from "../github/index.js";
import { CliCodexAuthenticationError, CliCredentialsError, CliExecutableError } from "./errors.js";
import { type RunStage } from "./run-report.js";

const ERROR_CAUSE_DEPTH_LIMIT = 5;
const GRAPHQL_ERROR_DETAIL_LIMIT = 3;
const ZOD_ISSUE_DETAIL_LIMIT = 5;
const DIAGNOSTIC_LENGTH_LIMIT = 1000;
const DIAGNOSTIC_VALUE_LENGTH_LIMIT = 300;
const DIAGNOSTIC_TRUNCATION_MARKER = "truncated=true";
const UNSAFE_DIAGNOSTIC_VALUE_PATTERN = /[\s\p{Cc}]/u;
const UNSAFE_APPROVED_MESSAGE_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const ERROR_SITE_PATTERN = /^[A-Za-z0-9._-]+:[1-9][0-9]*$/u;
const STACK_FRAME_SITE_PATTERN = /[/\\]([A-Za-z0-9._-]+):([1-9][0-9]*)(?::[1-9][0-9]*)?$/u;
const REPOSITORY_CODE_PATH_PATTERN = /(?:^|[/\\])(?:src|dist)[/\\]/u;
const NODE_MODULES_PATH_PATTERN = /(?:^|[/\\])node_modules[/\\]/u;

type DiagnosticField = Readonly<{
  key: string;
  value: string;
}>;

function isSafeDiagnosticValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= DIAGNOSTIC_VALUE_LENGTH_LIMIT &&
    !UNSAFE_DIAGNOSTIC_VALUE_PATTERN.test(value)
  );
}

function encodeApprovedMessage(message: string): string {
  return message.replace(UNSAFE_APPROVED_MESSAGE_PATTERN, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `%u${code}`;
  });
}

function formatDiagnostic(
  fields: readonly DiagnosticField[],
  approvedMessage: string | undefined,
): string {
  const parts = fields
    .filter((field) => isSafeDiagnosticValue(field.value))
    .map((field) => `${field.key}=${field.value}`);
  if (
    approvedMessage != null &&
    approvedMessage.length > 0 &&
    approvedMessage.length <= DIAGNOSTIC_VALUE_LENGTH_LIMIT
  ) {
    parts.push(`message=${approvedMessage}`);
  }
  const diagnostic = parts.join(" ");
  if (diagnostic.length <= DIAGNOSTIC_LENGTH_LIMIT) {
    return diagnostic;
  }
  const truncatedParts: string[] = [];
  let truncatedLength = DIAGNOSTIC_TRUNCATION_MARKER.length;
  for (const part of parts) {
    const nextLength = truncatedLength + part.length + 1;
    if (nextLength > DIAGNOSTIC_LENGTH_LIMIT) {
      break;
    }
    truncatedParts.push(part);
    truncatedLength = nextLength;
  }
  truncatedParts.push(DIAGNOSTIC_TRUNCATION_MARKER);
  return truncatedParts.join(" ");
}

function collectErrorChain(error: unknown): readonly Error[] {
  if (!(error instanceof Error)) {
    return [];
  }
  const chain: Error[] = [];
  const visited = new Set<Error>();
  let current: Error | undefined = error;
  while (current != null && chain.length < ERROR_CAUSE_DEPTH_LIMIT && !visited.has(current)) {
    chain.push(current);
    visited.add(current);
    const cause: unknown = current.cause;
    current = cause instanceof Error ? cause : undefined;
  }
  return chain;
}

function extractStackFrameLocation(frame: string): string | undefined {
  const trimmedFrame = frame.trim();
  if (!trimmedFrame.startsWith("at ")) {
    return undefined;
  }
  const openingParenthesisIndex = trimmedFrame.lastIndexOf("(");
  const locationStart = openingParenthesisIndex >= 0 ? openingParenthesisIndex + 1 : 3;
  const locationEnd = trimmedFrame.endsWith(")") ? trimmedFrame.length - 1 : trimmedFrame.length;
  if (locationStart >= locationEnd) {
    return undefined;
  }
  return trimmedFrame.slice(locationStart, locationEnd);
}

function extractErrorSite(error: Error): string | undefined {
  if (error.stack == null) {
    return undefined;
  }
  for (const frame of error.stack.split("\n")) {
    const location = extractStackFrameLocation(frame);
    if (
      location == null ||
      location.startsWith("node:internal") ||
      NODE_MODULES_PATH_PATTERN.test(location) ||
      !REPOSITORY_CODE_PATH_PATTERN.test(location)
    ) {
      continue;
    }
    const match = STACK_FRAME_SITE_PATTERN.exec(location);
    if (match == null) {
      continue;
    }
    const fileName = match[1];
    const lineNumber = match[2];
    if (fileName == null || lineNumber == null) {
      continue;
    }
    const errorSite = `${fileName}:${lineNumber}`;
    if (ERROR_SITE_PATTERN.test(errorSite)) {
      return errorSite;
    }
  }
  return undefined;
}

function appendErrorSites(fields: DiagnosticField[], chain: readonly Error[]): void {
  for (const [index, error] of chain.entries()) {
    const errorSite = extractErrorSite(error);
    if (errorSite != null) {
      fields.push({ key: `errorSite${index.toString()}`, value: errorSite });
    }
  }
}

function appendGraphQLDiagnostics(
  fields: DiagnosticField[],
  error: GitHubGraphQLResponseError,
): void {
  if (error.operationName != null) {
    fields.push({ key: "operation", value: error.operationName });
  }
  fields.push({ key: "queryHash", value: error.queryHash });
  fields.push({ key: "gqlErrorCount", value: error.errorCount.toString() });
  for (const [index, diagnostic] of error.errors.slice(0, GRAPHQL_ERROR_DETAIL_LIMIT).entries()) {
    const keyPrefix = `gqlError${index.toString()}`;
    if (diagnostic.locations != null && diagnostic.locations.length > 0) {
      fields.push({
        key: `${keyPrefix}Locations`,
        value: diagnostic.locations
          .map(
            (location) => `line:${location.line.toString()},column:${location.column.toString()}`,
          )
          .join(";"),
      });
    }
    if (diagnostic.path != null) {
      fields.push({
        key: `${keyPrefix}Path`,
        value:
          diagnostic.path.length === 0
            ? "$"
            : diagnostic.path.map((component) => component.toString()).join("."),
      });
    }
    if (diagnostic.type != null) {
      fields.push({ key: `${keyPrefix}Type`, value: diagnostic.type });
    }
    if (diagnostic.code != null) {
      fields.push({ key: `${keyPrefix}Code`, value: diagnostic.code });
    }
    if (diagnostic.fieldName != null) {
      fields.push({ key: `${keyPrefix}Field`, value: diagnostic.fieldName });
    }
    if (diagnostic.typeName != null) {
      fields.push({ key: `${keyPrefix}ParentType`, value: diagnostic.typeName });
    }
  }
  const omittedErrorCount = Math.max(0, error.errorCount - GRAPHQL_ERROR_DETAIL_LIMIT);
  if (omittedErrorCount > 0) {
    fields.push({ key: "gqlErrorOmittedCount", value: omittedErrorCount.toString() });
  }
  if (error.requestId != null) {
    fields.push({ key: "requestId", value: error.requestId });
  }
}

function appendZodDiagnostics(
  fields: DiagnosticField[],
  error: GitHubResponseSchemaValidationError,
): void {
  fields.push({ key: "zodIssueCount", value: error.issueCount.toString() });
  for (const [index, issue] of error.issues.slice(0, ZOD_ISSUE_DETAIL_LIMIT).entries()) {
    const keyPrefix = `zodIssue${index.toString()}`;
    fields.push({
      key: `${keyPrefix}Path`,
      value:
        issue.path.length === 0
          ? "$"
          : issue.path.map((component) => component.toString()).join("."),
    });
    fields.push({ key: `${keyPrefix}Code`, value: issue.code });
    if (issue.expected != null) {
      fields.push({ key: `${keyPrefix}Expected`, value: issue.expected });
    }
  }
  const omittedIssueCount = Math.max(0, error.issueCount - ZOD_ISSUE_DETAIL_LIMIT);
  if (omittedIssueCount > 0) {
    fields.push({ key: "zodIssueOmittedCount", value: omittedIssueCount.toString() });
  }
}

function appendKnownErrorDiagnostics(fields: DiagnosticField[], error: Error): void {
  if (error instanceof GitHubGraphQLResponseError) {
    appendGraphQLDiagnostics(fields, error);
  }
  if (error instanceof GitHubResponseSchemaValidationError) {
    appendZodDiagnostics(fields, error);
  }
  if (error instanceof GitHubRequestError || error instanceof GitHubRetryExhaustedError) {
    fields.push({ key: "attempts", value: error.attempts.toString() });
  }
}

function appendFirstHttpStatus(fields: DiagnosticField[], chain: readonly Error[]): void {
  for (const error of chain) {
    if (!(error instanceof GitHubRequestError || error instanceof GitHubRetryExhaustedError)) {
      continue;
    }
    const status = error.status;
    if (status != null && Number.isInteger(status) && status >= 100 && status <= 599) {
      fields.push({ key: "httpStatus", value: status.toString() });
      return;
    }
  }
}

/** 実行失敗から安全な1行の診断文字列を生成する。 */
export function safeErrorDiagnostic(stage: RunStage, error: unknown): string {
  const fields: DiagnosticField[] = [{ key: "stage", value: stage }];
  const chain = collectErrorChain(error);
  fields.push({
    key: "errorType",
    value: chain.length === 0 ? typeof error : chain.map((cause) => cause.name).join("<-"),
  });
  appendErrorSites(fields, chain);
  for (const cause of chain) {
    appendKnownErrorDiagnostics(fields, cause);
  }
  appendFirstHttpStatus(fields, chain);
  const approvedMessage =
    error instanceof CliCodexAuthenticationError ||
    error instanceof CliCredentialsError ||
    error instanceof CliExecutableError
      ? encodeApprovedMessage(error.message)
      : undefined;
  return formatDiagnostic(fields, approvedMessage);
}

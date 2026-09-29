import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";

import { z } from "zod";

import { DiagnosticsError } from "../diagnostics/errors.js";
import { createDiagnosticsRecorder } from "../diagnostics/recorder.js";
import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { UnreachableError } from "../util/index.js";
import { type CliExecutionResult } from "./application.js";
import { notificationActionSchema, parseCliArguments, type CliCommand } from "./command.js";
import { createDefaultCliApplication } from "./composition-root.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import { reportCliFailure } from "./public-failure-boundary.js";
import { NotificationSettlementFailureError } from "./notification-settlement.js";
import { isPublicBoundaryViolation } from "./public-boundary-error.js";
import {
  CliCodexAuthenticationError,
  CliCredentialsError,
  CliExecutableError,
  CliUsageError,
  CliWorkflowArtifactError,
} from "./errors.js";
import { type RunStage } from "./run-report.js";
import { runRuntimeRecoveryEntrypointV1 } from "./runtime-recovery-launcher-v1.js";

const DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE = "VOICEVOX_TASK_TRACKER_DIAGNOSTICS_PATH";

Error.stackTraceLimit = 100;
process.setSourceMapsEnabled(true);

const REPOSITORY_FILTER_SEPARATOR = ",";

type TrackerRunOptionName =
  | "--backfill"
  | "--config"
  | "--notification-action"
  | "--repository-filter"
  | "--report"
  | "--sandbox-context"
  | "--scheduled-for";

const trackerRunOptionsSchema = z.strictObject({
  "--backfill": z.enum(["none", "linked", "all-open"]),
  "--config": z.string().min(1).optional(),
  "--notification-action": notificationActionSchema.optional(),
  "--repository-filter": z.string().min(1).optional(),
  "--report": z.string().min(1).optional(),
  "--sandbox-context": z.string().min(1).optional(),
  "--scheduled-for": z.string().min(1).optional(),
});

type TrackerRunOptions = z.output<typeof trackerRunOptionsSchema>;

function parseTrackerRunOptions(args: readonly string[]): TrackerRunOptions {
  const options: Partial<Record<TrackerRunOptionName, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name !== "--backfill" &&
      name !== "--config" &&
      name !== "--notification-action" &&
      name !== "--repository-filter" &&
      name !== "--report" &&
      name !== "--sandbox-context" &&
      name !== "--scheduled-for"
    ) {
      throw new CliUsageError(`未対応のtracker:run optionです。対象: ${name ?? ""}`, {});
    }
    if (value == null || value.startsWith("--") || value.length === 0) {
      throw new CliUsageError(`${name}には値が必要です`, {});
    }
    if (Object.hasOwn(options, name)) {
      throw new CliUsageError(`${name}は1回だけ指定してください`, {});
    }
    options[name] = value;
  }
  const result = trackerRunOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new CliUsageError("tracker:run optionが不正です", {
      cause: result.error,
    });
  }
  return result.data;
}

function appendOption(
  args: string[],
  options: TrackerRunOptions,
  trackerRunName: TrackerRunOptionName,
  cliName: string,
): void {
  const value = options[trackerRunName];
  if (value != null) {
    args.push(cliName, value);
  }
}

function parseRepositoryFilter(value: string): readonly string[] {
  const repositories = value
    .split(REPOSITORY_FILTER_SEPARATOR)
    .map((repository) => repository.trim());
  if (repositories.some((repository) => repository.length === 0)) {
    throw new CliUsageError("--repository-filterに空のrepositoryは指定できません", {});
  }
  return Object.freeze(repositories);
}

/** workflow向けoptionを日次またはbackfillサブコマンドへ変換する。 */
export function createTrackerRunCliArguments(args: readonly string[]): readonly string[] {
  if (
    args[0] === "collect-analyze" ||
    args[0] === "run-sequential" ||
    args[0] === "run-stage" ||
    args[0] === "route-stage" ||
    args[0] === "persist-state" ||
    args[0] === "build-pages" ||
    args[0] === "prepare-notification-history-pages" ||
    args[0] === "preflight-notification-history-deployment" ||
    args[0] === "record-notification-history-deployment" ||
    args[0] === "preflight-pages-deployment" ||
    args[0] === "record-pages-deployment" ||
    args[0] === "settle-notifications" ||
    args[0] === "finalize-run" ||
    args[0] === "resolve-discord-delivery" ||
    args[0] === "notify-operations" ||
    args[0] === "report-workflow" ||
    args[0] === "verify-state" ||
    args[0] === "verify-checkpoint" ||
    args[0] === "verify-runtime-recovery" ||
    args[0] === "inspect-run-state" ||
    args[0] === "verify-receipt-chain" ||
    args[0] === "report-failure"
  ) {
    const command = parseCliArguments(args);
    if (command.kind !== args[0]) {
      throw new TypeError("workflowサブコマンドの解析結果が一致しません");
    }
    return Object.freeze([...args]);
  }
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze(["help"]);
  }
  if (args.includes("--help")) {
    throw new CliUsageError("--helpは単独で指定してください", {});
  }
  const options = parseTrackerRunOptions(args);
  const backfillMode = options["--backfill"];
  const cliArguments = backfillMode === "none" ? ["daily"] : ["backfill", "--mode", backfillMode];
  appendOption(cliArguments, options, "--config", "--config");
  appendOption(cliArguments, options, "--notification-action", "--notification-action");
  appendOption(cliArguments, options, "--report", "--report");
  appendOption(cliArguments, options, "--sandbox-context", "--sandbox-context");
  appendOption(cliArguments, options, "--scheduled-for", "--scheduled-for");

  const repositoryFilter = options["--repository-filter"];
  if (repositoryFilter != null) {
    if (backfillMode === "none") {
      throw new CliUsageError("--repository-filterはlinkedまたはall-openで指定してください", {});
    }
    for (const repository of parseRepositoryFilter(repositoryFilter)) {
      cliArguments.push("--repository", repository);
    }
  }

  const command = parseCliArguments(cliArguments);
  if (
    (backfillMode === "none" && command.kind !== "daily") ||
    (backfillMode !== "none" && command.kind !== "backfill")
  ) {
    throw new TypeError("tracker:runの変換結果が実行modeと一致しません");
  }
  return Object.freeze(cliArguments);
}

/** workflow向けoptionを検証し、既存CLIの実行境界へ渡す。 */
export async function runTrackerCommand<Result>(
  args: readonly string[],
  runCli: (args: readonly string[]) => Promise<Result>,
): Promise<Result> {
  return runCli(createTrackerRunCliArguments(args));
}

function topLevelDiagnosticStage(command: CliCommand): RunStage | "unknown" {
  switch (command.kind) {
    case "persist-state":
    case "resolve-discord-delivery":
      return "state_persistence";
    case "build-pages":
    case "prepare-notification-history-pages":
    case "preflight-notification-history-deployment":
    case "record-notification-history-deployment":
    case "preflight-pages-deployment":
    case "record-pages-deployment":
      return "pages";
    case "settle-notifications":
    case "notify-operations":
      return "discord";
    case "finalize-run":
      return "state_persistence";
    case "report-workflow":
      return "artifact";
    case "daily":
    case "dry-run":
    case "backfill":
    case "collect-analyze":
    case "run-sequential":
    case "run-stage":
    case "route-stage":
    case "verify-state":
    case "verify-checkpoint":
    case "verify-runtime-recovery":
    case "inspect-run-state":
    case "verify-receipt-chain":
    case "report-failure":
    case "help":
      return "unknown";
    default:
      throw new UnreachableError(command);
  }
}

function writeFailureDiagnostics(result: CliExecutionResult): void {
  if (result.exitCode === 0) {
    return;
  }
  for (const diagnostic of result.result.report.diagnostics) {
    process.stderr.write(`${diagnostic}\n`);
  }
}

function safeTopLevelMessage(error: unknown): string {
  if (
    error instanceof CliCodexAuthenticationError ||
    error instanceof CliUsageError ||
    error instanceof CliCredentialsError ||
    error instanceof CliExecutableError ||
    error instanceof CliWorkflowArtifactError ||
    error instanceof NotificationSettlementFailureError
  ) {
    return error.message;
  }
  return "tracker:runの実行に失敗しました";
}

function isMainModule(moduleUrl: string, executablePath: string | undefined): boolean {
  return executablePath != null && pathToFileURL(executablePath).href === moduleUrl;
}

function writeDiagnosticsTopLevelError(error: unknown): void {
  if (error instanceof DiagnosticsError) {
    process.stderr.write(`${error.message}\n`);
    return;
  }
  process.stderr.write("diagnostics CLIの実行に失敗しました\n");
}

/** tracker-run共通entryからCLIを実行する。 */
export async function runTrackerCliMain(args: readonly string[]): Promise<number> {
  if (process.env["VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V1"] === "1") {
    if (args.length !== 0) {
      throw new TypeError("V1回復entrypointにCLI引数は指定できません");
    }
    const bundleRoot = process.env["VOICEVOX_RUNTIME_BUNDLE_ROOT"];
    if (bundleRoot == null || bundleRoot.length === 0) {
      throw new TypeError("V1回復entrypointのruntime rootがありません");
    }
    await runRuntimeRecoveryEntrypointV1(process.cwd(), bundleRoot);
    return 0;
  }
  if (args[0] === "diagnostics") {
    const { runDiagnosticsCli } = await import("../diagnostics/cli.js");
    return runDiagnosticsCli(args.slice(1), process.env);
  }
  const invocationId = randomUUID();
  let stage: RunStage | "unknown" = "unknown";
  let command = args[0] ?? "unknown";
  let parsedCommand: CliCommand | undefined;
  let recorder: DiagnosticsJsonlRecorder | undefined;
  let result: CliExecutionResult | undefined;
  let failure: unknown;
  try {
    const diagnosticsPath = process.env[DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE];
    if (diagnosticsPath != null) {
      recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    }
    const executionResult = await runTrackerCommand(args, (commandArgs) => {
      parsedCommand = parseCliArguments(commandArgs);
      command = parsedCommand.kind;
      stage = topLevelDiagnosticStage(parsedCommand);
      return createDefaultCliApplication(recorder).run(commandArgs, invocationId);
    });
    result = executionResult;
    writeFailureDiagnostics(executionResult);
    if (executionResult.exitCode !== 0) {
      failure = await reportCliFailure(
        parsedCommand,
        invocationId,
        new Error("追跡runが失敗結果を返しました"),
        executionResult,
        recorder,
      );
    }
  } catch (error: unknown) {
    failure = await reportCliFailure(parsedCommand, invocationId, error, result, recorder);
  } finally {
    if (recorder != null) {
      try {
        await recorder.close();
      } catch (error: unknown) {
        failure =
          failure == null
            ? error
            : new AggregateError([failure, error], "CLI実行と診断recorderのcloseに失敗しました", {
                cause: failure,
              });
      }
    }
  }
  const githubOutputPath = process.env["GITHUB_OUTPUT"];
  if (githubOutputPath != null && command === "collect-analyze") {
    const publicBoundaryConfirmed =
      failure != null
        ? isPublicBoundaryViolation(failure)
        : result?.command === "collect-analyze" &&
          result.result.report.status === "failure" &&
          result.result.report.failureKind === "public_boundary";
    await appendFile(
      githubOutputPath,
      `public_boundary_status=${publicBoundaryConfirmed ? "confirmed" : "not_confirmed"}\n`,
      "utf8",
    );
  }
  if (failure != null) {
    if (
      githubOutputPath != null &&
      command === "settle-notifications" &&
      failure instanceof NotificationSettlementFailureError
    ) {
      const outcome = failure.outcome;
      await appendFile(
        githubOutputPath,
        [
          `notification_settlement_kind=${outcome.kind}`,
          ...(outcome.kind === "structural_failure" || outcome.kind === "state_unconfirmed"
            ? [
                `notification_marker_phase=${outcome.markerPhase}`,
                `notification_failed_operation_effect_certainty=${outcome.kind === "structural_failure" ? outcome.failedOperationEffectCertainty : outcome.effectCertainty}`,
                `notification_cas_outcome=${outcome.casOutcome}`,
                `notification_http_outcome=${outcome.httpOutcome}`,
                `notification_recovery_disposition=${outcome.recoveryDisposition}`,
                `notification_state_revision=${outcome.stateRevision}`,
                ...(outcome.lastReceipt == null
                  ? []
                  : [`notification_last_receipt_digest=${outcome.lastReceipt.receiptDigest}`]),
              ]
            : []),
        ].join("\n") + "\n",
        "utf8",
      );
    }
    if (
      githubOutputPath != null &&
      command !== "collect-analyze" &&
      isPublicBoundaryViolation(failure)
    ) {
      await appendFile(githubOutputPath, "public_boundary_violation=true\n", "utf8");
    }
    process.stderr.write(`${safeTopLevelMessage(failure)}\n`);
    process.stderr.write(`${safeErrorDiagnostic(stage, failure)}\n`);
    return 1;
  }
  if (result == null) {
    throw new Error("CLI実行結果がありません");
  }
  return result.exitCode;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  try {
    process.exitCode = await runTrackerCliMain(args);
  } catch (error: unknown) {
    if (args[0] !== "diagnostics") {
      throw error;
    }
    writeDiagnosticsTopLevelError(error);
    process.exitCode = 1;
  }
}

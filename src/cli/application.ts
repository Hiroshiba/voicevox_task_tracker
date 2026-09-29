import { formatCliUsage, parseCliArguments, type CliCommand } from "./command.js";
import {
  DailyTransactionRunner,
  type DailyRunExecutionResult,
  type DailyTransactionTypeMap,
} from "./daily-transaction.js";
import { StateVerificationRunner } from "./state-verification.js";
import { WorkflowStageRunner } from "./workflow-stage.js";
import { SplitStageRunner } from "./split-stage-runner.js";
import type { DryRunCliCommand } from "./command.js";
import type { CoordinatedRunResult } from "./run-coordinator.js";

/** CLI実行後の終了codeとreport種別。 */
export type CliExecutionResult =
  | Readonly<{
      command: "help";
      exitCode: 0;
    }>
  | Readonly<{
      command:
        "daily" | "dry-run" | "backfill" | "collect-analyze" | "run-sequential" | "run-stage";
      exitCode: 0 | 1;
      execution: "executed" | "deduplicated";
      result: DailyRunExecutionResult;
    }>
  | Readonly<{
      command:
        | "persist-state"
        | "build-pages"
        | "prepare-notification-history-pages"
        | "preflight-notification-history-deployment"
        | "record-notification-history-deployment"
        | "preflight-pages-deployment"
        | "record-pages-deployment"
        | "settle-notifications"
        | "finalize-run"
        | "resolve-discord-delivery"
        | "notify-operations"
        | "report-workflow"
        | "verify-checkpoint"
        | "verify-runtime-recovery"
        | "inspect-run-state"
        | "verify-receipt-chain"
        | "report-failure"
        | "run-stage"
        | "route-stage"
        | "runtime-recovery-v2";
      exitCode: 0;
    }>
  | Readonly<{
      command: "verify-state";
      exitCode: 0;
    }>;

/** CLI applicationへ注入するonline、標準出力境界。 */
export type CliApplicationDependencies<Types extends DailyTransactionTypeMap> = Readonly<{
  dailyRunner: DailyTransactionRunner<Types>;
  runDryRun: (
    command: DryRunCliCommand,
    invocationId: string,
  ) => Promise<CoordinatedRunResult<DailyRunExecutionResult>>;
  splitStageRunner: SplitStageRunner;
  workflowStageRunner: WorkflowStageRunner;
  stateVerificationRunner: StateVerificationRunner;
  writeStandardOutput: (source: string) => Promise<void>;
}>;

function exitCodeForStatus(status: "success" | "fallback" | "failure"): 0 | 1 {
  return status === "failure" ? 1 : 0;
}

/** 検証済みサブコマンドを対応する実行器へ振り分ける。 */
export class CliApplication<Types extends DailyTransactionTypeMap> {
  readonly #dependencies: CliApplicationDependencies<Types>;

  public constructor(dependencies: CliApplicationDependencies<Types>) {
    this.#dependencies = dependencies;
  }

  async #runCommand(command: CliCommand, invocationId: string): Promise<CliExecutionResult> {
    switch (command.kind) {
      case "help":
        await this.#dependencies.writeStandardOutput(`${formatCliUsage()}\n`);
        return Object.freeze({
          command: "help",
          exitCode: 0,
        });
      case "daily":
      case "backfill":
      case "run-sequential":
      case "collect-analyze": {
        const coordinated = await this.#dependencies.dailyRunner.run(command, invocationId);
        return Object.freeze({
          command: command.kind,
          exitCode: exitCodeForStatus(coordinated.value.report.status),
          execution: coordinated.execution,
          result: coordinated.value,
        });
      }
      case "dry-run": {
        const coordinated = await this.#dependencies.runDryRun(command, invocationId);
        return Object.freeze({
          command: command.kind,
          exitCode: exitCodeForStatus(coordinated.value.report.status),
          execution: coordinated.execution,
          result: coordinated.value,
        });
      }
      case "run-stage": {
        const outcome = await this.#dependencies.splitStageRunner.run(command, invocationId);
        if (outcome.result != null) {
          return Object.freeze({
            command: "run-stage",
            exitCode: exitCodeForStatus(outcome.result.report.status),
            execution: "executed",
            result: outcome.result,
          });
        }
        return Object.freeze({ command: "run-stage", exitCode: 0 });
      }
      case "route-stage":
        await this.#dependencies.splitStageRunner.route(command, invocationId);
        return Object.freeze({ command: "route-stage", exitCode: 0 });
      case "runtime-recovery-v2":
        await this.#dependencies.splitStageRunner.recover(command, invocationId);
        return Object.freeze({ command: "runtime-recovery-v2", exitCode: 0 });
      case "persist-state":
      case "build-pages":
      case "prepare-notification-history-pages":
      case "preflight-notification-history-deployment":
      case "record-notification-history-deployment":
      case "preflight-pages-deployment":
      case "record-pages-deployment":
      case "settle-notifications":
      case "finalize-run":
      case "resolve-discord-delivery":
      case "notify-operations":
      case "report-workflow":
      case "verify-checkpoint":
      case "verify-runtime-recovery":
      case "inspect-run-state":
      case "verify-receipt-chain":
      case "report-failure":
        await this.#dependencies.workflowStageRunner.run(command);
        return Object.freeze({
          command: command.kind,
          exitCode: 0,
        });
      case "verify-state":
        await this.#dependencies.stateVerificationRunner.run(command);
        return Object.freeze({
          command: command.kind,
          exitCode: 0,
        });
    }
  }

  /** process argv相当の配列を解析して一つのサブコマンドを実行する。 */
  public async run(args: readonly string[], invocationId: string): Promise<CliExecutionResult> {
    return this.#runCommand(parseCliArguments(args), invocationId);
  }
}

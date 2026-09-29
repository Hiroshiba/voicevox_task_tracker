import { CliApplication } from "../application.js";
import { DailyTransactionRunner } from "../daily-transaction.js";
import { StateVerificationRunner } from "../state-verification.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";
import type { ProductionTypes } from "./contracts.js";
import { createDailyDependencies } from "./daily-dependencies.js";
import { createWorkflowStageRunner } from "./workflow/create-runner.js";
import { SplitStageRunner } from "../split-stage-runner.js";
import { runIsolatedDryRun } from "../dry-run-runtime.js";

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createProductionCliApplication(
  adapters: ProductionRuntimeAdapters,
): CliApplication<ProductionTypes> {
  const dailyRunner = new DailyTransactionRunner<ProductionTypes>(
    createDailyDependencies(adapters),
    {
      now: adapters.now,
    },
  );
  return new CliApplication({
    dailyRunner,
    runDryRun: (command, invocationId) => runIsolatedDryRun(adapters, command, invocationId),
    splitStageRunner: new SplitStageRunner(adapters, dailyRunner),
    workflowStageRunner: createWorkflowStageRunner(adapters),
    stateVerificationRunner: new StateVerificationRunner({
      repositoryPath: adapters.repositoryPath,
      loadConfig: adapters.loadConfig,
      verifyStateDirectory: adapters.verifyStateDirectory,
      writeStandardOutput: adapters.writeStandardOutput,
    }),
    writeStandardOutput: adapters.writeStandardOutput,
  });
}

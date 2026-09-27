import { planGenericAi } from "../../../application/tracking-run/stages/generic-ai-plan.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { CodexRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { createGenericAiPlanningPort } from "./planning-source.js";
import { analyzeCodex } from "./execution.js";

/** 決定論的な判定から汎用AIの入力と選択を確定する。 */
export function createPlanGenericAiStage(
  adapters: CodexRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["planGenericAi"] {
  return async ({ invocation, configuration, state, deterministicallyAnalyzed }) => {
    const diagnostics =
      adapters.diagnosticsRecorder == null
        ? undefined
        : Object.freeze({
            recorder: adapters.diagnosticsRecorder,
            runId: invocation.runId,
            invocationId: invocation.invocationId,
            stage: "codex_analysis",
          });
    return planGenericAi(
      deterministicallyAnalyzed,
      createGenericAiPlanningPort(configuration, state, diagnostics),
    );
  };
}

/** 確定済みの汎用AI計画を既存実行器へ渡す。 */
export function createAnalyzeWithCodexStage(
  adapters: CodexRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["analyzeWithCodex"] {
  return async ({ invocation, configuration, state, genericAiPlanned }) => {
    const analysis = await analyzeCodex(
      adapters,
      invocation,
      configuration,
      state,
      genericAiPlanned,
    );
    return Object.freeze({
      status: analysis.status,
      value: analysis.stage,
      aiCallCount: analysis.aiCallCount,
      aiCacheHitCount: analysis.aiCacheHitCount,
      aiRetainedResultCount: analysis.aiRetainedResultCount,
      estimatedInputTokens: analysis.estimatedInputTokens,
      diagnostics: analysis.diagnostics,
    });
  };
}

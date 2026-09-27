import {
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  validateCodexElementOutputSchema,
  type SchemaValidCodexElementOutput,
} from "../../../codex/index.js";
import type { AiAnalysisElementMigrationResult } from "../../../domain/ai-analysis-elements.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../../application/tracking-run/stages/deterministic-item.js";
import { aiAnalysisRunIndex } from "../ai-analysis-run-index.js";
import type { CodexAnalysis } from "../contracts.js";

export type ConsumerCodexElementOutput = Readonly<{
  schemaVersion: typeof CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION;
  item: Readonly<{ nodeId: string; url: string }>;
  status?: AiAnalysisElementMigrationResult<"status"> | undefined;
  waitingOn?: AiAnalysisElementMigrationResult<"waitingOn"> | undefined;
  nextAction?: AiAnalysisElementMigrationResult<"nextAction"> | undefined;
  relations?: AiAnalysisElementMigrationResult<"relations"> | undefined;
  progress?: AiAnalysisElementMigrationResult<"progress"> | undefined;
  importance?: AiAnalysisElementMigrationResult<"importance"> | undefined;
  deadline?: AiAnalysisElementMigrationResult<"deadline"> | undefined;
  notification?: AiAnalysisElementMigrationResult<"notification"> | undefined;
  selfCommitment?: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
}>;

export function codexOutputForAnalysis(
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): SchemaValidCodexElementOutput | undefined {
  const result = aiAnalysisRunIndex(codexAnalysis.run).resultByNodeId.get(analysis.item.nodeId);
  if (result == null) {
    return undefined;
  }
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
  const output: Record<string, unknown> = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  for (const element of result.elements) {
    output[element.element] = element.generation.result;
  }
  return validateCodexElementOutputSchema(output, input.selectedElements);
}

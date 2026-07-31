import { type CodexAnalysisInput } from "./input.js";
import { type ValidatedCodexAnalysisOutput } from "./output-types.js";
import { validateCodexAnalysisSchema } from "./schema-validation.js";
import { validateCodexAnalysisSemantics } from "./semantic-validation.js";

/** JSON Schema検証後にsemantic検証を行い、reducer用のCodex出力を返す。 */
export function validateCodexAnalysisOutput(
  value: unknown,
  input: CodexAnalysisInput,
): ValidatedCodexAnalysisOutput {
  const schemaValidOutput = validateCodexAnalysisSchema(value);
  return validateCodexAnalysisSemantics(schemaValidOutput, input);
}

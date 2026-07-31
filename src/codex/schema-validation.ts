import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import codexAnalysisSchema from "../../schemas/codex-analysis.schema.json" with { type: "json" };
import { CodexOutputSchemaValidationError, type CodexOutputValidationIssue } from "./errors.js";
import { type SchemaValidCodexAnalysisOutput } from "./output-types.js";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
const validateSchema = ajv.compile<SchemaValidCodexAnalysisOutput>(codexAnalysisSchema);

function schemaIssueMessage(keyword: string): string {
  switch (keyword) {
    case "additionalProperties":
      return "許可されていないプロパティがあります";
    case "const":
      return "固定値と一致しません";
    case "enum":
      return "許可された値ではありません";
    case "maxItems":
      return "配列の要素数が上限を超えています";
    case "maxLength":
      return "文字列が長すぎます";
    case "maximum":
      return "数値が上限を超えています";
    case "minItems":
      return "配列の要素数が不足しています";
    case "minLength":
      return "文字列が短すぎます";
    case "minimum":
      return "数値が下限を下回っています";
    case "pattern":
      return "文字列の形式が契約と一致しません";
    case "required":
      return "必須プロパティがありません";
    case "type":
      return "値の型が契約と一致しません";
    case "uniqueItems":
      return "配列に重複があります";
    default:
      return "JSON Schemaの制約に適合しません";
  }
}

function createSchemaIssues(errors: readonly ErrorObject[]): readonly CodexOutputValidationIssue[] {
  return Object.freeze(
    errors.map((error) =>
      Object.freeze({
        path: error.instancePath.length === 0 ? "$" : error.instancePath,
        code: error.keyword,
        message: schemaIssueMessage(error.keyword),
      }),
    ),
  );
}

/** repositoryのJSON Schema自体を使ってCodex出力を検証する。 */
export function validateCodexAnalysisSchema(value: unknown): SchemaValidCodexAnalysisOutput {
  if (!validateSchema(value)) {
    if (validateSchema.errors == null) {
      throw new TypeError("JSON Schema検証が失敗しましたが検証問題を取得できません");
    }
    throw new CodexOutputSchemaValidationError(createSchemaIssues(validateSchema.errors));
  }
  return value;
}

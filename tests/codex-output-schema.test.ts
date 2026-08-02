import { describe, expect, it } from "vitest";

import codexAnalysisSchema from "../schemas/codex-analysis.schema.json" with { type: "json" };

const supportedStructuredOutputKeywords = new Set([
  "$id",
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

type SchemaVisitor = (schema: Readonly<Record<string, unknown>>, path: string) => void;

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function requireJsonObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isJsonObject(value)) {
    throw new TypeError(`JSON Schemaのobjectが必要です。対象: ${path}`);
  }
  return value;
}

function visitSchema(value: unknown, path: string, visitor: SchemaVisitor): void {
  const schema = requireJsonObject(value, path);
  visitor(schema, path);

  const properties = schema["properties"];
  if (properties != null) {
    for (const [propertyName, propertySchema] of Object.entries(
      requireJsonObject(properties, `${path}.properties`),
    )) {
      visitSchema(propertySchema, `${path}.properties.${propertyName}`, visitor);
    }
  }

  const items = schema["items"];
  if (items != null) {
    visitSchema(items, `${path}.items`, visitor);
  }

  const anyOf = schema["anyOf"];
  if (anyOf != null) {
    if (!Array.isArray(anyOf)) {
      throw new TypeError(`JSON SchemaのanyOfが配列ではありません。対象: ${path}.anyOf`);
    }
    for (const [index, nestedSchema] of anyOf.entries()) {
      visitSchema(nestedSchema, `${path}.anyOf.${index.toString()}`, visitor);
    }
  }
}

describe("Codex structured output schema", () => {
  it("すべてのpropertyにtypeを指定する", () => {
    const propertyPathsWithoutType: string[] = [];

    visitSchema(codexAnalysisSchema, "$", (schema, path) => {
      const properties = schema["properties"];
      if (properties == null) {
        return;
      }
      for (const [propertyName, propertySchema] of Object.entries(
        requireJsonObject(properties, `${path}.properties`),
      )) {
        if (!Object.hasOwn(requireJsonObject(propertySchema, propertyName), "type")) {
          propertyPathsWithoutType.push(`${path}.properties.${propertyName}`);
        }
      }
    });

    expect(propertyPathsWithoutType).toEqual([]);
  });

  it("structured output非対応keywordを含まない", () => {
    const unsupportedKeywordPaths: string[] = [];

    visitSchema(codexAnalysisSchema, "$", (schema, path) => {
      for (const keyword of Object.keys(schema)) {
        if (!supportedStructuredOutputKeywords.has(keyword)) {
          unsupportedKeywordPaths.push(`${path}.${keyword}`);
        }
      }
    });

    expect(unsupportedKeywordPaths).toEqual([]);
  });

  it("すべてのobjectで全propertyを必須にし追加propertyを禁止する", () => {
    const invalidObjectSchemaPaths: string[] = [];

    visitSchema(codexAnalysisSchema, "$", (schema, path) => {
      if (schema["type"] !== "object") {
        return;
      }
      const propertyNames = Object.keys(
        requireJsonObject(schema["properties"], `${path}.properties`),
      );
      const required = schema["required"];
      if (
        !Array.isArray(required) ||
        !required.every((propertyName) => typeof propertyName === "string") ||
        [...required].sort().join("\n") !== propertyNames.sort().join("\n") ||
        schema["additionalProperties"] !== false
      ) {
        invalidObjectSchemaPaths.push(path);
      }
    });

    expect(invalidObjectSchemaPaths).toEqual([]);
  });
});

import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

import { ConfigError, type ConfigIssue } from "./config-error.js";
import { type Config, validateConfig } from "./schema.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";

type YamlParseResult =
  | Readonly<{
      success: true;
      value: unknown;
    }>
  | Readonly<{
      success: false;
      issues: readonly ConfigIssue[];
      cause: unknown;
    }>;

function parseYaml(source: string): YamlParseResult {
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    const firstError = document.errors.at(0);
    assertNonNullable(firstError, "YAMLエラーの原因を取得できませんでした");
    return {
      success: false,
      issues: document.errors.map((error) => ({
        path: "YAML",
        message: `YAMLの構文が不正です。エラーコードは${error.code}です`,
      })),
      cause: firstError,
    };
  }

  try {
    return {
      success: true,
      value: document.toJS(),
    };
  } catch (error: unknown) {
    return {
      success: false,
      issues: [
        {
          path: "YAML",
          message: "YAMLの参照を安全に展開できません",
        },
      ],
      cause: error,
    };
  }
}

/** YAML文字列を型付き設定として読み込む。 */
export function parseConfig(source: string): Config {
  const parsed = parseYaml(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.issues, { cause: parsed.cause });
  }
  return validateConfig(parsed.value);
}

/** YAML設定ファイルを型付き設定として読み込む。 */
export async function loadConfig(configPath: string | URL): Promise<Config> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    throw new ConfigError(
      [
        {
          path: String(configPath),
          message: "設定ファイルを読み込めません",
        },
      ],
      { cause: error },
    );
  }
  return parseConfig(source);
}

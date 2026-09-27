import eslint from "@eslint/js";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import {
  SOURCE_LINE_ESLINT_GLOBS,
  SOURCE_LINE_PERMANENT_EXCLUSIONS,
} from "./config/source-line-policy.mjs";

const sourceLineBaseline = JSON.parse(
  readFileSync("config/refactor-source-line-baseline.json", "utf8"),
);

const productionRuntimeStageDirectories = [
  "ai-dependencies",
  "daily-startup",
  "collection",
  "deterministic",
  "codex",
  "reduction",
  "graph",
  "personal-reminder",
  "validation",
  "publication",
  "workflow",
];

const pureLeafImportPaths = [
  "canonical-json/sha256-hex.js",
  "canonical-json/sha256.js",
  "canonical-json/value.js",
  "codex/analysis-elements.js",
  "codex/analysis-element-dependencies.js",
  "codex/analysis-selection.js",
  "codex/backend-version.js",
  "codex/budget.js",
  "codex/element-planning.js",
  "codex/generic-ai-definition.js",
  "codex/input.js",
  "codex/semantic-validation-issues.js",
  "github/errors.js",
  "github/incremental-item-collection.js",
  "github/item-detail-types.js",
  "github/item-normalization.js",
  "github/public-repository-allowlist.js",
  "github/stable-id.js",
];
const typeOnlyLeafImportPaths = ["github/item-enumeration.js"];
const pureLeafImportPattern = pureLeafImportPaths
  .concat(typeOnlyLeafImportPaths)
  .map((path) => path.replaceAll(".", "\\."))
  .join("|");
const typeOnlyLeafImportPattern = typeOnlyLeafImportPaths
  .map((path) => path.replaceAll(".", "\\."))
  .join("|");
const restrictedModulePattern = `(?:^|/)(?!(?:${pureLeafImportPattern})$)(?:canonical-json|codex|persistence|pages|discord|github)(?:/|$)`;

const nullComparisonRestrictions = [
  {
    selector: "BinaryExpression[operator='==='] > Literal[value=null]",
    message: "nullとの比較には==を使ってください",
  },
  {
    selector: "BinaryExpression[operator='!=='] > Literal[value=null]",
    message: "nullとの比較には!=を使ってください",
  },
  {
    selector: "BinaryExpression[operator='==='] > Identifier[name='undefined']",
    message: "nullまたはundefinedとの比較には== nullを使ってください",
  },
  {
    selector: "BinaryExpression[operator='!=='] > Identifier[name='undefined']",
    message: "nullまたはundefinedとの比較には!= nullを使ってください",
  },
];
const restrictedImportSyntax = [
  {
    selector: "ImportExpression",
    message: "この層では動的importを使わず、許可されたleaf moduleを静的に参照してください",
  },
  {
    selector: "TSImportType",
    message: "この層ではimport型を使わず、許可されたleaf moduleを静的に参照してください",
  },
];

export default defineConfig([
  {
    ignores: SOURCE_LINE_PERMANENT_EXCLUSIONS,
  },
  {
    files: ["**/*.{cjs,js,mjs}"],
    extends: [eslint.configs.recommended, eslintConfigPrettier],
  },
  {
    files: ["**/*.{cts,mts,ts,tsx}"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      eslintConfigPrettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "never",
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-restricted-syntax": ["error", ...nullComparisonRestrictions],
    },
  },
  {
    files: SOURCE_LINE_ESLINT_GLOBS,
    rules: {
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: [
      "src/application/**/*.{ts,tsx}",
      "src/domain/**/*.{ts,tsx}",
      "src/graph/**/*.{ts,tsx}",
      "src/canonical-json/{value,sha256,sha256-hex}.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...nullComparisonRestrictions, ...restrictedImportSyntax],
    },
  },
  {
    files: ["src/application/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules
            .filter((moduleName) => !moduleName.startsWith("node:"))
            .map((name) => ({ name, message: "applicationはNode.jsへ依存しないでください" })),
          patterns: [
            {
              group: ["node:*", "**/cli/**", "**/infrastructure/**"],
              message: "applicationは実行環境へ依存しないでください",
            },
            {
              regex: restrictedModulePattern,
              message: "applicationは許可されたpure leaf moduleだけを参照してください",
            },
            {
              regex: `(?:^|/)(?:${typeOnlyLeafImportPattern})$`,
              allowTypeImports: true,
              message: "applicationは列挙moduleを型としてだけ参照してください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "applicationから外部接続を直接行わないでください" },
        { name: "process", message: "applicationから実行環境を直接参照しないでください" },
      ],
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}", "src/graph/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules
            .filter((name) => name !== "path" && name !== "node:path")
            .flatMap((name) => (name.startsWith("node:") ? [name] : [name, `node:${name}`]))
            .map((name) => ({
              name,
              message: "domainとgraphはNode.jsの実行環境へ依存しないでください",
            })),
          patterns: [
            {
              group: ["**/application/**", "**/infrastructure/**", "**/cli/**"],
              message: "domainとgraphは上位層へ依存しないでください",
            },
            {
              regex: restrictedModulePattern,
              message: "domainとgraphは許可されたpure leaf moduleだけを参照してください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "domainとgraphから外部接続を行わないでください" },
        { name: "process", message: "domainとgraphから実行環境を参照しないでください" },
      ],
    },
  },
  {
    files: ["src/pages/**/*.{ts,tsx}", "src/discord/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cli/**"],
              message: "PagesとDiscordからCLIを参照しないでください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/canonical-json/{value,sha256,sha256-hex}.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules
            .filter((moduleName) => !moduleName.startsWith("node:"))
            .map((name) => ({
              name,
              message: "canonical JSON leafはNode.jsの組み込みモジュールへ依存しないでください",
            })),
          patterns: [
            {
              group: [
                "node:*",
                "**/application/**",
                "**/infrastructure/**",
                "**/cli/**",
                "**/codex/**",
                "**/persistence/**",
                "**/pages/**",
                "**/discord/**",
                "**/github/**",
                "./index",
                "./index.*",
                "**/canonical-json/index",
                "**/canonical-json/index.*",
              ],
              message: "canonical JSON leafは実行環境や副作用を参照しないでください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/personal-reminder/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules
            .filter((moduleName) => !moduleName.startsWith("node:"))
            .map((name) => ({
              name,
              message: "個人催促の解析はNode.jsの組み込みモジュールを参照しないでください",
            })),
          patterns: [
            {
              group: [
                "node:*",
                "**/production-runtime*",
                "**/persistence/**",
                "**/pages/**",
                "**/discord/**",
                "./index",
                "./index.*",
                "../personal-reminder/index",
                "../personal-reminder/index.*",
              ],
              message:
                "個人催促の解析は実行環境や副作用を参照せず、実装間は所有元を直接参照してください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/production-runtime.ts"],
    rules: {
      "max-lines": ["error", { max: 150, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: ["src/cli/production-runtime/**/*.ts"],
    ignores: [
      "src/cli/production-runtime/adapters.ts",
      "src/cli/production-runtime/clock.ts",
      "src/cli/production-runtime/contracts.ts",
      "src/cli/production-runtime/create-application.ts",
      "src/cli/production-runtime/daily-dependencies.ts",
      "src/cli/production-runtime/previous-state/**/*.ts",
      "src/cli/production-runtime/workflow/create-runner.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "fs",
            "fs/promises",
            "child_process",
            "node:fs",
            "node:fs/promises",
            "node:child_process",
          ].map((name) => ({
            name,
            message: "段階実装ではファイルシステムや子プロセスを直接使わないでください",
          })),
          patterns: [
            {
              group: [
                "**/production-runtime",
                "**/production-runtime.js",
                "**/production-runtime.ts",
                "**/create-application",
                "**/create-application.js",
                "**/create-application.ts",
                "**/daily-dependencies",
                "**/daily-dependencies.js",
                "**/daily-dependencies.ts",
                "**/workflow/create-runner",
                "**/workflow/create-runner.js",
                "**/workflow/create-runner.ts",
                "./create-runner",
                "./create-runner.js",
                "./create-runner.ts",
              ],
              message: "段階実装から公開ファサードや実行組み立てを参照しないでください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "段階実装ではglobal fetchを使わないでください" },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "段階実装ではprocess.envを参照しないでください",
        },
      ],
    },
  },
  {
    files: [
      "src/cli/production-runtime/adapters.ts",
      "src/cli/production-runtime/clock.ts",
      "src/cli/production-runtime/contracts.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: productionRuntimeStageDirectories.map((directory) => `./${directory}/**`),
              message: "横断契約から段階実装を参照しないでください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/production-runtime/previous-state/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: productionRuntimeStageDirectories.map((directory) => `../${directory}/**`),
              message: "前回状態から段階実装を参照しないでください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/run-publication/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/production-runtime",
                "**/production-runtime.js",
                "**/production-runtime.ts",
                "**/production-runtime/**",
              ],
              message: "公開処理からproduction-runtimeを参照しないでください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "公開処理ではglobal fetchを使わないでください" },
        { name: "process", message: "公開処理ではglobal processを使わないでください" },
      ],
    },
  },
  {
    files: sourceLineBaseline.entries.map((entry) => entry.path),
    rules: {
      "max-lines": "off",
    },
  },
]);

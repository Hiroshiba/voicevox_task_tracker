import { resolve } from "node:path";

import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { CodexAttemptBudget } from "../../../codex/index.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import { inspectRunBootstrapState } from "../../../infrastructure/tracking-run/bootstrap-state.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  assertCodexRuntimeReady,
  readRuntimeCredentials,
  resolveRuntimeTarget,
} from "../../production-runtime-setup.js";
import type { ConfigurationRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;

/** AI実行試行数の読取段階を接続する。 */
export function createReadAiProcessAttemptCountStage(): ProductionDailyDependencies["readAiProcessAttemptCount"] {
  return (configuration) => configuration.codexAttemptBudget.attemptCount;
}

/** 実行設定の検証段階を既存adapterへ接続する。 */
export function createValidateConfigurationStage(
  adapters: ConfigurationRuntimeAdapters,
): ProductionDailyDependencies["validateConfiguration"] {
  return async ({ request }) => {
    const config = await adapters.loadConfig(resolve(adapters.repositoryPath, request.configPath));
    const target = await resolveRuntimeTarget(
      Object.freeze({
        repositoryPath: adapters.repositoryPath,
        ...(adapters.readSandboxContext == null
          ? {}
          : { readSandboxContext: adapters.readSandboxContext }),
        createStateBranchAdapter: adapters.createStateBranchAdapter,
      }),
      config,
      request,
    );
    const bootstrap = await inspectRunBootstrapState(
      adapters.createStateBranchAdapter(),
      target.state.branch,
      { kind: "start_new" },
    );
    if (bootstrap.kind === "manual_resolution_required") {
      throw new TypeError("state bootstrapが不整合のため手動解決が必要です", {
        cause: bootstrap.cause,
      });
    }
    if (bootstrap.kind === "resume_with_exact_runtime") {
      throw new TypeError("未完了runは元のruntimeによる再開が必要です");
    }
    if (bootstrap.kind === "operator_conflict_resolution") {
      throw new TypeError("state bootstrapのrunが起動要求と一致しません");
    }
    const credentials = readRuntimeCredentials(adapters.environment, config, request);
    let codexReadinessPromise: Promise<void> | undefined;
    const ensureCodexReady = (): Promise<void> => {
      const codexCredentials = credentials.codex;
      if (!codexCredentials.enabled) {
        throw new TypeError("AIが有効ですがCodex認証情報がありません");
      }
      codexReadinessPromise ??= assertCodexRuntimeReady(
        Object.freeze({
          repositoryPath: adapters.repositoryPath,
          codexProcessRunner: adapters.codexProcessRunner,
        }),
        codexCredentials,
      );
      return codexReadinessPromise;
    };
    return Object.freeze({
      config,
      configDigest: nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)),
      baseStateHead: bootstrap.observedStateHead,
      credentials,
      target,
      ensureCodexReady,
      codexAttemptBudget: new CodexAttemptBudget(config.ai.budget.maxCodexExecAttemptsPerRun),
    });
  };
}

import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import { GitHubRetryExhaustedError } from "../github/index.js";
import type {
  RunIdentity,
  RunRequest,
  RunExecutionPolicy,
} from "../application/tracking-run/request.js";
import type {
  PreparedBaseStateShape,
  PreparedRun,
} from "../application/tracking-run/prepare-run.js";
import type { InventoryCollectedRun } from "../application/tracking-run/stages/inventory.js";
import type { CollectedRun } from "../application/tracking-run/stages/collection.js";
import type { RunEvaluatedAt } from "../application/tracking-run/contracts/evaluation-time.js";
import type { DeterministicallyAnalyzedRun } from "../application/tracking-run/stages/deterministic.js";
import {
  StateFormatError,
  StatePersonalReminderAiDependencyMismatchError,
} from "../persistence/index.js";
import {
  type BackfillCliCommand,
  type CollectAnalyzeCliCommand,
  type DailyCliCommand,
  type DryRunCliCommand,
} from "./command.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import { RunCoordinator, type CoordinatedRunResult } from "./run-coordinator.js";
import { createRunIdentity } from "./tracking-run/identity.js";
import { projectLegacyDailyInvocation } from "./tracking-run/migration-bridge/legacy-invocation.js";
import { projectPreparedLegacyDailyInvocation } from "./tracking-run/migration-bridge/legacy-invocation.js";
import { parseRunRequest } from "./tracking-run/parse-request.js";
import {
  createEmptyRunMetrics,
  createRunReport,
  type RunMetrics,
  type RunReport,
  type RunStage,
} from "./run-report.js";

/** ネットワークを利用する日次transaction系のサブコマンド。 */
export type OnlineCliCommand =
  DailyCliCommand | DryRunCliCommand | BackfillCliCommand | CollectAnalyzeCliCommand;

/** 各段階を型安全につなぐために利用する値の対応表。 */
export type DailyTransactionTypeMap = Readonly<{
  configuration: unknown;
  state: unknown;
  prepared: PreparedRun<PreparedBaseStateShape>;
  inventoryCollected: InventoryCollectedRun<PreparedBaseStateShape>;
  collectedRun: CollectedRun<PreparedBaseStateShape, Readonly<{ evaluatedAt: RunEvaluatedAt }>>;
  deterministicallyAnalyzed: DeterministicallyAnalyzedRun<PreparedBaseStateShape>;
  repositoryInventory: unknown;
  collection: unknown;
  codexAnalysis: unknown;
  reduction: unknown;
  graph: unknown;
  personalReminderAnalysis: unknown;
  validated: unknown;
  persisted: unknown;
  pages: unknown;
  discord: unknown;
}>;

/** run内の全段階へ渡す安定した識別情報。 */
export type DailyRunInvocation = Readonly<{
  runId: string;
  invocationId: string;
  executionPolicy: RunExecutionPolicy;
  command: OnlineCliCommand;
  scheduledFor: UtcIsoDateTime;
  startedAt: UtcIsoDateTime;
}>;

/** Codex段階の値、縮退状態、予算指標。 */
export type CodexAnalysisStageResult<Value> = Readonly<{
  status: "success" | "fallback";
  value: Value;
  aiCallCount: number;
  aiCacheHitCount: number;
  aiRetainedResultCount: number;
  estimatedInputTokens: number;
  diagnostics: readonly string[];
}>;

/** graph解析段階の値とactive edge数。 */
export type GraphAnalysisStageResult<Value> = Readonly<{
  value: Value;
  activeEdgeCount: number;
}>;

/** 個人催促原因解析段階の値、縮退状態、累積AI指標。 */
export type PersonalReminderAnalysisStageResult<Value> = Readonly<{
  status: "success" | "fallback";
  value: Value;
  aiCallCount: number;
  estimatedInputTokens: number;
  personalReminderCauseCount: number;
  personalReminderAiCallCount: number;
  personalReminderAiCacheHitCount: number;
  personalReminderAssessmentReuseCount: number;
  personalReminderUnknownCount: number;
  personalReminderFailedCount: number;
  personalReminderDeferredCount: number;
  personalReminderNotEvaluatedCount: number;
  diagnostics: readonly string[];
}>;

/** 公開前検証が完全性を満たしたかを表す。 */
export type CompletenessValidationResult<Value> =
  | Readonly<{
      status: "complete";
      value: Value;
      diagnostics: readonly string[];
    }>
  | Readonly<{
      status: "incomplete";
      diagnostics: readonly [string, ...string[]];
    }>;

/** Discord段階の値と通知指標。 */
export type DiscordStageResult<Value> = Readonly<{
  value: Value;
  notificationCount: number;
  discordSentAt: UtcIsoDateTime | null;
}>;

/** 日次transactionの外部接続と各モジュールの結合境界。 */
export type DailyTransactionDependencies<Types extends DailyTransactionTypeMap> = Readonly<{
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  readAiProcessAttemptCount: (configuration: Types["configuration"]) => number;
  validateConfiguration: (
    input: Readonly<{
      request: RunRequest;
    }>,
  ) => Promise<Types["configuration"]>;
  loadState: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
    }>,
  ) => Promise<Types["state"]>;
  prepareRun: (
    input: Readonly<{
      request: RunRequest;
      identity: RunIdentity;
      configuration: Types["configuration"];
      state: Types["state"];
    }>,
  ) => Types["prepared"];
  collectInventory: (
    input: Readonly<{
      prepared: Types["prepared"];
      configuration: Types["configuration"];
    }>,
  ) => Promise<Types["inventoryCollected"]>;
  projectLegacyRepositoryInventory: (
    inventoryCollected: Types["inventoryCollected"],
  ) => Types["repositoryInventory"];
  collectIncrementalItems: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      inventoryCollected: Types["inventoryCollected"];
      repositoryInventory: Types["repositoryInventory"];
    }>,
  ) => Promise<Types["collectedRun"]>;
  projectLegacyCollection: (collected: Types["collectedRun"]) => Types["collection"];
  applyDeterministicRules: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
      collectedRun: Types["collectedRun"];
    }>,
  ) => Promise<Types["deterministicallyAnalyzed"]>;
  analyzeWithCodex: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      deterministicallyAnalyzed: Types["deterministicallyAnalyzed"];
    }>,
  ) => Promise<CodexAnalysisStageResult<Types["codexAnalysis"]>>;
  reduceAnalysis: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      deterministicallyAnalyzed: Types["deterministicallyAnalyzed"];
      codexAnalysis: Types["codexAnalysis"];
    }>,
  ) => Promise<Types["reduction"]>;
  reconcileGraph: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      deterministicallyAnalyzed: Types["deterministicallyAnalyzed"];
      reduction: Types["reduction"];
    }>,
  ) => Promise<GraphAnalysisStageResult<Types["graph"]>>;
  analyzePersonalReminders: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      deterministicallyAnalyzed: Types["deterministicallyAnalyzed"];
      codexAnalysis: Types["codexAnalysis"];
      reduction: Types["reduction"];
      graph: Types["graph"];
    }>,
  ) => Promise<PersonalReminderAnalysisStageResult<Types["personalReminderAnalysis"]>>;
  validateCompleteness: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      collection: Types["collection"];
      codexAnalysis: Types["codexAnalysis"];
      reduction: Types["reduction"];
      graph: Types["graph"];
      personalReminderAnalysis: Types["personalReminderAnalysis"];
    }>,
  ) => Promise<CompletenessValidationResult<Types["validated"]>>;
  persistState: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<Types["persisted"]>;
  buildPages: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      persisted: Types["persisted"];
    }>,
  ) => Promise<Types["pages"]>;
  sendDiscord: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      persisted: Types["persisted"];
      pages: Types["pages"];
    }>,
  ) => Promise<DiscordStageResult<Types["discord"]>>;
  completeRun: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      discord: Types["discord"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<void>;
  sendOperationsAlert: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      persisted: Types["persisted"] | undefined;
      kind: "collection" | "pages";
      retryAttempts: number;
    }>,
  ) => Promise<DiscordStageResult<Types["discord"]>>;
  writeDryRunArtifact: (
    path: string,
    artifact: DryRunArtifact<Types["validated"]>,
  ) => Promise<void>;
  writeCollectAnalyzeArtifact: (
    path: string,
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<void>;
  writeReport: (path: string, report: RunReport) => Promise<void>;
}>;

/** 日次transaction実行後に生じた副作用を表す。 */
export type DailyRunEffects = Readonly<{
  stateCommitted: boolean;
  pagesBuilt: boolean;
  discordAttempted: boolean;
  artifactWritten: boolean;
}>;

/** 日次transactionのreportと副作用実績。 */
export type DailyRunExecutionResult = Readonly<{
  report: RunReport;
  effects: DailyRunEffects;
}>;

/** dry-runが公開副作用の代わりに保存する検証済み成果物。 */
export type DryRunArtifact<Value> =
  | Readonly<{
      schemaVersion: "2";
      runId: string;
      command: "dry-run";
      status: "success" | "fallback";
      complete: true;
      result: Value;
      metrics: RunMetrics;
      diagnostics: readonly string[];
    }>
  | Readonly<{
      schemaVersion: "2";
      runId: string;
      command: "dry-run";
      status: "failure";
      complete: false;
      metrics: RunMetrics;
      diagnostics: readonly string[];
    }>;

/** 日次transactionの時刻を注入する境界。 */
export type DailyRunRuntime = Readonly<{
  now: () => Date;
}>;

interface MutableEffects {
  stateCommitted: boolean;
  pagesBuilt: boolean;
  discordAttempted: boolean;
  artifactWritten: boolean;
}

function currentTime(runtime: DailyRunRuntime): UtcIsoDateTime {
  const value = runtime.now();
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("run runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(value.toISOString());
}

function freezeEffects(effects: MutableEffects): DailyRunEffects {
  return Object.freeze({
    ...effects,
  });
}

function updateMetrics(metrics: RunMetrics, values: Partial<RunMetrics>): RunMetrics {
  const updated = {
    ...metrics,
    ...values,
  };
  for (const [name, value] of Object.entries(updated)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name}は0以上の安全な整数にしてください`);
    }
  }
  return Object.freeze(updated);
}

function createDryRunArtifact<Value>(
  invocation: DailyRunInvocation,
  status: "success" | "fallback",
  validation: CompletenessValidationResult<Value>,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  finishedAt: UtcIsoDateTime,
): DryRunArtifact<Value> {
  const completedMetrics = updateMetrics(metrics, {
    durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
  });
  if (validation.status === "incomplete") {
    return Object.freeze({
      schemaVersion: "2",
      runId: invocation.runId,
      command: "dry-run",
      status: "failure",
      complete: false,
      metrics: completedMetrics,
      diagnostics: Object.freeze([...diagnostics]),
    });
  }
  return Object.freeze({
    schemaVersion: "2",
    runId: invocation.runId,
    command: "dry-run",
    status,
    complete: true,
    result: validation.value,
    metrics: completedMetrics,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function completedReport(
  invocation: DailyRunInvocation,
  status: "success" | "fallback",
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "4",
    runId: invocation.runId,
    command: invocation.command.kind,
    status,
    complete: true,
    scheduledFor: invocation.scheduledFor,
    startedAt: invocation.startedAt,
    finishedAt,
    discordSentAt,
    metrics: updateMetrics(metrics, {
      durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
    }),
    diagnostics,
  });
}

function failureReport(
  invocation: DailyRunInvocation,
  failedStage: RunStage,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "4",
    runId: invocation.runId,
    command: invocation.command.kind,
    status: "failure",
    complete: false,
    failedStage,
    scheduledFor: invocation.scheduledFor,
    startedAt: invocation.startedAt,
    finishedAt,
    discordSentAt,
    metrics: updateMetrics(metrics, {
      durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
    }),
    diagnostics,
  });
}

function initialEffects(): MutableEffects {
  return {
    stateCommitted: false,
    pagesBuilt: false,
    discordAttempted: false,
    artifactWritten: false,
  };
}

function operationsAlertKind(stage: RunStage): "collection" | "pages" | undefined {
  if (stage === "repository_inventory" || stage === "incremental_collection") {
    return "collection";
  }
  if (stage === "pages") {
    return "pages";
  }
  return undefined;
}

function operationsAlertRetryAttempts(error: unknown): number {
  return error instanceof GitHubRetryExhaustedError ? error.attempts : 1;
}

function personalReminderAiDependencyMismatchError(
  error: unknown,
): StatePersonalReminderAiDependencyMismatchError | undefined {
  if (error instanceof StatePersonalReminderAiDependencyMismatchError) {
    return error;
  }
  if (error instanceof StateFormatError) {
    if (error.cause instanceof StatePersonalReminderAiDependencyMismatchError) {
      return error.cause;
    }
    if (
      error.cause instanceof TypeError &&
      error.cause.cause instanceof StatePersonalReminderAiDependencyMismatchError
    ) {
      return error.cause.cause;
    }
  }
  return undefined;
}

/** Daily transactionを順序保証付きで実行する。 */
export class DailyTransactionRunner<Types extends DailyTransactionTypeMap> {
  readonly #coordinator: RunCoordinator<DailyRunExecutionResult>;
  readonly #dependencies: DailyTransactionDependencies<Types>;
  readonly #runtime: DailyRunRuntime;

  public constructor(dependencies: DailyTransactionDependencies<Types>, runtime: DailyRunRuntime) {
    this.#dependencies = dependencies;
    this.#runtime = runtime;
    this.#coordinator = new RunCoordinator((result) => result.report.status !== "failure");
  }

  #metricsWithAiProcessAttemptCount(
    metrics: RunMetrics,
    configuration: Types["configuration"] | undefined,
  ): RunMetrics {
    if (configuration == null) {
      return metrics;
    }
    return updateMetrics(metrics, {
      aiProcessAttemptCount: this.#dependencies.readAiProcessAttemptCount(configuration),
    });
  }

  async #writeFailure(
    invocation: DailyRunInvocation,
    reportPath: string,
    stage: RunStage,
    metrics: RunMetrics,
    configuration: Types["configuration"] | undefined,
    diagnostics: readonly string[],
    discordSentAt: UtcIsoDateTime | null,
    effects: MutableEffects,
  ): Promise<DailyRunExecutionResult> {
    const report = failureReport(
      invocation,
      stage,
      this.#metricsWithAiProcessAttemptCount(metrics, configuration),
      diagnostics,
      discordSentAt,
      currentTime(this.#runtime),
    );
    await this.#dependencies.writeReport(reportPath, report);
    return Object.freeze({
      report,
      effects: freezeEffects(effects),
    });
  }

  async #recordError(
    invocation: DailyRunInvocation,
    stage: RunStage,
    event: string,
    error: unknown,
  ): Promise<void> {
    const recorder = this.#dependencies.diagnosticsRecorder;
    if (recorder == null) {
      return;
    }
    const mismatchError =
      event === "cli.stage.failed" ? personalReminderAiDependencyMismatchError(error) : undefined;
    try {
      await recorder.append({
        event,
        details: {
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          command: invocation.command.kind,
          stage,
          ...(mismatchError != null
            ? {
                personalReminderAiDependencyMismatch: mismatchError.diagnosticDetails(),
              }
            : {}),
        },
        error,
      });
    } catch (recordingError: unknown) {
      throw new AggregateError([error, recordingError], "CLI段階エラーの診断記録に失敗しました", {
        cause: error,
      });
    }
  }

  async #execute(
    initialInvocation: DailyRunInvocation,
    request: RunRequest,
    identity: RunIdentity,
  ): Promise<DailyRunExecutionResult> {
    let invocation = initialInvocation;
    let stage: RunStage = "configuration";
    let metrics = updateMetrics(createEmptyRunMetrics(), {
      scheduleDelayMilliseconds:
        Date.parse(invocation.startedAt) - Date.parse(invocation.scheduledFor),
    });
    const diagnostics: string[] = [];
    const effects = initialEffects();
    let discordSentAt: UtcIsoDateTime | null = null;
    let configuration: Types["configuration"] | undefined;
    let state: Types["state"] | undefined;
    let persisted: Types["persisted"] | undefined;

    try {
      configuration = await this.#dependencies.validateConfiguration({
        request,
      });
      state = await this.#dependencies.loadState({
        invocation,
        configuration,
      });
      const prepared = this.#dependencies.prepareRun({ request, identity, configuration, state });
      invocation = projectPreparedLegacyDailyInvocation(prepared);

      stage = "repository_inventory";
      const inventoryCollected = await this.#dependencies.collectInventory({
        prepared,
        configuration,
      });
      const repositoryInventory =
        this.#dependencies.projectLegacyRepositoryInventory(inventoryCollected);
      diagnostics.push(...inventoryCollected.data.diagnostics);
      metrics = updateMetrics(metrics, {
        repositoryCount: inventoryCollected.data.metrics.repositoryCount,
        githubApiRemaining: inventoryCollected.data.metrics.githubApiRemaining,
      });

      stage = "incremental_collection";
      const collectedRun = await this.#dependencies.collectIncrementalItems({
        invocation,
        configuration,
        state,
        inventoryCollected,
        repositoryInventory,
      });
      const collection = this.#dependencies.projectLegacyCollection(collectedRun);
      diagnostics.push(...collectedRun.data.diagnostics);
      metrics = updateMetrics(metrics, {
        itemCount: collectedRun.data.metrics.itemCount,
        changedItemCount: collectedRun.data.metrics.changedItemCount,
        githubApiRemaining: collectedRun.data.metrics.githubApiRemaining,
        staleRepositoryCount: collectedRun.data.metrics.staleRepositoryCount,
      });

      stage = "deterministic_analysis";
      const deterministicallyAnalyzed = await this.#dependencies.applyDeterministicRules({
        invocation,
        configuration,
        repositoryInventory,
        collectedRun,
      });
      stage = "codex_analysis";
      const codexAnalysis = await this.#dependencies.analyzeWithCodex({
        invocation,
        configuration,
        state,
        deterministicallyAnalyzed,
      });
      diagnostics.push(...codexAnalysis.diagnostics);
      metrics = updateMetrics(metrics, {
        aiCallCount: codexAnalysis.aiCallCount,
        aiCacheHitCount: codexAnalysis.aiCacheHitCount,
        aiRetainedResultCount: codexAnalysis.aiRetainedResultCount,
        estimatedInputTokens: codexAnalysis.estimatedInputTokens,
      });
      let runStatus = codexAnalysis.status;

      stage = "reducer";
      const reduction = await this.#dependencies.reduceAnalysis({
        invocation,
        configuration,
        state,
        repositoryInventory,
        deterministicallyAnalyzed,
        codexAnalysis: codexAnalysis.value,
      });

      stage = "graph_analysis";
      const graph = await this.#dependencies.reconcileGraph({
        invocation,
        configuration,
        state,
        deterministicallyAnalyzed,
        reduction,
      });
      metrics = updateMetrics(metrics, {
        activeEdgeCount: graph.activeEdgeCount,
      });

      stage = "personal_reminder_analysis";
      const personalReminderAnalysis = await this.#dependencies.analyzePersonalReminders({
        invocation,
        configuration,
        state,
        repositoryInventory,
        deterministicallyAnalyzed,
        codexAnalysis: codexAnalysis.value,
        reduction,
        graph: graph.value,
      });
      diagnostics.push(...personalReminderAnalysis.diagnostics);
      metrics = updateMetrics(metrics, {
        aiCallCount: personalReminderAnalysis.aiCallCount,
        estimatedInputTokens: personalReminderAnalysis.estimatedInputTokens,
        personalReminderCauseCount: personalReminderAnalysis.personalReminderCauseCount,
        personalReminderAiCallCount: personalReminderAnalysis.personalReminderAiCallCount,
        personalReminderAiCacheHitCount: personalReminderAnalysis.personalReminderAiCacheHitCount,
        personalReminderAssessmentReuseCount:
          personalReminderAnalysis.personalReminderAssessmentReuseCount,
        personalReminderUnknownCount: personalReminderAnalysis.personalReminderUnknownCount,
        personalReminderFailedCount: personalReminderAnalysis.personalReminderFailedCount,
        personalReminderDeferredCount: personalReminderAnalysis.personalReminderDeferredCount,
        personalReminderNotEvaluatedCount:
          personalReminderAnalysis.personalReminderNotEvaluatedCount,
      });
      if (personalReminderAnalysis.status === "fallback") {
        runStatus = "fallback";
      }

      stage = "completeness_validation";
      const validation = await this.#dependencies.validateCompleteness({
        invocation,
        configuration,
        state,
        repositoryInventory,
        collection,
        codexAnalysis: codexAnalysis.value,
        reduction,
        graph: graph.value,
        personalReminderAnalysis: personalReminderAnalysis.value,
      });
      diagnostics.push(...validation.diagnostics);
      metrics = this.#metricsWithAiProcessAttemptCount(metrics, configuration);

      if (request.output.kind === "dry_run_artifact") {
        stage = "artifact";
        await this.#dependencies.writeDryRunArtifact(
          request.output.path,
          createDryRunArtifact(
            invocation,
            runStatus,
            validation,
            metrics,
            diagnostics,
            currentTime(this.#runtime),
          ),
        );
        effects.artifactWritten = true;
      }

      if (validation.status === "incomplete") {
        return await this.#writeFailure(
          invocation,
          request.reportPath,
          "completeness_validation",
          metrics,
          configuration,
          diagnostics,
          discordSentAt,
          effects,
        );
      }

      if (request.output.kind === "analysis_artifact") {
        stage = "artifact";
        await this.#dependencies.writeCollectAnalyzeArtifact(request.output.path, {
          invocation,
          configuration,
          state,
          repositoryInventory,
          validated: validation.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.artifactWritten = true;
      }

      if (request.output.kind === "publication") {
        stage = "state_persistence";
        persisted = await this.#dependencies.persistState({
          invocation,
          configuration,
          state,
          repositoryInventory,
          validated: validation.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.stateCommitted = true;

        stage = "pages";
        const pages = await this.#dependencies.buildPages({
          invocation,
          configuration,
          repositoryInventory,
          validated: validation.value,
          persisted,
        });
        effects.pagesBuilt = true;

        stage = "discord";
        effects.discordAttempted = true;
        const discord = await this.#dependencies.sendDiscord({
          invocation,
          configuration,
          state,
          repositoryInventory,
          validated: validation.value,
          persisted,
          pages,
        });
        discordSentAt = discord.discordSentAt;
        metrics = updateMetrics(metrics, {
          notificationCount: discord.notificationCount,
        });

        stage = "state_persistence";
        await this.#dependencies.completeRun({
          invocation,
          configuration,
          state,
          repositoryInventory,
          validated: validation.value,
          discord: discord.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
      }

      const report = completedReport(
        invocation,
        runStatus,
        this.#metricsWithAiProcessAttemptCount(metrics, configuration),
        diagnostics,
        discordSentAt,
        currentTime(this.#runtime),
      );
      await this.#dependencies.writeReport(request.reportPath, report);
      return Object.freeze({
        report,
        effects: freezeEffects(effects),
      });
    } catch (error: unknown) {
      await this.#recordError(invocation, stage, "cli.stage.failed", error);
      const alertKind = operationsAlertKind(stage);
      if (
        alertKind != null &&
        configuration != null &&
        state != null &&
        request.executionPolicy.effectTarget === "production" &&
        request.output.kind === "publication"
      ) {
        effects.discordAttempted = true;
        try {
          const alert = await this.#dependencies.sendOperationsAlert({
            invocation,
            configuration,
            state,
            persisted,
            kind: alertKind,
            retryAttempts: operationsAlertRetryAttempts(error),
          });
          discordSentAt = alert.discordSentAt;
          metrics = updateMetrics(metrics, {
            notificationCount: alert.notificationCount,
          });
        } catch (alertError: unknown) {
          await this.#recordError(invocation, "discord", "cli.operations_alert.failed", alertError);
          diagnostics.push(safeErrorDiagnostic("discord", alertError));
        }
      }
      return this.#writeFailure(
        invocation,
        request.reportPath,
        stage,
        metrics,
        configuration,
        [...diagnostics, safeErrorDiagnostic(stage, error)],
        discordSentAt,
        effects,
      );
    }
  }

  /** サブコマンドを排他かつ同じrun IDで冪等に実行する。 */
  public async run(
    command: OnlineCliCommand,
    invocationId: string,
  ): Promise<CoordinatedRunResult<DailyRunExecutionResult>> {
    const request = parseRunRequest(command, this.#runtime.now(), invocationId);
    const identity = createRunIdentity(request);
    const invocation = projectLegacyDailyInvocation(request, identity);
    return this.#coordinator.runExclusive(invocation.runId, () =>
      this.#execute(invocation, request, identity),
    );
  }
}

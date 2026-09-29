import { randomUUID } from "node:crypto";

import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import type {
  RunIdentity,
  RunRequest,
  RunExecutionPolicy,
} from "../application/tracking-run/request.js";
import type { PreparedRun } from "../application/tracking-run/prepare-run.js";
import type { FailedRun } from "../application/tracking-run/failure-artifact.js";
import type { CompletedRun } from "../application/tracking-run/complete-run.js";
import type {
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../application/tracking-run/receipt-schema.js";
import type { StateCommitReceiptEvidence } from "../application/tracking-run/observed-state-commit.js";
import type { InitialStateCommitReference } from "../application/tracking-run/engine.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";
import type { InitialStateCommitResult } from "./initial-state-commit.js";
import type { NotificationSettlementOutcome } from "./notification-settlement.js";
import type {
  InitialPagesPreparedRun,
  InitialPagesPublishedRun,
  NotificationHistoryPagesPreparedRun,
  NotificationHistoryPublishedRun,
} from "./run-publication/contracts.js";
import type { FinalizeRunOutcome } from "./run-finalization.js";
import {
  runDailyPublication,
  type PublicationStageInput,
} from "./daily-transaction-publication.js";
import type { InventoryCollectedRun } from "../application/tracking-run/stages/inventory.js";
import type { CollectedRun } from "../application/tracking-run/stages/collection.js";
import type { RunEvaluatedAt } from "../application/tracking-run/contracts/evaluation-time.js";
import type { DeterministicallyAnalyzedRun } from "../application/tracking-run/stages/deterministic.js";
import type { GenericAiPlannedRun } from "../application/tracking-run/stages/generic-ai-plan.js";
import type { GenericAiExecutedRun } from "../application/tracking-run/stages/generic-ai-execution.js";
import type { GenericAiAdoptedRun } from "../application/tracking-run/stages/generic-ai-adoption.js";
import type { GraphReconciledRun } from "../application/tracking-run/stages/graph-reconciliation.js";
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
import { isPublicBoundaryViolation } from "./public-boundary-error.js";
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
  prepared: PreparedRun;
  inventoryCollected: InventoryCollectedRun;
  collectedRun: CollectedRun<Readonly<{ evaluatedAt: RunEvaluatedAt }>>;
  deterministicallyAnalyzed: DeterministicallyAnalyzedRun;
  genericAiPlanned: GenericAiPlannedRun;
  genericAiExecuted: GenericAiExecutedRun;
  genericAiAdopted: GenericAiAdoptedRun;
  graphReconciled: GraphReconciledRun;
  repositoryInventory: unknown;
  collection: unknown;
  codexAnalysis: unknown;
  personalReminderAnalysis: unknown;
  validated: unknown;
  planned: unknown;
  persisted: Readonly<{ result: InitialStateCommitResult }>;
  pagesPrepared: InitialPagesPreparedRun;
  pages: InitialPagesPublishedRun;
  notifications: Extract<NotificationSettlementOutcome, { kind: "settled" }>;
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
  executed: GenericAiExecutedRun;
  aiCallCount: number;
  aiCacheHitCount: number;
  aiRetainedResultCount: number;
  estimatedInputTokens: number;
  diagnostics: readonly string[];
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

/** 通知段階の値と送信指標。 */
export type NotificationStageResult<Value> = Readonly<{
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
    collectedRun: Types["collectedRun"],
  ) => Types["deterministicallyAnalyzed"];
  planGenericAi: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      deterministicallyAnalyzed: Types["deterministicallyAnalyzed"];
    }>,
  ) => Promise<Types["genericAiPlanned"]>;
  analyzeWithCodex: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      genericAiPlanned: Types["genericAiPlanned"];
    }>,
  ) => Promise<CodexAnalysisStageResult<Types["codexAnalysis"]>>;
  adoptGenericAi: (
    input: Readonly<{
      genericAiExecuted: Types["genericAiExecuted"];
    }>,
  ) => Types["genericAiAdopted"];
  reconcileAdoptedGraph: (adopted: Types["genericAiAdopted"]) => Types["graphReconciled"];
  analyzePersonalReminders: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      deterministicallyAnalyzed: Types["deterministicallyAnalyzed"];
      genericAiExecuted: Types["genericAiExecuted"];
      codexAnalysis: Types["codexAnalysis"];
      graphReconciled: Types["graphReconciled"];
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
      genericAiAdopted: Types["genericAiAdopted"];
      graphReconciled: Types["graphReconciled"];
      personalReminderAnalysis: Types["personalReminderAnalysis"];
      metrics: RunMetrics;
      diagnostics: readonly string[];
    }>,
  ) => Promise<Types["validated"]>;
  planPublication: (validated: Types["validated"]) => Types["planned"];
  prepareCheckpoint: (
    input: Parameters<DailyTransactionDependencies<Types>["persistState"]>[0],
  ) => Promise<BoundPublicationCheckpoint>;
  commitPreparedCheckpoint: (
    input: Parameters<DailyTransactionDependencies<Types>["persistState"]>[0],
    checkpoint: BoundPublicationCheckpoint,
  ) => Promise<Types["persisted"]>;
  readCommittedState: (
    input: Readonly<{
      configuration: Types["configuration"];
      reference: InitialStateCommitReference;
    }>,
  ) => Promise<
    Types["persisted"] &
      Readonly<{
        stateContentDigest: string;
        receiptEvidence: Extract<
          StateCommitReceiptEvidence,
          { receiptType: "initial_state_commit" }
        >;
      }>
  >;
  persistState: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      planned: Types["planned"];
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
      planned: Types["planned"];
      persisted: Types["persisted"];
    }>,
  ) => Promise<Types["pagesPrepared"]>;
  deployPages: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      persisted: Types["persisted"];
      pagesPrepared: Types["pagesPrepared"];
    }>,
  ) => Promise<Types["pages"]>;
  settleNotifications: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
      persisted: Types["persisted"];
      pages: Types["pages"];
    }>,
  ) => Promise<NotificationStageResult<Types["notifications"]>>;
  finalizeRun: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
      persisted: Types["persisted"];
      notifications: Types["notifications"];
    }>,
  ) => Promise<Extract<FinalizeRunOutcome, { kind: "finalized" }>>;
  buildNotificationHistoryPages: (
    input: Readonly<{
      configuration: Types["configuration"];
      settlementReceipt: NotificationSettlementReceipt;
      finalizationReceipt: RunFinalizationReceipt;
    }>,
  ) => Promise<NotificationHistoryPagesPreparedRun>;
  deployNotificationHistoryPages: (
    input: Readonly<{
      configuration: Types["configuration"];
      prepared: NotificationHistoryPagesPreparedRun;
      settlementReceipt: NotificationSettlementReceipt;
      finalizationReceipt: RunFinalizationReceipt;
      runId: string;
    }>,
  ) => Promise<NotificationHistoryPublishedRun>;
  writeDryRunArtifact: (path: string, artifact: DryRunArtifact<Types["planned"]>) => Promise<void>;
  writeCollectAnalyzeArtifact: (
    path: string,
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      planned: Types["planned"];
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
  completedRun?: CompletedRun;
  failureDiagnosticRecordId?: string;
  failureEvidence?: FailedRun["evidence"];
}>;

/** dry-runが公開副作用の代わりに保存する検証済み成果物。 */
export type DryRunArtifact<Value> = Readonly<{
  schemaVersion: "2";
  runId: string;
  command: "dry-run";
  status: "success" | "fallback";
  complete: true;
  result: Value;
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
  planned: Value,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  finishedAt: UtcIsoDateTime,
): DryRunArtifact<Value> {
  const completedMetrics = updateMetrics(metrics, {
    durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
  });
  return Object.freeze({
    schemaVersion: "2",
    runId: invocation.runId,
    command: "dry-run",
    status,
    complete: true,
    result: planned,
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
    schemaVersion: "5",
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
  failureKind: Extract<RunReport, { status: "failure" }>["failureKind"],
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "5",
    runId: invocation.runId,
    command: invocation.command.kind,
    status: "failure",
    complete: false,
    failureKind,
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

function isPreCheckpointFailureStage(stage: RunStage): boolean {
  return (
    stage === "repository_inventory" ||
    stage === "incremental_collection" ||
    stage === "deterministic_analysis" ||
    stage === "codex_analysis" ||
    stage === "reducer" ||
    stage === "graph_analysis" ||
    stage === "personal_reminder_analysis" ||
    stage === "completeness_validation" ||
    stage === "artifact"
  );
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
    failureKind: Extract<RunReport, { status: "failure" }>["failureKind"],
    metrics: RunMetrics,
    configuration: Types["configuration"] | undefined,
    diagnostics: readonly string[],
    discordSentAt: UtcIsoDateTime | null,
    effects: MutableEffects,
  ): Promise<DailyRunExecutionResult> {
    const report = failureReport(
      invocation,
      stage,
      failureKind,
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
  ): Promise<string | undefined> {
    const recorder = this.#dependencies.diagnosticsRecorder;
    if (recorder == null) {
      return undefined;
    }
    const recordId = randomUUID();
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
          recordId,
          ...(mismatchError != null
            ? {
                personalReminderAiDependencyMismatch: mismatchError.diagnosticDetails(),
              }
            : {}),
        },
        error,
      });
      return recordId;
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
    let prepared: PreparedRun | undefined;
    let completedRun: CompletedRun | undefined;

    try {
      configuration = await this.#dependencies.validateConfiguration({
        request,
      });
      state = await this.#dependencies.loadState({
        invocation,
        configuration,
      });
      prepared = this.#dependencies.prepareRun({ request, identity, configuration, state });
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
      const deterministicallyAnalyzed = this.#dependencies.applyDeterministicRules(collectedRun);
      stage = "codex_analysis";
      const genericAiPlanned = await this.#dependencies.planGenericAi({
        invocation,
        configuration,
        state,
        deterministicallyAnalyzed,
      });
      const codexAnalysis = await this.#dependencies.analyzeWithCodex({
        invocation,
        configuration,
        state,
        genericAiPlanned,
      });
      diagnostics.push(...codexAnalysis.diagnostics);
      metrics = updateMetrics(metrics, {
        aiCallCount: codexAnalysis.aiCallCount,
        aiCacheHitCount: codexAnalysis.aiCacheHitCount,
        aiRetainedResultCount: codexAnalysis.aiRetainedResultCount,
        estimatedInputTokens: codexAnalysis.estimatedInputTokens,
      });
      let runStatus = codexAnalysis.status;

      const genericAiAdopted = this.#dependencies.adoptGenericAi({
        genericAiExecuted: codexAnalysis.executed,
      });

      stage = "graph_analysis";
      const graphReconciled = this.#dependencies.reconcileAdoptedGraph(genericAiAdopted);
      metrics = updateMetrics(metrics, {
        activeEdgeCount: graphReconciled.data.graph.edges.filter((edge) => edge.active).length,
      });

      stage = "personal_reminder_analysis";
      const personalReminderAnalysis = await this.#dependencies.analyzePersonalReminders({
        invocation,
        configuration,
        state,
        repositoryInventory,
        deterministicallyAnalyzed,
        genericAiExecuted: codexAnalysis.executed,
        codexAnalysis: codexAnalysis.value,
        graphReconciled,
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
      metrics = this.#metricsWithAiProcessAttemptCount(metrics, configuration);
      const validated = await this.#dependencies.validateCompleteness({
        invocation,
        configuration,
        state,
        repositoryInventory,
        collection,
        codexAnalysis: codexAnalysis.value,
        genericAiAdopted,
        graphReconciled,
        personalReminderAnalysis: personalReminderAnalysis.value,
        metrics,
        diagnostics,
      });
      const planned = this.#dependencies.planPublication(validated);

      if (request.output.kind === "dry_run_artifact") {
        stage = "artifact";
        await this.#dependencies.writeDryRunArtifact(
          request.output.path,
          createDryRunArtifact(
            invocation,
            runStatus,
            planned,
            metrics,
            diagnostics,
            currentTime(this.#runtime),
          ),
        );
        effects.artifactWritten = true;
      }

      if (request.output.kind === "analysis_artifact") {
        stage = "artifact";
        await this.#dependencies.writeCollectAnalyzeArtifact(request.output.path, {
          invocation,
          configuration,
          state,
          repositoryInventory,
          planned,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.artifactWritten = true;
      }

      if (request.output.kind === "publication") {
        const publicationInput = {
          invocation,
          configuration,
          state,
          repositoryInventory,
          planned,
          metrics,
          status: runStatus,
          diagnostics,
        } satisfies PublicationStageInput<Types>;
        completedRun = await runDailyPublication(
          this.#dependencies,
          this.#runtime,
          publicationInput,
          {
            setStage: (value) => {
              stage = value;
            },
            stateCommitted: () => {
              effects.stateCommitted = true;
            },
            pagesBuilt: () => {
              effects.pagesBuilt = true;
            },
            notificationStarted: () => {
              effects.discordAttempted = request.executionPolicy.notificationAction === "send";
            },
            notificationsSettled: (notifications) => {
              discordSentAt = notifications.discordSentAt;
              metrics = updateMetrics(metrics, {
                notificationCount: notifications.notificationCount,
              });
            },
          },
        );
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
        ...(completedRun == null ? {} : { completedRun }),
      });
    } catch (error: unknown) {
      const failureDiagnosticRecordId = await this.#recordError(
        invocation,
        stage,
        "cli.stage.failed",
        error,
      );
      const failureKind = isPublicBoundaryViolation(error) ? "public_boundary" : "other";
      try {
        const result = await this.#writeFailure(
          invocation,
          request.reportPath,
          stage,
          failureKind,
          metrics,
          configuration,
          [...diagnostics, safeErrorDiagnostic(stage, error)],
          discordSentAt,
          effects,
        );
        return Object.freeze({
          ...result,
          ...(failureDiagnosticRecordId == null ? {} : { failureDiagnosticRecordId }),
          ...(prepared == null || !isPreCheckpointFailureStage(stage)
            ? {}
            : {
                failureEvidence: {
                  bindingKind: "run_pre_checkpoint_alert" as const,
                  runId: prepared.core.identity.runId,
                  baseStateRevision: prepared.core.baseState.revision,
                  configDigest: prepared.core.configDigest,
                },
              }),
        });
      } catch (reportError: unknown) {
        throw new AggregateError([error, reportError], "run reportの書込みにも失敗しました", {
          cause: error,
        });
      }
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

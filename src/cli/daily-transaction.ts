import { randomUUID } from "node:crypto";
import { assertNonNullable } from "../util/index.js";

import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import type { UtcIsoDateTime } from "../domain/index.js";
import type {
  RunIdentity,
  RunRequest,
  RunExecutionPolicy,
} from "../application/tracking-run/request.js";
import type { PreparedRun } from "../application/tracking-run/prepare-run.js";
import type { BaseStateRevision } from "../application/tracking-run/contracts/run-core.js";
import type { RecoveryStageInput } from "../infrastructure/tracking-run/recovery-stage.js";
import type { FailedRun } from "../application/tracking-run/failure-artifact.js";
import type { CompletedRun } from "../application/tracking-run/complete-run.js";
import type { ReceiptChainEntry } from "../application/tracking-run/receipt-chain-schema.js";
import type {
  NotificationSettlementReceipt,
  Receipt,
  RunFinalizationReceipt,
} from "../application/tracking-run/receipt-schema.js";
import type { StateCommitReceiptEvidence } from "../application/tracking-run/observed-state-commit.js";
import type { StateRunReport } from "../persistence/state-run-report.js";
import type { InitialStateCommitReference } from "../application/tracking-run/engine.js";
import {
  runTrackingAnalysis,
  runTrackingRunSequentially,
  type NewRunStagePorts,
  type PendingRunPorts,
  type TrackingRunLaunchDecision,
  type TrackingRunFailurePort,
} from "../application/tracking-run/engine.js";
import { createFailedRun } from "../application/tracking-run/failure-artifact.js";
import {
  currentTime,
  updateMetrics,
  createDryRunArtifact,
  completedReport,
  completedReportFromState,
  failureReport,
  reportStageForEngine,
  isPreCheckpointFailureStage,
} from "./daily-transaction-report.js";
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
  createDailyPublicationStages,
  type DailyPublicationStageValues,
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
import { observeCliFailureContext } from "./failure-context.js";
import { publicDiagnosticCode } from "./public-failure-boundary.js";
import { isPublicBoundaryViolation } from "./public-boundary-error.js";
import { RunCoordinator, type CoordinatedRunResult } from "./run-coordinator.js";
import { createRunIdentity } from "./tracking-run/identity.js";
import { projectLegacyDailyInvocation } from "./tracking-run/migration-bridge/legacy-invocation.js";
import { projectPreparedLegacyDailyInvocation } from "./tracking-run/migration-bridge/legacy-invocation.js";
import { parseRunRequest } from "./tracking-run/parse-request.js";
import {
  createEmptyRunMetrics,
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
  personalReminderPlanned: object;
  personalReminderExecuted: object;
  repositoryInventory: unknown;
  collection: unknown;
  codexAnalysis: unknown;
  personalReminderAnalysis: unknown;
  validated: object;
  planned: object;
  persisted: Readonly<{ result: InitialStateCommitResult }>;
  pagesPrepared: InitialPagesPreparedRun;
  historyPagesPrepared: NotificationHistoryPagesPreparedRun;
  pages: InitialPagesPublishedRun;
  notifications: Extract<NotificationSettlementOutcome, { kind: "settled" }>;
}>;

type DailyEngineStageValues<Types extends DailyTransactionTypeMap> = Readonly<{
  prepared: Types["prepared"];
  inventory_collected: Types["inventoryCollected"];
  collected: Types["collectedRun"];
  deterministically_analyzed: Types["deterministicallyAnalyzed"];
  generic_ai_planned: Types["genericAiPlanned"];
  generic_ai_executed: CodexAnalysisStageResult<Types["codexAnalysis"]>;
  generic_ai_adopted: Types["genericAiAdopted"];
  graph_reconciled: Types["graphReconciled"];
  personal_reminder_planned: Types["personalReminderPlanned"];
  personal_reminder_executed: Types["personalReminderExecuted"];
  personal_reminder_finalized: PersonalReminderAnalysisStageResult<
    Types["personalReminderAnalysis"]
  >;
  validated: Types["validated"];
}> &
  DailyPublicationStageValues<Types>;

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
  inspectLaunch: (
    request: RunRequest,
    invocationId: string,
    intent: Readonly<{ kind: "start_new" } | { kind: "retry_run"; runId: string }>,
  ) => Promise<TrackingRunLaunchDecision<RecoveryStageInput>>;
  readCompletedReport: (request: RunRequest, completed: CompletedRun) => Promise<StateRunReport>;
  pendingRun: (
    request: RunRequest,
    invocationId: string,
    getRunId: () => string,
    onReceiptRecorded: (receipt: Receipt) => void,
  ) => PendingRunPorts<RecoveryStageInput>;
  validateConfiguration: (
    input: Readonly<{
      request: RunRequest;
      baseStateHead: BaseStateRevision;
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
  planPersonalReminders: (
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
  ) => Promise<Types["personalReminderPlanned"]>;
  executePersonalReminders: (
    planned: Types["personalReminderPlanned"],
  ) => Promise<Types["personalReminderExecuted"]>;
  finalizePersonalReminders: (
    executed: Types["personalReminderExecuted"],
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
      persisted: Types["persisted"];
      pages: Types["pages"];
    }>,
  ) => Promise<NotificationStageResult<Types["notifications"]>>;
  finalizeRun: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
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
  writeReceiptChain: (runId: string, entries: readonly ReceiptChainEntry[]) => Promise<void>;
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
  failedRun?: FailedRun;
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

function freezeEffects(effects: MutableEffects): DailyRunEffects {
  return Object.freeze({
    ...effects,
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

function required<Value>(value: Value, message: string): NonNullable<Value> {
  assertNonNullable(value, message);
  return value;
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
    let prepared: Types["prepared"] | undefined;
    let repositoryInventory: Types["repositoryInventory"] | undefined;
    let collection: Types["collection"] | undefined;
    let analyzed: Types["deterministicallyAnalyzed"] | undefined;
    let aiExecuted: Types["genericAiExecuted"] | undefined;
    let codexAnalysis: Types["codexAnalysis"] | undefined;
    let aiAdopted: Types["genericAiAdopted"] | undefined;
    let graphReconciled: Types["graphReconciled"] | undefined;
    let publicationInput: PublicationStageInput<Types> | undefined;
    let runStatus: "success" | "fallback" = "success";
    let lastReceipt: Receipt | undefined;
    let failedResult: DailyRunExecutionResult | undefined;
    let baseStateHead: BaseStateRevision | undefined;
    const publicationStages = createDailyPublicationStages(
      this.#dependencies,
      this.#runtime,
      {
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
        receiptRecorded: (receipt) => {
          lastReceipt = receipt;
        },
      },
      () => required(publicationInput, "公開段階の入力がありません"),
    );
    const boundary: TrackingRunFailurePort = {
      beforeStage: (failedStage) => {
        stage = reportStageForEngine(failedStage);
        return Promise.resolve();
      },
      fail: async (failedStage, error) => {
        const recordId = await this.#recordError(
          invocation,
          reportStageForEngine(failedStage),
          "cli.stage.failed",
          error,
        );
        if (recordId == null) {
          throw new TypeError("失敗runに必要な暗号化診断recorderがありません", { cause: error });
        }
        const failureKind = isPublicBoundaryViolation(error) ? "public_boundary" : "other";
        const reported = await this.#writeFailure(
          invocation,
          request.reportPath,
          reportStageForEngine(failedStage),
          failureKind,
          metrics,
          configuration,
          [...diagnostics, safeErrorDiagnostic(reportStageForEngine(failedStage), error)],
          discordSentAt,
          effects,
        );
        const failureEvidence =
          prepared == null || !isPreCheckpointFailureStage(reportStageForEngine(failedStage))
            ? undefined
            : {
                bindingKind: "run_pre_checkpoint_alert" as const,
                runId: prepared.core.identity.runId,
                baseStateRevision: prepared.core.baseState.revision,
                configDigest: prepared.core.configDigest,
              };
        const context = await observeCliFailureContext(
          invocation.command,
          error,
          {
            command: invocation.command.kind,
            exitCode: 1,
            execution: "executed",
            result: {
              ...reported,
              failureDiagnosticRecordId: recordId,
              ...(failureEvidence == null ? {} : { failureEvidence }),
            },
          },
          failedStage,
          lastReceipt,
        );
        const effectiveStage =
          context.evidence.bindingKind === "state_bootstrap_alert"
            ? "runtime_bootstrap"
            : failedStage;
        const failure = createFailedRun({
          invocationId: invocation.invocationId,
          failedStage: effectiveStage,
          failureKind: context.failureKind,
          failedOperationEffectCertainty: context.failedOperationEffectCertainty,
          evidence: context.evidence,
          ...(context.runId == null ? {} : { runId: context.runId }),
          ...(context.checkpointDigest == null
            ? {}
            : { checkpointDigest: context.checkpointDigest }),
          ...(context.checkpointFileDigest == null
            ? {}
            : { checkpointFileDigest: context.checkpointFileDigest }),
          ...(context.finalStateRevision == null
            ? {}
            : { finalStateRevision: context.finalStateRevision }),
          publicDiagnostics: { code: publicDiagnosticCode(context.failureKind) },
          encryptedDiagnosticsRecordIds: [recordId],
          lastVerifiedReceipt:
            context.lastVerifiedReceipt != null &&
            (lastReceipt == null ||
              context.lastVerifiedReceipt.phaseSequence > lastReceipt.phaseSequence)
              ? context.lastVerifiedReceipt
              : lastReceipt,
          stateObservation: context.stateObservation,
        });
        failedResult = Object.freeze({
          ...reported,
          failureDiagnosticRecordId: recordId,
          failedRun: failure,
          ...(failureEvidence == null ? {} : { failureEvidence }),
        });
        return failure;
      },
    };
    const stages = {
      prepare: async () => {
        configuration = await this.#dependencies.validateConfiguration({
          request,
          baseStateHead: required(baseStateHead, "run開始時のstate headがありません"),
        });
        state = await this.#dependencies.loadState({ invocation, configuration });
        prepared = this.#dependencies.prepareRun({ request, identity, configuration, state });
        invocation = projectPreparedLegacyDailyInvocation(prepared);
        return prepared;
      },
      inventoryCollected: async (value) => {
        const inventory = await this.#dependencies.collectInventory({
          prepared: value,
          configuration: required(configuration, "実行設定がありません"),
        });
        repositoryInventory = this.#dependencies.projectLegacyRepositoryInventory(inventory);
        diagnostics.push(...inventory.data.diagnostics);
        metrics = updateMetrics(metrics, {
          repositoryCount: inventory.data.metrics.repositoryCount,
          githubApiRemaining: inventory.data.metrics.githubApiRemaining,
        });
        return inventory;
      },
      collected: async (inventory) => {
        const collected = await this.#dependencies.collectIncrementalItems({
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          inventoryCollected: inventory,
          repositoryInventory: required(repositoryInventory, "repository一覧がありません"),
        });
        collection = this.#dependencies.projectLegacyCollection(collected);
        diagnostics.push(...collected.data.diagnostics);
        metrics = updateMetrics(metrics, {
          itemCount: collected.data.metrics.itemCount,
          changedItemCount: collected.data.metrics.changedItemCount,
          githubApiRemaining: collected.data.metrics.githubApiRemaining,
          staleRepositoryCount: collected.data.metrics.staleRepositoryCount,
        });
        return collected;
      },
      deterministicallyAnalyzed: (collected) => {
        analyzed = this.#dependencies.applyDeterministicRules(collected);
        return Promise.resolve(analyzed);
      },
      genericAiPlanned: (value) =>
        this.#dependencies.planGenericAi({
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          deterministicallyAnalyzed: value,
        }),
      genericAiExecuted: async (value) => {
        const result = await this.#dependencies.analyzeWithCodex({
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          genericAiPlanned: value,
        });
        aiExecuted = result.executed;
        codexAnalysis = result.value;
        runStatus = result.status;
        diagnostics.push(...result.diagnostics);
        metrics = updateMetrics(metrics, {
          aiCallCount: result.aiCallCount,
          aiCacheHitCount: result.aiCacheHitCount,
          aiRetainedResultCount: result.aiRetainedResultCount,
          estimatedInputTokens: result.estimatedInputTokens,
        });
        return result;
      },
      genericAiAdopted: (result) => {
        aiAdopted = this.#dependencies.adoptGenericAi({ genericAiExecuted: result.executed });
        return Promise.resolve(aiAdopted);
      },
      graphReconciled: (value) => {
        const graph = this.#dependencies.reconcileAdoptedGraph(value);
        graphReconciled = graph;
        metrics = updateMetrics(metrics, {
          activeEdgeCount: graph.data.graph.edges.filter((edge) => edge.active).length,
        });
        return Promise.resolve(graph);
      },
      personalReminderPlanned: (graph) =>
        this.#dependencies.planPersonalReminders({
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          repositoryInventory: required(repositoryInventory, "repository一覧がありません"),
          deterministicallyAnalyzed: required(analyzed, "決定論的解析がありません"),
          genericAiExecuted: required(aiExecuted, "汎用AI実行結果がありません"),
          codexAnalysis: required(codexAnalysis, "汎用AI解析がありません"),
          graphReconciled: graph,
        }),
      personalReminderExecuted: (value) => this.#dependencies.executePersonalReminders(value),
      personalReminderFinalized: async (value) => {
        const result = await this.#dependencies.finalizePersonalReminders(value);
        diagnostics.push(...result.diagnostics);
        metrics = updateMetrics(metrics, {
          aiCallCount: result.aiCallCount,
          estimatedInputTokens: result.estimatedInputTokens,
          personalReminderCauseCount: result.personalReminderCauseCount,
          personalReminderAiCallCount: result.personalReminderAiCallCount,
          personalReminderAiCacheHitCount: result.personalReminderAiCacheHitCount,
          personalReminderAssessmentReuseCount: result.personalReminderAssessmentReuseCount,
          personalReminderUnknownCount: result.personalReminderUnknownCount,
          personalReminderFailedCount: result.personalReminderFailedCount,
          personalReminderDeferredCount: result.personalReminderDeferredCount,
          personalReminderNotEvaluatedCount: result.personalReminderNotEvaluatedCount,
        });
        if (result.status === "fallback") {
          runStatus = "fallback";
        }
        return result;
      },
      validated: async (reminder) => {
        metrics = this.#metricsWithAiProcessAttemptCount(
          metrics,
          required(configuration, "実行設定がありません"),
        );
        return this.#dependencies.validateCompleteness({
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          repositoryInventory: required(repositoryInventory, "repository一覧がありません"),
          collection: required(collection, "収集結果がありません"),
          codexAnalysis: required(codexAnalysis, "汎用AI解析がありません"),
          genericAiAdopted: required(aiAdopted, "汎用AI採用結果がありません"),
          graphReconciled: required(graphReconciled, "graph統合結果がありません"),
          personalReminderAnalysis: reminder.value,
          metrics,
          diagnostics,
        });
      },
      publicationPlanned: (validated) => {
        const planned = this.#dependencies.planPublication(validated);
        publicationInput = {
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          repositoryInventory: required(repositoryInventory, "repository一覧がありません"),
          planned,
          metrics,
          status: runStatus,
          diagnostics,
        } satisfies PublicationStageInput<Types>;
        return Promise.resolve(publicationInput);
      },
      ...publicationStages,
    } satisfies NewRunStagePorts<
      DailyEngineStageValues<Types>,
      Awaited<ReturnType<typeof publicationStages.encodeCheckpoint>>
    >;
    if (request.output.kind === "publication") {
      let pendingRunId: string | undefined;
      const outcome = await runTrackingRunSequentially<
        DailyEngineStageValues<Types>,
        Awaited<ReturnType<typeof publicationStages.encodeCheckpoint>>,
        RecoveryStageInput
      >(
        async () => {
          const launch = await this.#dependencies.inspectLaunch(request, invocation.invocationId, {
            kind: "start_new",
          });
          if (launch.decision.kind === "start_new") {
            baseStateHead = launch.decision.baseRevision;
          } else if (launch.decision.kind === "resume_pending") {
            pendingRunId = launch.decision.pending.record.runIdentity.runId;
            invocation = Object.freeze({
              ...invocation,
              runId: pendingRunId,
            });
            lastReceipt = launch.decision.pending.receiptChain.at(-1);
          }
          return launch;
        },
        stages,
        this.#dependencies.pendingRun(
          request,
          invocation.invocationId,
          () => required(pendingRunId, "再開run IDがありません"),
          (receipt) => {
            lastReceipt = receipt;
          },
        ),
        boundary,
      );
      if (outcome.status === "failed") {
        return required(failedResult, "失敗runの報告結果がありません");
      }
      try {
        const stateReport = await this.#dependencies.readCompletedReport(request, outcome);
        const report = completedReportFromState(invocation, stateReport, outcome);
        await this.#dependencies.writeReport(request.reportPath, report);
        return Object.freeze({
          report,
          effects: freezeEffects(effects),
          completedRun: outcome,
        });
      } catch (error: unknown) {
        await boundary.fail("completed", error);
        return required(failedResult, "失敗runの報告結果がありません");
      }
    }
    const launch = await this.#dependencies.inspectLaunch(request, invocation.invocationId, {
      kind: "start_new",
    });
    if (launch.decision.kind !== "start_new") {
      throw new TypeError("解析artifactの起動時に未完了runがあります");
    }
    baseStateHead = launch.decision.baseRevision;
    const analysis = await runTrackingAnalysis<
      DailyEngineStageValues<Types>,
      Awaited<ReturnType<typeof publicationStages.encodeCheckpoint>>
    >(stages, boundary);
    if (analysis.kind === "failed") {
      return required(failedResult, "失敗runの報告結果がありません");
    }
    try {
      const input = analysis.value;
      if (request.output.kind === "dry_run_artifact") {
        stage = "artifact";
        await this.#dependencies.writeDryRunArtifact(
          request.output.path,
          createDryRunArtifact(
            invocation,
            runStatus,
            input.planned,
            metrics,
            diagnostics,
            currentTime(this.#runtime),
          ),
        );
        effects.artifactWritten = true;
      }
      if (request.output.kind === "analysis_artifact") {
        stage = "artifact";
        await this.#dependencies.writeCollectAnalyzeArtifact(request.output.path, input);
        effects.artifactWritten = true;
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
      await boundary.fail(
        stage === "artifact" ? "checkpoint_encoding" : "workflow_effect_observation",
        error,
      );
      return required(failedResult, "失敗runの報告結果がありません");
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

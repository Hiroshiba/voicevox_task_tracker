import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { completeTrackingRun } from "../application/tracking-run/complete-run.js";
import { runTrackingStageOnce } from "../application/tracking-run/engine.js";
import { decodeReceipt } from "../application/tracking-run/receipt-codec.js";
import {
  runtimeRecoveryInputV2Schema,
  workflowEffectObservationV2Schema,
} from "../application/tracking-run/contracts/runtime-recovery-v2.js";
import type { TrackingRunStageName } from "../application/tracking-run/contracts/closed-values.js";
import type { ReceiptChainEntry } from "../application/tracking-run/receipt-chain-schema.js";
import { inspectRunBootstrapState } from "../infrastructure/tracking-run/bootstrap-state.js";
import { inspectRunState } from "../infrastructure/tracking-run/inspect-run-state.js";
import type { RecoveryStageInput } from "../infrastructure/tracking-run/recovery-stage.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import { findInitialStateRevision } from "../persistence/state-orthogonal-advance.js";
import { assertNonNullable } from "../util/index.js";
import type {
  CollectAnalyzeCliCommand,
  RecoverRuntimeV2CliCommand,
  RouteStageCliCommand,
  RunStageCliCommand,
} from "./command.js";
import { DailyTransactionRunner, type DailyRunExecutionResult } from "./daily-transaction.js";
import { readCommittedInitialState } from "./run-publication/committed-state.js";
import {
  persistWorkflowState,
  buildWorkflowPages,
} from "./run-publication/workflow-stage-handlers.js";
import {
  preflightWorkflowPagesDeployment,
  recordWorkflowPagesDeployment,
} from "./run-publication/deployment.js";
import {
  settleWorkflowNotifications,
  finalizeWorkflowRun,
} from "./run-publication/workflow-notifications.js";
import { prepareWorkflowNotificationHistoryPages } from "./run-publication/workflow-history-pages.js";
import {
  preflightWorkflowNotificationHistoryDeployment,
  recordWorkflowNotificationHistoryDeployment,
} from "./run-publication/workflow-history-deployment.js";
import { decodeInitialPagesBuildArtifact } from "./initial-pages-build-artifact.js";
import { readInitialPagesDeploymentOutcome } from "./initial-pages-deployment.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "./notification-history-pages-deployment-outcome.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { readPublicationCheckpointHeader } from "./publication-checkpoint-file.js";
import {
  assertRecordedWorkflowAdapterIdentityV2,
  assertRecoveryToolchain,
  verifyRecoveryBundle,
} from "./publication-runtime.js";
import { projectPublicationSettings } from "./run-publication/settings.js";
import { DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION } from "./durable-record-schema.js";
import { recoverSplitRuntimeV2 } from "./runtime-recovery-acquisition.js";
import type { ProductionRuntimeAdapters } from "./production-runtime/adapters.js";
import type { ProductionTypes } from "./production-runtime/contracts.js";
import {
  appendSplitReceipts,
  initialPagesEvidenceForSplitReceipt,
  readSplitReceiptChain,
  recoverSplitInitialPagesChain,
  stateCommitEvidenceForSplitReceipt,
  writeSplitReceiptChain,
} from "./split-stage-receipts.js";
import { restoreSplitReceipts, verifySplitSettlementReceipt } from "./split-stage-recovery.js";
import { splitStagePaths, type SplitStagePaths } from "./split-stage-paths.js";
import { needsReceiptRestoration } from "./split-stage-artifact-state.js";
import { reconcileSplitPagesOutcomes } from "./split-stage-pages-recovery.js";
import { validateRetainedPages } from "./prior-pages-witness.js";
import { selectPriorPagesArtifacts } from "./prior-pages-artifacts.js";

type SplitState = Readonly<{
  config: Awaited<ReturnType<ProductionRuntimeAdapters["loadConfig"]>>;
  adapter: ReturnType<ProductionRuntimeAdapters["createStateBranchAdapter"]>;
  headRevision: string;
  initialStateRevision: string;
  markerPhase:
    | "initial_state_committed"
    | "notifications_in_progress"
    | "notifications_settled"
    | "run_finalized";
  effectTarget: "production" | "sandbox" | "recording";
  recordDigest: string;
  runtimeIdentityDigest: string;
  workflowEffectAdapterIdentityDigest: string;
  runtimeRecoveryPlan: Extract<
    Awaited<ReturnType<typeof inspectRunBootstrapState>>,
    { kind: "resume_with_exact_runtime" }
  >["record"]["runtimeRecoveryPlan"];
}>;

/** 一段実行した分割runの結果。 */
export type SplitStageExecutionResult = Readonly<{
  result?: DailyRunExecutionResult;
}>;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function previousStage(entries: readonly ReceiptChainEntry[]): TrackingRunStageName {
  const last = entries.at(-1)?.receipt;
  if (last == null || last.stage === "operations_alert") {
    throw new TypeError("分割runの直前receiptがありません");
  }
  if (last.receiptType === "notification_message" || last.receiptType === "manual_resolution") {
    return "initial_pages_published";
  }
  return last.stage;
}

function nextSplitStage(stage: RecoveryStageInput["stage"]): RunStageCliCommand["stage"] {
  switch (stage) {
    case "initial_pages_build":
      return "prepare-initial-pages";
    case "initial_pages_deploy":
      return "preflight-initial-pages-deployment";
    case "notifications":
      return "settle-notifications";
    case "run_finalization":
      return "finalize-run";
    case "notification_history_build":
      return "prepare-history-pages";
    case "notification_history_deploy":
      return "preflight-history-pages-deployment";
    case "completed":
      return "complete";
  }
}

function scopedAdapters(
  adapters: ProductionRuntimeAdapters,
  runId: string,
): ProductionRuntimeAdapters {
  const expected = adapters.environment["VOICEVOX_EXPECTED_RUN_ID"];
  if (expected != null && expected !== runId) {
    throw new TypeError("workflowの期待run IDとrun-stage指定が一致しません");
  }
  return Object.freeze({
    ...adapters,
    environment: Object.freeze({ ...adapters.environment, VOICEVOX_EXPECTED_RUN_ID: runId }),
  });
}

async function inspectSplitState(
  adapters: ProductionRuntimeAdapters,
  configPath: string,
  runId: string,
): Promise<SplitState> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, configPath));
  const adapter = adapters.createStateBranchAdapter();
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status !== "present") {
    throw new TypeError("分割runの永続stateがありません");
  }
  const bootstrap = await inspectRunBootstrapState(adapter, config.state.branch, {
    kind: "retry_run",
    runId,
    exactStateRevision: head.revision,
  });
  if (bootstrap.kind !== "resume_with_exact_runtime") {
    throw new TypeError("分割runのcheckpointに結合したexact runtimeを選べません", {
      cause: bootstrap.kind === "manual_resolution_required" ? bootstrap.cause : undefined,
    });
  }
  if (bootstrap.record.recordSchemaVersion !== DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION) {
    throw new TypeError("分割runの永続record schemaが現行形式ではありません");
  }
  const plan = bootstrap.record.runtimeRecoveryPlan;
  if (plan.kind !== "workflow_bundle" || plan.artifactName !== "workflow-cli-runtime") {
    throw new TypeError("分割runのexact runtimeを再現できません");
  }
  await verifyRecoveryBundle(resolve(adapters.repositoryPath, "artifacts/workflow/runtime"), plan);
  await assertRecoveryToolchain(adapters.repositoryPath, plan);
  await assertRecordedWorkflowAdapterIdentityV2(
    adapters.repositoryPath,
    plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    digest,
  );
  const state = await readNotificationMessageState(adapter, config.state, head.revision);
  const record = state.transaction.record;
  if (
    record.executionPolicy.executionShape !== "split_workflow" ||
    state.transaction.marker.runId !== runId ||
    record.runIdentity.runId !== runId ||
    record.recordDigest !== bootstrap.record.recordDigest ||
    serializeCanonicalJson(projectPublicationSettings(config).pages) !==
      serializeCanonicalJson(record.initialPagesProjection.settings) ||
    digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) !==
      bootstrap.record.runtimeIdentityDigest
  ) {
    throw new TypeError("分割runの永続recordと選択runtimeが一致しません");
  }
  const initialStateRevision =
    state.transaction.marker.phase === "initial_state_committed"
      ? await findInitialStateRevision(adapter, config.state, head.revision, runId)
      : state.transaction.marker.initialStateRevision;
  return {
    config,
    adapter,
    headRevision: head.revision,
    initialStateRevision,
    markerPhase: state.transaction.marker.phase,
    effectTarget: record.executionPolicy.effectTarget,
    recordDigest: bootstrap.record.recordDigest,
    runtimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
    workflowEffectAdapterIdentityDigest: plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: plan,
  };
}

async function verifySplitState(
  state: SplitState,
  runId: string,
  invocationId: string,
  observedAt: string,
  entries: readonly ReceiptChainEntry[],
): Promise<RecoveryStageInput> {
  const decision = await inspectRunState(state.adapter, state.config.state, {
    kind: "resume_run",
    runtime: "exact",
    runId,
    exactStateRevision: state.headRevision,
    expectedRecordDigest: state.recordDigest,
    expectedRuntimeIdentityDigest: state.runtimeIdentityDigest,
    expectedWorkflowEffectAdapterIdentityDigest: state.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: state.runtimeRecoveryPlan,
    observation: { invocationId, observedAt },
    receipts: entries,
  });
  if (decision.kind === "manual_resolution_required") {
    throw new TypeError("分割runのexact stateまたはreceipt chainが不正です", {
      cause: decision.cause,
    });
  }
  if (decision.kind !== "resume_pending") {
    throw new TypeError("分割runのexact stateを再開できません");
  }
  return decision.stageInput;
}

async function priorReceipts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  state: SplitState,
  configPath: string,
): Promise<readonly ReceiptChainEntry[]> {
  await selectPriorPagesArtifacts(adapters, paths, runId);
  let entries: readonly ReceiptChainEntry[] | undefined;
  let chainMissing = false;
  try {
    entries = await readSplitReceiptChain(paths.receiptChain, runId);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
    chainMissing = true;
  }
  if (chainMissing) {
    entries = await recoverSplitInitialPagesChain(
      paths,
      runId,
      state.adapter,
      state.config.state,
      state.initialStateRevision,
    );
  }
  if (entries != null)
    entries = await reconcileSplitPagesOutcomes(
      adapters,
      paths,
      runId,
      state.adapter,
      state.config.state,
      state.initialStateRevision,
      entries,
    );
  if (entries != null) {
    await verifySplitState(state, runId, randomUUID(), adapters.now().toISOString(), entries);
  }
  let settlementReceipt: ReturnType<typeof decodeReceipt> | undefined;
  try {
    settlementReceipt = decodeReceipt(await readFile(paths.settlementReceipt), digest);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  const chainSettlement = entries?.findLast(
    (entry) => entry.receipt.receiptType === "notification_settlement",
  )?.receipt;
  if (settlementReceipt != null || chainSettlement != null) {
    if (state.markerPhase !== "notifications_settled" && state.markerPhase !== "run_finalized") {
      throw new TypeError("remote未確定の通知settlementをartifactが主張しています");
    }
    const recoveryState = {
      adapter: state.adapter,
      configuration: state.config.state,
      headRevision: state.headRevision,
      initialStateRevision: state.initialStateRevision,
    };
    for (const receipt of [settlementReceipt, chainSettlement]) {
      if (receipt == null) {
        continue;
      }
      if (
        receipt.receiptType !== "notification_settlement" ||
        receipt.binding.bindingKind !== "checkpoint"
      ) {
        throw new TypeError("通知settlement artifactのreceipt種別が不正です");
      }
      await verifySplitSettlementReceipt(
        recoveryState,
        runId,
        receipt.binding.checkpointDigest,
        receipt,
      );
    }
    if (
      settlementReceipt != null &&
      chainSettlement != null &&
      settlementReceipt.receiptDigest !== chainSettlement.receiptDigest
    ) {
      throw new TypeError("通知settlement fileとchainのreceipt digestが一致しません");
    }
  }
  if (entries != null) {
    await validateRetainedPages(adapters, paths, entries, runId, configPath, state);
    if (chainMissing) {
      await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
    }
  }
  if (settlementReceipt == null && chainSettlement != null) {
    await adapters.writeJsonArtifact(paths.settlementReceipt, chainSettlement);
  }
  if (entries != null && !(await needsReceiptRestoration(entries, state.markerPhase, paths))) {
    return entries;
  }
  return restoreSplitReceipts(
    adapters,
    paths,
    runId,
    configPath,
    {
      adapter: state.adapter,
      configuration: state.config.state,
      headRevision: state.headRevision,
      initialStateRevision: state.initialStateRevision,
    },
    entries,
  );
}

async function saveStageReceipts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  prior: readonly ReceiptChainEntry[],
  additions: readonly ReceiptChainEntry[],
): Promise<void> {
  const entries = appendSplitReceipts(prior, additions, runId);
  await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
  const receipt = entries.at(-1)?.receipt;
  assertNonNullable(receipt, "分割runの成功receiptがありません");
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({
      runId,
      stage: receipt.stage,
      receiptDigest: receipt.receiptDigest,
      phaseSequence: receipt.phaseSequence,
      receiptChainPath: paths.receiptChain,
    }),
  );
}

/** 分割jobの一つの段階を共通stageとreceipt codecで実行する。 */
export class SplitStageRunner {
  readonly #adapters: ProductionRuntimeAdapters;
  readonly #dailyRunner: DailyTransactionRunner<ProductionTypes>;

  public constructor(
    adapters: ProductionRuntimeAdapters,
    dailyRunner: DailyTransactionRunner<ProductionTypes>,
  ) {
    this.#adapters = adapters;
    this.#dailyRunner = dailyRunner;
  }

  /** 永続bootstrapだけからV2入力を作り、exact bundleの固定入口で一段進める。 */
  public async recover(command: RecoverRuntimeV2CliCommand, invocationId: string): Promise<void> {
    if (
      command.manualResolutionReceiptPath != null &&
      resolve(this.#adapters.repositoryPath, command.manualResolutionReceiptPath) !==
        splitStagePaths(this.#adapters.repositoryPath, command.runId).manualResolutionReceipt
    ) {
      throw new TypeError("V2手動解決receiptはrun別の固定pathが必要です");
    }
    const config = await this.#adapters.loadConfig(
      resolve(this.#adapters.repositoryPath, command.configPath),
    );
    if (config.state.branch !== command.stateRef) {
      throw new TypeError("V2回復のstate refと設定が一致しません");
    }
    const adapter = this.#adapters.createStateBranchAdapter();
    const head = await adapter.resolveHead(command.stateRef);
    if (head.status !== "present") {
      throw new TypeError("V2回復のexact stateがありません");
    }
    const bootstrap = await inspectRunBootstrapState(adapter, command.stateRef, {
      kind: "retry_run",
      runId: command.runId,
      exactStateRevision: head.revision,
    });
    if (
      bootstrap.kind !== "resume_with_exact_runtime" ||
      bootstrap.record.recordSchemaVersion !== 2 ||
      bootstrap.record.runtimeRecoveryPlan.schemaVersion !== 2 ||
      bootstrap.record.runtimeRecoveryPlan.kind !== "workflow_bundle"
    ) {
      throw new TypeError("V2固定入口を持つ未完了runを選べません");
    }
    const plan = bootstrap.record.runtimeRecoveryPlan;
    let observation: unknown;
    if (command.operation === "record_pages") {
      assertNonNullable(command.observationPath, "V2 Pages観測fileがありません");
      const source = await readFile(
        resolve(this.#adapters.repositoryPath, command.observationPath),
        "utf8",
      );
      const raw: unknown = JSON.parse(source);
      if (source !== serializeCanonicalJsonLine(raw)) {
        throw new TypeError("V2 Pages観測fileがcanonical JSONではありません");
      }
      const parsedObservation = workflowEffectObservationV2Schema.parse(raw);
      if (parsedObservation.phase !== command.phase) {
        throw new TypeError("V2 Pages観測fileと指定phaseが一致しません");
      }
      observation = parsedObservation;
    }
    const input = runtimeRecoveryInputV2Schema.parse({
      protocolVersion: 2,
      inputContract: "tracking-run-recovery-input-v2",
      operation: command.operation,
      invocationId,
      configPath: command.configPath,
      stateRef: command.stateRef,
      exactStateRevision: head.revision,
      runId: command.runId,
      runAttempt: command.runAttempt,
      expectedRecordDigest: bootstrap.record.recordDigest,
      expectedRuntimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
      expectedWorkflowEffectAdapterIdentityDigest:
        plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
      runtimeRecoveryPlan: plan,
      ...(command.operation === "execute_stage"
        ? {
            stage: command.stage,
            ...(command.manualResolutionReceiptPath == null
              ? {}
              : { manualResolutionReceiptPath: command.manualResolutionReceiptPath }),
          }
        : {}),
      ...(command.operation === "record_pages" ? { observation } : {}),
    });
    const output = await recoverSplitRuntimeV2(
      this.#adapters.repositoryPath,
      command.bundleRoot == null
        ? undefined
        : resolve(this.#adapters.repositoryPath, command.bundleRoot),
      input,
    );
    const entries = await readSplitReceiptChain(
      splitStagePaths(this.#adapters.repositoryPath, command.runId).receiptChain,
      command.runId,
    );
    if (
      output.runId !== command.runId ||
      output.workflowEffectAdapterIdentityDigest !==
        plan.recoveryProtocol.workflowEffectAdapterIdentityDigest ||
      output.receiptChainDigest !== digest.sha256Utf8(serializeCanonicalJson(entries))
    ) {
      throw new TypeError("V2固定入口の結果とreceipt chainが一致しません");
    }
    const state = await inspectRunBootstrapState(adapter, command.stateRef, {
      kind: "retry_run",
      runId: command.runId,
      exactStateRevision: output.stateRevision,
    });
    if (
      state.kind !== "resume_with_exact_runtime" ||
      state.record.recordDigest !== bootstrap.record.recordDigest
    ) {
      throw new TypeError("V2固定入口の結果と永続recordが一致しません");
    }
    const verified = await inspectRunState(adapter, config.state, {
      kind: "resume_run",
      runtime: "exact",
      runId: command.runId,
      exactStateRevision: output.stateRevision,
      expectedRecordDigest: bootstrap.record.recordDigest,
      expectedRuntimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
      expectedWorkflowEffectAdapterIdentityDigest:
        plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
      runtimeRecoveryPlan: plan,
      observation: { invocationId, observedAt: this.#adapters.now().toISOString() },
      receipts: entries,
    });
    if (verified.kind !== "resume_pending") {
      throw new TypeError("V2固定入口のreceiptとexact stateを検証できません");
    }
    await this.#adapters.writeStandardOutput(serializeCanonicalJsonLine(output));
  }

  /** remote exact stateと検証済みreceiptから次の分割段階を返す。 */
  public async route(command: RouteStageCliCommand, invocationId: string): Promise<void> {
    const config = await this.#adapters.loadConfig(
      resolve(this.#adapters.repositoryPath, command.configPath),
    );
    if (command.stateRef !== config.state.branch) {
      throw new TypeError("route-stageのstate refと設定の保存先が一致しません");
    }
    const adapter = this.#adapters.createStateBranchAdapter();
    const head = await adapter.resolveHead(command.stateRef);
    if (head.status === "missing") {
      if (command.runId != null) {
        throw new TypeError("指定runのremote stateがありません");
      }
      await this.#adapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          schemaVersion: 1,
          runId: null,
          stateRevision: "unborn",
          effectTarget: command.effectTarget,
          nextStage: "analyze",
        }),
      );
      return;
    }
    const bootstrap = await inspectRunBootstrapState(
      adapter,
      command.stateRef,
      command.runId == null
        ? { kind: "start_new" }
        : { kind: "retry_run", runId: command.runId, exactStateRevision: head.revision },
    );
    if (bootstrap.kind === "start_with_current_runtime") {
      await this.#adapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          schemaVersion: 1,
          runId: null,
          stateRevision: head.revision,
          effectTarget: command.effectTarget,
          nextStage: "analyze",
        }),
      );
      return;
    }
    if (bootstrap.kind === "operator_conflict_resolution" && command.runId != null) {
      const current = await inspectRunBootstrapState(adapter, command.stateRef, {
        kind: "start_new",
      });
      if (current.kind === "start_with_current_runtime") {
        const checkpoint = await readPublicationCheckpointHeader(
          splitStagePaths(this.#adapters.repositoryPath, command.runId).checkpoint,
        );
        if (
          checkpoint.runIdentity.runId === command.runId &&
          checkpoint.executionPolicy.effectTarget === command.effectTarget &&
          checkpoint.baseStateRevision.status === "present" &&
          checkpoint.baseStateRevision.revision === head.revision
        ) {
          await this.#adapters.writeStandardOutput(
            serializeCanonicalJsonLine({
              schemaVersion: 1,
              runId: command.runId,
              stateRevision: head.revision,
              effectTarget: command.effectTarget,
              nextStage: "commit-initial-state",
            }),
          );
          return;
        }
      }
    }
    if (bootstrap.kind !== "resume_with_exact_runtime") {
      throw new TypeError("route-stageのremote runを安全に選べません", {
        cause: bootstrap.kind === "manual_resolution_required" ? bootstrap.cause : undefined,
      });
    }
    if (bootstrap.record.recordSchemaVersion !== DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION) {
      throw new TypeError("旧ready-only V1の副作用段階は手動解決が必要です");
    }
    const runId = bootstrap.record.runId;
    const adapters = scopedAdapters(this.#adapters, runId);
    const state = await inspectSplitState(adapters, command.configPath, runId);
    if (state.effectTarget !== command.effectTarget) {
      throw new TypeError("route-stageのeffect targetと永続recordが一致しません");
    }
    const paths = splitStagePaths(adapters.repositoryPath, runId);
    const entries = await priorReceipts(adapters, paths, runId, state, command.configPath);
    const stageInput = await verifySplitState(
      state,
      runId,
      invocationId,
      adapters.now().toISOString(),
      entries,
    );
    const nextStage =
      entries.at(-1)?.receipt.receiptType === "completion"
        ? "done"
        : nextSplitStage(stageInput.stage);
    await adapters.writeStandardOutput(
      serializeCanonicalJsonLine({
        schemaVersion: 1,
        runId,
        stateRevision: state.headRevision,
        recordDigest: state.recordDigest,
        effectTarget: state.effectTarget,
        nextStage,
        receiptChainPath: paths.receiptChain,
      }),
    );
  }

  public async run(
    command: RunStageCliCommand,
    invocationId: string,
  ): Promise<SplitStageExecutionResult> {
    if (command.stage === "analyze") {
      const analysis: CollectAnalyzeCliCommand = {
        kind: "collect-analyze",
        configPath: command.configPath,
        reportPath: "artifacts/run-reports/run-stage-analyze.json",
        artifactPath: "artifacts/workflow/validated-run.json",
        schedule: command.schedule,
        notificationAction: command.notificationAction,
        mode: command.mode,
        repositoryFilter: command.repositoryFilter,
        sandboxContextPath: command.sandboxContextPath,
      };
      const coordinated = await this.#dailyRunner.run(analysis, invocationId);
      if (coordinated.value.report.status !== "failure") {
        const header = await readPublicationCheckpointHeader(
          resolve(this.#adapters.repositoryPath, analysis.artifactPath),
        );
        if (header.runIdentity.runId !== coordinated.value.report.runId) {
          throw new TypeError("解析artifactとrun reportのrun IDが一致しません");
        }
        await this.#adapters.writeStandardOutput(
          serializeCanonicalJsonLine({
            runId: header.runIdentity.runId,
            stage: "publication_planned",
            checkpointPath: resolve(this.#adapters.repositoryPath, analysis.artifactPath),
          }),
        );
      }
      return { result: coordinated.value };
    }
    const runId = command.runId;
    assertNonNullable(runId, "分割runのrun IDがありません");
    const paths = splitStagePaths(this.#adapters.repositoryPath, runId);
    const adapters = scopedAdapters(this.#adapters, runId);
    if (command.stage === "commit-initial-state") {
      let existing: readonly ReceiptChainEntry[] | undefined;
      try {
        existing = await readSplitReceiptChain(paths.receiptChain, runId);
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
      const config = await adapters.loadConfig(
        resolve(adapters.repositoryPath, command.configPath),
      );
      const stateAdapter = adapters.createStateBranchAdapter();
      const head = await stateAdapter.resolveHead(config.state.branch);
      if (head.status === "present") {
        const bootstrap = await inspectRunBootstrapState(stateAdapter, config.state.branch, {
          kind: "retry_run",
          runId,
          exactStateRevision: head.revision,
        });
        if (bootstrap.kind === "resume_with_exact_runtime") {
          const state = await inspectSplitState(adapters, command.configPath, runId);
          const receipts = await priorReceipts(adapters, paths, runId, state, command.configPath);
          await verifySplitState(
            state,
            runId,
            invocationId,
            adapters.now().toISOString(),
            receipts,
          );
          const first = receipts[0]?.receipt;
          if (first?.receiptType !== "initial_state_commit") {
            throw new TypeError("保存済みreceipt chainに初回state commitがありません");
          }
          await adapters.writeJsonArtifact(paths.initialReceipt, first);
          await adapters.writeStandardOutput(
            serializeCanonicalJsonLine({
              runId,
              stage: first.stage,
              receiptDigest: first.receiptDigest,
              phaseSequence: first.phaseSequence,
              receiptChainPath: paths.receiptChain,
            }),
          );
          return {};
        }
        if (bootstrap.kind !== "operator_conflict_resolution") {
          throw new TypeError("初回commit前のstate bootstrapが不正です", {
            cause: bootstrap.kind === "manual_resolution_required" ? bootstrap.cause : undefined,
          });
        }
        const current = await inspectRunBootstrapState(stateAdapter, config.state.branch, {
          kind: "start_new",
        });
        if (current.kind !== "start_with_current_runtime") {
          throw new TypeError("別runの永続stateが初回commitを妨げています");
        }
      }
      const header = await readPublicationCheckpointHeader(paths.checkpoint);
      if (header.runIdentity.runId !== runId) {
        throw new TypeError("初回commitのcheckpointと指定run IDが一致しません");
      }
      if (
        (head.status === "missing" && header.baseStateRevision.status !== "missing") ||
        (head.status === "present" &&
          (header.baseStateRevision.status !== "present" ||
            header.baseStateRevision.revision !== head.revision))
      ) {
        throw new TypeError("初回commitのcheckpoint baseがremote headと一致しません");
      }
      if (existing != null) {
        throw new TypeError("初回receiptがあるのにremote stateに同じrunがありません");
      }
      await runTrackingStageOnce("publication_planned", "initial_state_committed", () =>
        persistWorkflowState(
          { adapters },
          {
            kind: "persist-state",
            configPath: command.configPath,
            artifactPath: paths.checkpoint,
            receiptPath: paths.initialReceipt,
          },
        ),
      );
      const receipt = decodeReceipt(await readFile(paths.initialReceipt), digest);
      if (receipt.receiptType !== "initial_state_commit") {
        throw new TypeError("初回commitのreceipt種別が不正です");
      }
      await readCommittedInitialState({
        adapter: adapters.createStateBranchAdapter(),
        configuration: config.state,
        knownSecrets: [],
        reference: {
          stateRevision: receipt.result.resultingStateRevision,
          stateContentDigest: receipt.result.stateContentDigest,
        },
        now: adapters.now,
      });
      const evidence = await stateCommitEvidenceForSplitReceipt(
        adapters.createStateBranchAdapter(),
        config.state,
        receipt,
        receipt.result.resultingStateRevision,
      );
      await saveStageReceipts(adapters, paths, runId, [], [{ receipt, evidence }]);
      return {};
    }
    const state = await inspectSplitState(adapters, command.configPath, runId);
    const prior = await priorReceipts(adapters, paths, runId, state, command.configPath);
    await verifySplitState(state, runId, invocationId, adapters.now().toISOString(), prior);
    const current = previousStage(prior);
    const execute = <Value>(
      completed: TrackingRunStageName,
      next: TrackingRunStageName,
      action: () => Promise<Value>,
    ): Promise<Value> => {
      if (current !== completed) {
        throw new TypeError("分割runの指定段階と直前receiptが一致しません");
      }
      return runTrackingStageOnce(completed, next, action);
    };
    switch (command.stage) {
      case "prepare-initial-pages": {
        await execute("initial_state_committed", "initial_pages_prepared", () =>
          buildWorkflowPages(
            { adapters },
            {
              kind: "build-pages",
              configPath: command.configPath,
              initialStateReceiptPath: paths.initialReceipt,
              buildArtifactPath: paths.initialBuild,
              outputDirectory: paths.pagesOutput,
            },
          ),
        );
        const build = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
        await saveStageReceipts(adapters, paths, runId, prior, [
          { receipt: build.receipt, evidence: { kind: "none" } },
        ]);
        return {};
      }
      case "preflight-initial-pages-deployment":
        if (current !== "initial_pages_prepared") {
          throw new TypeError("初回Pages deploy前のbuild receiptがありません");
        }
        await preflightWorkflowPagesDeployment(adapters, {
          kind: "preflight-pages-deployment",
          configPath: command.configPath,
          initialStateReceiptPath: paths.initialReceipt,
          buildArtifactPath: paths.initialBuild,
          previousOutcomePath: paths.initialDeployment,
          preflightPath: paths.initialPreflight,
          runAttempt: command.runAttempt,
        });
        await adapters.writeStandardOutput(
          serializeCanonicalJsonLine({
            runId,
            stage: command.stage,
            preflightPath: paths.initialPreflight,
          }),
        );
        return {};
      case "record-initial-pages-deployment": {
        await execute("initial_pages_prepared", "initial_pages_published", () =>
          recordWorkflowPagesDeployment(adapters, {
            kind: "record-pages-deployment",
            buildArtifactPath: paths.initialBuild,
            preflightPath: paths.initialPreflight,
            outcomePath: paths.initialDeployment,
          }),
        );
        const build = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
        const outcome = await readInitialPagesDeploymentOutcome(paths.initialDeployment, build);
        if (outcome.kind !== "success") {
          throw new TypeError("初回Pagesの成功receiptがありません");
        }
        const evidence = await initialPagesEvidenceForSplitReceipt(
          state.adapter,
          state.config.state,
          outcome.receipt,
        );
        await saveStageReceipts(adapters, paths, runId, prior, [
          { receipt: outcome.receipt, evidence },
        ]);
        return {};
      }
      case "settle-notifications": {
        const pagesIndex = prior.findLastIndex(
          (entry) =>
            entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
        );
        const pagesReceipt = prior[pagesIndex]?.receipt;
        if (pagesReceipt?.receiptType !== "pages_deployment") {
          throw new TypeError("通知段階の先行Pages receiptがありません");
        }
        const outcome = await execute("initial_pages_published", "notifications_settled", () =>
          settleWorkflowNotifications(
            adapters,
            {
              kind: "settle-notifications",
              configPath: command.configPath,
              initialStateReceiptPath: paths.initialReceipt,
              buildArtifactPath: paths.initialBuild,
              deploymentOutcomePath: paths.initialDeployment,
              settlementReceiptPath: paths.settlementReceipt,
              ...(command.manualResolutionReceiptPath == null
                ? {}
                : { manualResolutionReceiptPath: command.manualResolutionReceiptPath }),
            },
            pagesReceipt,
          ),
        );
        await saveStageReceipts(adapters, paths, runId, prior.slice(0, pagesIndex + 1), [
          ...outcome.messageReceipts,
          { receipt: outcome.receipt, evidence: outcome.receiptEvidence },
        ]);
        return {};
      }
      case "finalize-run": {
        const outcome = await execute("notifications_settled", "run_finalized", () =>
          finalizeWorkflowRun(adapters, {
            kind: "finalize-run",
            configPath: command.configPath,
            initialStateReceiptPath: paths.initialReceipt,
            settlementReceiptPath: paths.settlementReceipt,
            finalizationReceiptPath: paths.finalizationReceipt,
          }),
        );
        await saveStageReceipts(adapters, paths, runId, prior, [
          { receipt: outcome.receipt, evidence: outcome.receiptEvidence },
        ]);
        return {};
      }
      case "prepare-history-pages": {
        await execute("run_finalized", "notification_history_pages_prepared", () =>
          prepareWorkflowNotificationHistoryPages(adapters, {
            kind: "prepare-notification-history-pages",
            configPath: command.configPath,
            settlementReceiptPath: paths.settlementReceipt,
            finalizationReceiptPath: paths.finalizationReceipt,
            buildArtifactPath: paths.historyBuild,
            outputDirectory: paths.pagesOutput,
          }),
        );
        const build = decodeNotificationHistoryPagesBuildArtifact(
          await readFile(paths.historyBuild),
        );
        await saveStageReceipts(adapters, paths, runId, prior, [
          { receipt: build.receipt, evidence: { kind: "none" } },
        ]);
        return {};
      }
      case "preflight-history-pages-deployment":
        if (current !== "notification_history_pages_prepared") {
          throw new TypeError("通知履歴Pages deploy前のbuild receiptがありません");
        }
        await preflightWorkflowNotificationHistoryDeployment(adapters, {
          kind: "preflight-notification-history-deployment",
          configPath: command.configPath,
          settlementReceiptPath: paths.settlementReceipt,
          finalizationReceiptPath: paths.finalizationReceipt,
          buildArtifactPath: paths.historyBuild,
          previousOutcomePath: paths.historyDeployment,
          preflightPath: paths.historyPreflight,
          runAttempt: command.runAttempt,
        });
        await adapters.writeStandardOutput(
          serializeCanonicalJsonLine({
            runId,
            stage: command.stage,
            preflightPath: paths.historyPreflight,
          }),
        );
        return {};
      case "record-history-pages-deployment": {
        await execute(
          "notification_history_pages_prepared",
          "notification_history_pages_published",
          () =>
            recordWorkflowNotificationHistoryDeployment(adapters, {
              kind: "record-notification-history-deployment",
              buildArtifactPath: paths.historyBuild,
              preflightPath: paths.historyPreflight,
              outcomePath: paths.historyDeployment,
            }),
        );
        const build = decodeNotificationHistoryPagesBuildArtifact(
          await readFile(paths.historyBuild),
        );
        const outcome = decodeNotificationHistoryPagesDeploymentOutcome(
          await readFile(paths.historyDeployment),
          build,
        );
        if (outcome.kind === "failure") {
          throw new TypeError("通知履歴Pagesの成功receiptがありません");
        }
        await saveStageReceipts(adapters, paths, runId, prior, [
          { receipt: outcome.receipt, evidence: { kind: "none" } },
        ]);
        return {};
      }
      case "complete": {
        const completed = await execute("notification_history_pages_published", "completed", () => {
          const finalization = prior.findLast(
            (entry) => entry.receipt.receiptType === "run_finalization",
          )?.receipt;
          if (finalization?.receiptType !== "run_finalization") {
            throw new TypeError("完了に必要なfinalization receiptがありません");
          }
          return Promise.resolve(
            completeTrackingRun(
              {
                entries: prior,
                finalStateRevision: finalization.result.resultingStateRevision,
                invocationId,
                observedAt: adapters.now().toISOString(),
              },
              digest,
            ),
          );
        });
        await adapters.writeJsonArtifact(paths.completionReceipt, completed.receipt);
        await saveStageReceipts(adapters, paths, runId, prior, [
          { receipt: completed.receipt, evidence: { kind: "none" } },
        ]);
        return {};
      }
    }
  }
}

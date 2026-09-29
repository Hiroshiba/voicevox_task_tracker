import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { completeTrackingRun } from "../application/tracking-run/complete-run.js";
import { runTrackingStageOnce } from "../application/tracking-run/engine.js";
import { decodeReceipt } from "../application/tracking-run/receipt-codec.js";
import type { TrackingRunStageName } from "../application/tracking-run/contracts/closed-values.js";
import type { ReceiptChainEntry } from "../application/tracking-run/receipt-chain-schema.js";
import { inspectRunBootstrapState } from "../infrastructure/tracking-run/bootstrap-state.js";
import { inspectRunState } from "../infrastructure/tracking-run/inspect-run-state.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import { observeStateCommitAtRevision } from "../infrastructure/tracking-run/state-receipt-observation.js";
import { findInitialStateRevision } from "../persistence/state-orthogonal-advance.js";
import { assertNonNullable } from "../util/index.js";
import type { CollectAnalyzeCliCommand, RunStageCliCommand } from "./command.js";
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
import { readPublicationRuntimeContext } from "./publication-runtime.js";
import { DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION } from "./durable-record-schema.js";
import type { ProductionRuntimeAdapters } from "./production-runtime/adapters.js";
import type { ProductionTypes } from "./production-runtime/contracts.js";
import {
  appendSplitReceipts,
  initialPagesEvidenceForSplitReceipt,
  readSplitReceiptChain,
  stateCommitEvidenceForSplitReceipt,
  writeSplitReceiptChain,
} from "./split-stage-receipts.js";
import { splitStagePaths, type SplitStagePaths } from "./split-stage-paths.js";

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
  return last.stage;
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
  command: RunStageCliCommand,
  runId: string,
): Promise<SplitState> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
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
  if (plan.kind === "not_reproducible") {
    throw new TypeError("分割runのexact runtimeを再現できません");
  }
  const state = await readNotificationMessageState(adapter, config.state, head.revision);
  const record = state.transaction.record;
  const runtime = await readPublicationRuntimeContext(
    adapters.repositoryPath,
    record.executionPolicy,
    adapters.environment,
  );
  if (
    record.executionPolicy.executionShape !== "split_workflow" ||
    state.transaction.marker.runId !== runId ||
    record.runIdentity.runId !== runId ||
    record.recordDigest !== bootstrap.record.recordDigest ||
    record.configDigest !== digest.sha256Utf8(serializeCanonicalJson(config)) ||
    digest.sha256Utf8(serializeCanonicalJson(runtime.runtimeIdentity)) !==
      bootstrap.record.runtimeIdentityDigest ||
    serializeCanonicalJson(runtime.runtimeRecoveryPlan) !==
      serializeCanonicalJson(record.runtimeRecoveryPlan)
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
): Promise<void> {
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
}

async function priorReceipts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  state: SplitState,
): Promise<readonly ReceiptChainEntry[]> {
  try {
    return await readSplitReceiptChain(paths.receiptChain, runId);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  if (state.markerPhase !== "initial_state_committed") {
    throw new TypeError("後続receipt chainを失った分割runは自動再開できません");
  }
  const observed = await observeStateCommitAtRevision(
    state.adapter,
    state.config.state,
    state.initialStateRevision,
    state.initialStateRevision,
    "initial_state_commit",
    {
      invocationId: randomUUID(),
      observedAt: adapters.now().toISOString(),
      position: { kind: "first" },
    },
  );
  const entries: readonly ReceiptChainEntry[] = [
    { receipt: observed.receipt, evidence: { kind: "state_commit", state: observed.evidence } },
  ];
  await adapters.writeJsonArtifact(paths.initialReceipt, observed.receipt);
  await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
  return entries;
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
      const header = await readPublicationCheckpointHeader(paths.checkpoint);
      if (header.runIdentity.runId !== runId) {
        throw new TypeError("初回commitのcheckpointと指定run IDが一致しません");
      }
      let existing: readonly ReceiptChainEntry[] | undefined;
      try {
        existing = await readSplitReceiptChain(paths.receiptChain, runId);
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
      if (existing != null) {
        const first = existing[0]?.receipt;
        if (
          first?.receiptType !== "initial_state_commit" ||
          first.binding.bindingKind !== "checkpoint" ||
          first.binding.checkpointFileDigest !==
            digest.sha256Bytes(await readFile(paths.checkpoint))
        ) {
          throw new TypeError("保存済みreceipt chainと初回checkpointが一致しません");
        }
        const state = await inspectSplitState(adapters, command, runId);
        await verifySplitState(state, runId, invocationId, adapters.now().toISOString(), existing);
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
      const config = await adapters.loadConfig(
        resolve(adapters.repositoryPath, command.configPath),
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
    const state = await inspectSplitState(adapters, command, runId);
    const prior = await priorReceipts(adapters, paths, runId, state);
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
        const outcome = await execute("initial_pages_published", "notifications_settled", () =>
          settleWorkflowNotifications(adapters, {
            kind: "settle-notifications",
            configPath: command.configPath,
            initialStateReceiptPath: paths.initialReceipt,
            buildArtifactPath: paths.initialBuild,
            deploymentOutcomePath: paths.initialDeployment,
            settlementReceiptPath: paths.settlementReceipt,
            ...(command.manualResolutionReceiptPath == null
              ? {}
              : { manualResolutionReceiptPath: command.manualResolutionReceiptPath }),
          }),
        );
        await saveStageReceipts(adapters, paths, runId, prior, [
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

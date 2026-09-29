import { resolve } from "node:path";

import {
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "../../../canonical-json/value.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import { inspectRunBootstrapState } from "../../../infrastructure/tracking-run/bootstrap-state.js";
import { inspectRunState } from "../../../infrastructure/tracking-run/inspect-run-state.js";
import { receiptChainEnvelopeSchema } from "../../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../../application/tracking-run/receipt-chain.js";
import { completeTrackingRun } from "../../../application/tracking-run/complete-run.js";
import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../../application/tracking-run/contracts/recovery-paths.js";
import { readRunTransactionMarkerRecoveryBootstrap } from "../../../application/tracking-run/recovery-bootstrap.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { readPublicationRuntimeContext } from "../../publication-runtime.js";
import { sequentialReceiptPath } from "../../sequential-receipt-path.js";
import { resolveRuntimeTarget } from "../../production-runtime-setup.js";
import type { ConfigurationRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;

/** 保存済みreceipt列をcanonical形式と連鎖規則で再読込する。 */
export async function readSequentialReceipts(
  repositoryPath: string,
  runId: string,
  readArtifactBytes: ConfigurationRuntimeAdapters["readArtifactBytes"],
): Promise<ReturnType<typeof receiptChainEnvelopeSchema.parse>["entries"]> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      await readArtifactBytes(sequentialReceiptPath(repositoryPath, runId)),
    );
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("保存済みreceipt chainがcanonical JSONではありません");
  }
  const envelope = receiptChainEnvelopeSchema.parse(raw);
  verifyReceiptChain(envelope.entries, nodeContentDigestPort);
  return envelope.entries;
}

/** state bootstrapとexact runtimeを照合して新規開始またはpending再開を選ぶ。 */
export function createInspectLaunchStage(
  adapters: ConfigurationRuntimeAdapters,
  now: () => Date,
): ProductionDailyDependencies["inspectLaunch"] {
  return async (request, invocationId) => {
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
    const adapter = adapters.createStateBranchAdapter();
    let bootstrap = await inspectRunBootstrapState(adapter, target.state.branch, {
      kind: "start_new",
    });
    if (
      bootstrap.kind === "start_with_current_runtime" &&
      bootstrap.observedStateHead.status === "present"
    ) {
      const markerFile = await adapter.readFile(
        bootstrap.observedStateHead.revision,
        RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      );
      if (markerFile.status === "present") {
        const marker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
        if (marker.phase === "run_finalized") {
          bootstrap = await inspectRunBootstrapState(adapter, target.state.branch, {
            kind: "retry_run",
            runId: marker.runId,
            exactStateRevision: bootstrap.observedStateHead.revision,
          });
        }
      }
    }
    if (bootstrap.kind === "start_with_current_runtime") {
      return Object.freeze({
        runtime: "current",
        decision: Object.freeze({ kind: "start_new", baseRevision: bootstrap.observedStateHead }),
      });
    }
    if (bootstrap.kind === "manual_resolution_required") {
      throw new TypeError("state bootstrapが不整合のため手動解決が必要です", {
        cause: bootstrap.cause,
      });
    }
    if (bootstrap.kind === "operator_conflict_resolution") {
      throw new TypeError("state bootstrapのrunが起動要求と一致しません");
    }
    const plan = bootstrap.record.runtimeRecoveryPlan;
    if (plan.kind === "not_reproducible") {
      throw new TypeError("未完了runのruntimeを再現できません");
    }
    const entries = await readSequentialReceipts(
      adapters.repositoryPath,
      bootstrap.record.runId,
      adapters.readArtifactBytes,
    );
    const decision = await inspectRunState(adapter, target.state, {
      kind: "resume_run",
      runtime: "exact",
      runId: bootstrap.record.runId,
      exactStateRevision: bootstrap.observedStateHead.revision,
      expectedRecordDigest: bootstrap.record.recordDigest,
      expectedRuntimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
      expectedWorkflowEffectAdapterIdentityDigest:
        plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
      runtimeRecoveryPlan: plan,
      observation: Object.freeze({ invocationId, observedAt: now().toISOString() }),
      receipts: entries,
    });
    if (decision.kind === "manual_resolution_required") {
      throw new TypeError("exact pending runの検証に失敗しました", { cause: decision.cause });
    }
    if (decision.kind === "operator_conflict_resolution") {
      throw new TypeError(`pending runのstateが変わりました。種別: ${decision.reason}`);
    }
    if (decision.kind !== "resume_pending") {
      throw new TypeError("未完了runの再開段階がありません");
    }
    if (decision.stageInput.stage === "completed") {
      const finalization = entries.findLast(
        (entry) => entry.receipt.receiptType === "run_finalization",
      )?.receipt;
      if (
        finalization?.receiptType !== "run_finalization" ||
        finalization.binding.bindingKind !== "checkpoint" ||
        finalization.binding.runId !== bootstrap.record.runId ||
        entries.at(-1)?.receipt.receiptType !== "pages_deployment"
      ) {
        throw new TypeError("完了済みrunのreceipt chainが不足しています");
      }
      completeTrackingRun(
        {
          entries,
          finalStateRevision: finalization.result.resultingStateRevision,
          invocationId,
          observedAt: now().toISOString(),
        },
        nodeContentDigestPort,
      );
      return Object.freeze({
        runtime: "current",
        decision: Object.freeze({ kind: "start_new", baseRevision: bootstrap.observedStateHead }),
      });
    }
    const runtime = await readPublicationRuntimeContext(
      adapters.repositoryPath,
      request.executionPolicy,
      adapters.environment,
    );
    if (
      nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(runtime.runtimeIdentity)) !==
        bootstrap.record.runtimeIdentityDigest ||
      serializeCanonicalJson(runtime.runtimeRecoveryPlan) !== serializeCanonicalJson(plan)
    ) {
      throw new TypeError("未完了runを実行したexact runtimeが必要です");
    }
    if (
      nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)) !==
        decision.stageInput.record.configDigest ||
      serializeCanonicalJson(request.executionPolicy) !==
        serializeCanonicalJson(decision.stageInput.record.executionPolicy)
    ) {
      throw new TypeError("未完了runと設定または実行方針が一致しません");
    }
    return Object.freeze({
      runtime: "exact",
      decision: Object.freeze({ kind: "resume_pending", pending: decision.stageInput }),
    });
  };
}

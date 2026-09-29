import { resolve } from "node:path";

import { hashCanonicalJson } from "../../../canonical-json/index.js";
import type { CompletedRun } from "../../../application/tracking-run/complete-run.js";
import type { RunRequest } from "../../../application/tracking-run/request.js";
import { joinStatePath } from "../../../persistence/branch-adapter.js";
import {
  createStateRunReport,
  serializeStateRunReport,
  type StateRunReport,
} from "../../../persistence/state-run-report.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { readNotificationMessageState } from "../../notification-message-state.js";
import { resolveRuntimeTarget } from "../../production-runtime-setup.js";
import type { ConfigurationRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

/** 完了済みrunのreportを最終exact stateから検証して読む。 */
export function createReadCompletedReportStage(
  adapters: ConfigurationRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["readCompletedReport"] {
  return async (request: RunRequest, completed: CompletedRun): Promise<StateRunReport> => {
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
    const state = await readNotificationMessageState(
      adapters.createStateBranchAdapter(),
      target.state,
      completed.finalStateRevision,
    );
    const record = state.transaction.record;
    const finalization = completed.chain.receipts.findLast(
      (receipt) => receipt.receiptType === "run_finalization",
    );
    if (
      state.transaction.marker.phase !== "run_finalized" ||
      finalization?.receiptType !== "run_finalization" ||
      finalization.result.resultingStateRevision !== completed.finalStateRevision ||
      finalization.binding.bindingKind !== "checkpoint" ||
      finalization.binding.runId !== record.runIdentity.runId ||
      state.snapshot.run.id !== record.runIdentity.runId
    ) {
      throw new TypeError("完了runの最終stateとreceiptが一致しません");
    }
    const path = joinStatePath(
      target.state.runReportsDirectory,
      `${record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
    );
    const file = state.files.get(path);
    if (file?.status !== "present") {
      throw new TypeError("完了runの保存済みreportがありません");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const report = createStateRunReport(JSON.parse(source));
    if (
      source !== serializeStateRunReport(report) ||
      report.runId !== record.runIdentity.runId ||
      report.status !== record.runFinalizationPolicy.report.status ||
      state.snapshot.run.status !== report.status ||
      state.transaction.marker.finalRunReportDigest !== hashCanonicalJson(report) ||
      finalization.result.runReportDigest !== hashCanonicalJson(report)
    ) {
      throw new TypeError("完了runの保存済みreportが最終stateと一致しません");
    }
    return report;
  };
}

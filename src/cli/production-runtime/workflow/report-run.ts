import { resolve } from "node:path";

import type { ReportWorkflowCliCommand } from "../../command.js";
import { finalizedWorkflowStateReport } from "../../run-publication/workflow-report.js";
import { createWorkflowRunReport, readOptionalRunReportFile } from "../../workflow-run-report.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type WorkflowReportRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "repositoryPath"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "environment"
  | "discordHttpClient"
  | "diagnosticsRecorder"
  | "now"
  | "writeJsonArtifact"
>;

/** workflowの結果報告を保存する。 */
export async function reportWorkflowRun(
  adapters: WorkflowReportRuntimeAdapters,
  command: ReportWorkflowCliCommand,
): Promise<void> {
  const collectAnalyzeReport = await readOptionalRunReportFile(
    resolve(adapters.repositoryPath, command.collectAnalyzeReportPath),
  );
  const finalReport = await finalizedWorkflowStateReport(adapters, command);
  const report = createWorkflowRunReport({
    workflowRunId: command.workflowRunId,
    workflowRunAttempt: command.workflowRunAttempt,
    jobs: command.jobResults,
    collectAnalyzeReport,
    finalReport,
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outputPath), report);
}

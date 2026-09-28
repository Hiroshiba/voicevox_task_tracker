import { readFile } from "node:fs/promises";

import { z } from "zod";

import { CliWorkflowArtifactError } from "./errors.js";
import { createStateRunReport, type StateRunReport } from "../persistence/state-run-report.js";
import {
  createEmptyRunMetrics,
  createRunReport,
  type RunMetrics,
  type RunReport,
} from "./run-report.js";

const workflowJobResultSchema = z.enum(["success", "failure", "cancelled", "skipped"]);
const workflowJobResultsSchema = z.strictObject({
  quality: workflowJobResultSchema,
  "collect-analyze": workflowJobResultSchema,
  "persist-state": workflowJobResultSchema,
  "build-pages": workflowJobResultSchema,
  "deploy-pages": workflowJobResultSchema,
  "notify-discord": workflowJobResultSchema,
  "publish-notification-history": workflowJobResultSchema,
  "notify-operations": workflowJobResultSchema,
});
const workflowRunReportInputSchema = z.strictObject({
  workflowRunId: z
    .string()
    .regex(/^[1-9]\d*$/u, "workflow run IDには1以上の整数を指定してください")
    .max(100, "workflow run IDは100文字以内にしてください"),
  workflowRunAttempt: z.number().int().positive(),
  jobs: workflowJobResultsSchema,
  collectAnalyzeReport: z.union([z.record(z.string(), z.unknown()), z.null()]),
  finalReport: z.union([z.record(z.string(), z.unknown()), z.null()]),
});
const fileNotFoundErrorSchema = z.object({
  code: z.literal("ENOENT"),
});

/** GitHub Actions jobが返す完了結果。 */
export type WorkflowJobResult = z.output<typeof workflowJobResultSchema>;

/** 日次workflowで集約する全jobの完了結果。 */
export type WorkflowJobResults = Readonly<z.output<typeof workflowJobResultsSchema>>;

/** 最終state reportと全job結果をまとめたworkflow run report。 */
export type WorkflowRunReport = Readonly<{
  schemaVersion: "6";
  workflowRunId: string;
  workflowRunAttempt: number;
  status: "success" | "fallback" | "failure";
  complete: boolean;
  jobs: WorkflowJobResults;
  metrics: RunMetrics;
  collectAnalyzeReport: RunReport | null;
  finalReport: StateRunReport | null;
}>;

/** 最終state reportと全job結果を検証してworkflow run reportを作る。 */
export function createWorkflowRunReport(value: unknown): WorkflowRunReport {
  const parsed = workflowRunReportInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("workflow run reportの入力検証に失敗しました", {
      cause: parsed.error,
    });
  }
  const collectAnalyzeReport =
    parsed.data.collectAnalyzeReport == null
      ? null
      : createRunReport(parsed.data.collectAnalyzeReport);
  const finalReport =
    parsed.data.finalReport == null ? null : createStateRunReport(parsed.data.finalReport);
  if (collectAnalyzeReport != null && collectAnalyzeReport.command !== "collect-analyze") {
    throw new TypeError("workflow run reportにはcollect-analyzeのCLI reportを指定してください");
  }
  if (
    finalReport != null &&
    collectAnalyzeReport != null &&
    (collectAnalyzeReport.status === "failure" ||
      collectAnalyzeReport.runId !== finalReport.runId ||
      collectAnalyzeReport.status !== finalReport.status)
  ) {
    throw new TypeError("workflowの最終state reportと収集run reportが一致しません");
  }
  const status = finalReport?.status ?? "failure";
  const metrics = finalReport?.metrics ?? collectAnalyzeReport?.metrics ?? createEmptyRunMetrics();
  return Object.freeze({
    schemaVersion: "6",
    workflowRunId: parsed.data.workflowRunId,
    workflowRunAttempt: parsed.data.workflowRunAttempt,
    status,
    complete: finalReport != null,
    jobs: Object.freeze({
      ...parsed.data.jobs,
    }),
    metrics: Object.freeze({
      ...metrics,
    }),
    collectAnalyzeReport,
    finalReport,
  });
}

/** 存在するCLI run reportを検証して読み、未作成ならnullを返す。 */
export async function readOptionalRunReportFile(path: string): Promise<RunReport | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (fileNotFoundErrorSchema.safeParse(error).success) {
      return null;
    }
    throw new CliWorkflowArtifactError(path, "invalid", {
      cause: error,
    });
  }
  try {
    const parseJson: (input: string) => unknown = JSON.parse;
    return createRunReport(parseJson(source));
  } catch (error: unknown) {
    throw new CliWorkflowArtifactError(path, "invalid", {
      cause: error,
    });
  }
}

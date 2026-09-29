import { z } from "zod";

import type { NotificationAction } from "../application/tracking-run/contracts/closed-values.js";
import { optionalSingleOption, parseOptions, singleOption, usageError } from "./command-options.js";
import {
  parseBackfillMode,
  parseNotificationAction,
  parseRepositoryFilter,
  parseSchedule,
} from "./command-online-options.js";
import type { CliSchedule } from "./command.js";

const splitTrackingStageNames = [
  "analyze",
  "commit-initial-state",
  "prepare-initial-pages",
  "preflight-initial-pages-deployment",
  "record-initial-pages-deployment",
  "settle-notifications",
  "finalize-run",
  "prepare-history-pages",
  "preflight-history-pages-deployment",
  "record-history-pages-deployment",
  "complete",
] as const;

/** 一つの分割run段階を進めるCLI入力。 */
export type RunStageCliCommand = Readonly<{
  kind: "run-stage";
  stage: (typeof splitTrackingStageNames)[number];
  configPath: string;
  runId: string | undefined;
  runAttempt: number;
  schedule: CliSchedule;
  notificationAction: NotificationAction;
  mode: "none" | "linked" | "all-open";
  repositoryFilter: readonly string[];
  manualResolutionReceiptPath: string | undefined;
}>;

/** 一段の分割run入力を解析する。 */
export function parseRunStage(args: readonly string[]): RunStageCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--stage",
      "--config",
      "--run-id",
      "--run-attempt",
      "--scheduled-for",
      "--notification-action",
      "--mode",
      "--repository",
      "--manual-resolution-receipt",
    ]),
  );
  const stageValue = optionalSingleOption(options, "--stage");
  if (stageValue == null) {
    throw usageError("run-stageには--stageが必要です");
  }
  const stage = z.enum(splitTrackingStageNames).safeParse(stageValue);
  if (!stage.success) {
    throw usageError("--stageが不正です", stage.error);
  }
  const runId = optionalSingleOption(options, "--run-id");
  if ((stage.data === "analyze") !== (runId == null)) {
    throw usageError("analyze以外のrun-stageには--run-idが必要です");
  }
  if (runId != null && !/^tracker-run:[0-9a-f]{64}$/u.test(runId)) {
    throw usageError("--run-idが不正です");
  }
  const runAttempt = Number(singleOption(options, "--run-attempt", "1"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw usageError("--run-attemptには1以上の整数を指定してください");
  }
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  if (
    stage.data !== "analyze" &&
    (options.has("--scheduled-for") ||
      options.has("--notification-action") ||
      options.has("--mode") ||
      options.has("--repository"))
  ) {
    throw usageError("解析用optionはanalyze段階だけに指定してください");
  }
  const manualResolutionReceiptPath = optionalSingleOption(options, "--manual-resolution-receipt");
  if (manualResolutionReceiptPath != null && stage.data !== "settle-notifications") {
    throw usageError("--manual-resolution-receiptは通知段階だけに指定してください");
  }
  return Object.freeze({
    kind: "run-stage",
    stage: stage.data,
    configPath: singleOption(options, "--config", "config.yml"),
    runId,
    runAttempt,
    schedule: parseSchedule(options),
    notificationAction: parseNotificationAction(options),
    mode,
    repositoryFilter,
    manualResolutionReceiptPath,
  });
}

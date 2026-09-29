import { parseOptions, singleOption, usageError } from "./command-options.js";

const DEFAULT_CONFIG_PATH = "config.yml";
const DEFAULT_SETTLEMENT_RECEIPT_PATH = "artifacts/workflow/notification-settlement-receipt.json";
const DEFAULT_FINALIZATION_RECEIPT_PATH = "artifacts/workflow/run-finalization-receipt.json";
const DEFAULT_HISTORY_BUILD_PATH = "artifacts/workflow/notification-history-pages-build.json";
const DEFAULT_PREFLIGHT_PATH = "artifacts/workflow/notification-history-pages-preflight.json";

/** 最終stateから通知履歴Pagesの公開要否とbuild artifactを作る入力。 */
export type PrepareNotificationHistoryPagesCliCommand = Readonly<{
  kind: "prepare-notification-history-pages";
  configPath: string;
  settlementReceiptPath: string;
  finalizationReceiptPath: string;
  buildArtifactPath: string;
  outputDirectory: string;
}>;

/** 通知履歴Pages action直前の正本と出力を検証するCLI入力。 */
export type PreflightNotificationHistoryDeploymentCliCommand = Readonly<{
  kind: "preflight-notification-history-deployment";
  configPath: string;
  settlementReceiptPath: string;
  finalizationReceiptPath: string;
  buildArtifactPath: string;
  previousOutcomePath: string;
  preflightPath: string;
  runAttempt: number;
}>;

/** 通知履歴Pages actionの実結果を記録するCLI入力。 */
export type RecordNotificationHistoryDeploymentCliCommand = Readonly<{
  kind: "record-notification-history-deployment";
  buildArtifactPath: string;
  preflightPath: string;
  outcomePath: string;
}>;

/** 通知履歴Pages build commandを解析する。 */
export function parsePrepareNotificationHistoryPages(
  args: readonly string[],
): PrepareNotificationHistoryPagesCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--settlement-receipt",
      "--finalization-receipt",
      "--build-artifact",
      "--output",
    ]),
  );
  return Object.freeze({
    kind: "prepare-notification-history-pages",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    settlementReceiptPath: singleOption(
      options,
      "--settlement-receipt",
      DEFAULT_SETTLEMENT_RECEIPT_PATH,
    ),
    finalizationReceiptPath: singleOption(
      options,
      "--finalization-receipt",
      DEFAULT_FINALIZATION_RECEIPT_PATH,
    ),
    buildArtifactPath: singleOption(options, "--build-artifact", DEFAULT_HISTORY_BUILD_PATH),
    outputDirectory: singleOption(options, "--output", "web/public/data"),
  });
}

/** 通知履歴Pages preflight commandを解析する。 */
export function parsePreflightNotificationHistoryDeployment(
  args: readonly string[],
): PreflightNotificationHistoryDeploymentCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--settlement-receipt",
      "--finalization-receipt",
      "--build-artifact",
      "--previous-outcome",
      "--preflight",
      "--run-attempt",
    ]),
  );
  const runAttempt = Number(singleOption(options, "--run-attempt", "1"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw usageError("--run-attemptには1以上の整数を指定してください");
  }
  return Object.freeze({
    kind: "preflight-notification-history-deployment",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    settlementReceiptPath: singleOption(
      options,
      "--settlement-receipt",
      DEFAULT_SETTLEMENT_RECEIPT_PATH,
    ),
    finalizationReceiptPath: singleOption(
      options,
      "--finalization-receipt",
      DEFAULT_FINALIZATION_RECEIPT_PATH,
    ),
    buildArtifactPath: singleOption(options, "--build-artifact", DEFAULT_HISTORY_BUILD_PATH),
    previousOutcomePath: singleOption(
      options,
      "--previous-outcome",
      "artifacts/workflow/previous/notification-history-pages-deployment.json",
    ),
    preflightPath: singleOption(options, "--preflight", DEFAULT_PREFLIGHT_PATH),
    runAttempt,
  });
}

/** 通知履歴Pages action記録commandを解析する。 */
export function parseRecordNotificationHistoryDeployment(
  args: readonly string[],
): RecordNotificationHistoryDeploymentCliCommand {
  const options = parseOptions(args, new Set(["--build-artifact", "--preflight", "--outcome"]));
  return Object.freeze({
    kind: "record-notification-history-deployment",
    buildArtifactPath: singleOption(options, "--build-artifact", DEFAULT_HISTORY_BUILD_PATH),
    preflightPath: singleOption(options, "--preflight", DEFAULT_PREFLIGHT_PATH),
    outcomePath: singleOption(
      options,
      "--outcome",
      "artifacts/workflow/notification-history-pages-deployment.json",
    ),
  });
}

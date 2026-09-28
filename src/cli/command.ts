import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import { z } from "zod";
import {
  notificationActionSchema,
  type NotificationAction,
} from "../application/tracking-run/contracts/closed-values.js";
import { assertNonNullable } from "../util/index.js";
import { CliUsageError } from "./errors.js";
import { type WorkflowJobResult, type WorkflowJobResults } from "./workflow-run-report.js";

const DEFAULT_CONFIG_PATH = "config.yml";
const DEFAULT_REPORT_DIRECTORY = "artifacts/run-reports";
const DEFAULT_ARTIFACT_DIRECTORY = "artifacts";
const DEFAULT_WORKFLOW_ARTIFACT_PATH = "artifacts/workflow/validated-run.json";
const DEFAULT_INITIAL_STATE_RECEIPT_PATH = "artifacts/workflow/initial-state-commit-receipt.json";
const DEFAULT_COLLECT_ANALYZE_REPORT_PATH = `${DEFAULT_REPORT_DIRECTORY}/collect-analyze.json`;
const DEFAULT_WORKFLOW_REPORT_PATH = `${DEFAULT_REPORT_DIRECTORY}/workflow.json`;
const REPOSITORY_FILTER_PATTERN = /^VOICEVOX\/[A-Za-z0-9._-]+$/u;
const DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;
export { notificationActionSchema, type NotificationAction };
const deliveryIdSchema = z.string().regex(DELIVERY_ID_PATTERN);
const resolveDiscordDeliveryResolutionSchema = z.enum(["retry", "acknowledge"]);

/** runの予定時刻を現在時刻または明示値から決める指定。 */
export type CliSchedule =
  | Readonly<{
      kind: "current_time";
    }>
  | Readonly<{
      kind: "specified";
      value: UtcIsoDateTime;
    }>;

type OnlineCommandFields = Readonly<{
  configPath: string;
  reportPath: string;
  schedule: CliSchedule;
}>;

type NotificationActionCommandFields = Readonly<{
  notificationAction: NotificationAction;
}>;

/** 通常の日次実行を表すCLI入力。 */
export type DailyCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "daily";
    sandboxContextPath: string | undefined;
  }>;

/** 外部公開を行わない日次実行を表すCLI入力。 */
export type DryRunCliCommand = OnlineCommandFields &
  Readonly<{
    kind: "dry-run";
    artifactPath: string;
  }>;

/** 追跡対象を追加する日次実行を表すCLI入力。 */
export type BackfillCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "backfill";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
  }>;

/** workflowの収集と判定だけを行うCLI入力。 */
export type CollectAnalyzeCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "collect-analyze";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
    artifactPath: string;
  }>;

/** 検証済みworkflow artifactをstate branchへ保存するCLI入力。 */
export type PersistStateCliCommand = Readonly<{
  kind: "persist-state";
  configPath: string;
  artifactPath: string;
  receiptPath: string;
}>;

/** 検証済みworkflow artifactからPages用データを生成するCLI入力。 */
export type BuildPagesCliCommand = Readonly<{
  kind: "build-pages";
  configPath: string;
  initialStateReceiptPath: string;
  buildArtifactPath: string;
  outputDirectory: string;
}>;

/** Pagesのdeploy成功後にDiscord通知を送るCLI入力。 */
export type NotifyDiscordCliCommand = Readonly<{
  kind: "notify-discord";
  configPath: string;
  artifactPath: string;
  pagesUrl: string;
}>;

/** Discord通知の送信保留を解除するCLI入力。 */
export type ResolveDiscordDeliveryCliCommand = Readonly<{
  kind: "resolve-discord-delivery";
  configPath: string;
  deliveryId: string;
  resolution: "retry" | "acknowledge";
}>;

type NotifyOperationsCommandFields = Readonly<{
  kind: "notify-operations";
  configPath: string;
  incidentId: string;
  occurredAt: UtcIsoDateTime;
  retryAttempts: number;
}>;

/** workflow障害時に運用障害通知だけを送るCLI入力。 */
export type NotifyOperationsCliCommand = NotifyOperationsCommandFields &
  (
    | Readonly<{
        incidentKind: "collection";
        collectAnalyzeReportPath: string;
        publicBoundaryStatus: "confirmed" | "not_confirmed" | "unclassified";
      }>
    | Readonly<{ incidentKind: "pages" | "discord" }>
  );

/** workflow全体のjob結果をCLI reportへ統合する入力。 */
export type ReportWorkflowCliCommand = Readonly<{
  kind: "report-workflow";
  collectAnalyzeReportPath: string;
  outputPath: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  jobResults: WorkflowJobResults;
}>;

/** 指定した永続stateディレクトリを検証するCLI入力。 */
export type VerifyStateCliCommand = Readonly<{
  kind: "verify-state";
  stateDirectory: string;
  configPath: string;
}>;

/** v19 checkpointとexact baseの結合を検証するCLI入力。 */
export type VerifyCheckpointCliCommand = Readonly<{
  kind: "verify-checkpoint";
  configPath: string;
  artifactPath: string;
}>;

/** 固定V1 protocolでexact runtimeを検証するCLI入力。 */
export type VerifyRuntimeRecoveryCliCommand = Readonly<{
  kind: "verify-runtime-recovery";
  inputPath: string;
  bundleRoot: string | undefined;
}>;

/** 永続stateの起動またはrun指定再開を判定する入力。 */
export type InspectRunStateCliCommand = Readonly<{
  kind: "inspect-run-state";
  configPath: string;
  stateRef: string | undefined;
  recoveryIntent:
    | Readonly<{ kind: "start_new" }>
    | Readonly<{ kind: "retry_run"; runId: string; exactStateRevision: string }>;
}>;

/** receipt列の保存内容を検証する入力。 */
export type VerifyReceiptChainCliCommand = Readonly<{
  kind: "verify-receipt-chain";
  inputPath: string;
}>;

/** 記録済み失敗runから公開artifactを作る入力。 */
export type ReportFailureCliCommand = Readonly<{
  kind: "report-failure";
  inputPath: string;
  outputPath: string;
}>;

/** CLIの使用方法だけを表示する入力。 */
export type HelpCliCommand = Readonly<{
  kind: "help";
}>;

/** サポートする全サブコマンドの検証済み入力。 */
export type CliCommand =
  | DailyCliCommand
  | DryRunCliCommand
  | BackfillCliCommand
  | CollectAnalyzeCliCommand
  | PersistStateCliCommand
  | BuildPagesCliCommand
  | NotifyDiscordCliCommand
  | ResolveDiscordDeliveryCliCommand
  | NotifyOperationsCliCommand
  | ReportWorkflowCliCommand
  | VerifyStateCliCommand
  | VerifyCheckpointCliCommand
  | VerifyRuntimeRecoveryCliCommand
  | InspectRunStateCliCommand
  | VerifyReceiptChainCliCommand
  | ReportFailureCliCommand
  | HelpCliCommand;

type ParsedOptions = ReadonlyMap<string, readonly string[]>;

function usageError(message: string, cause?: unknown): CliUsageError {
  return new CliUsageError(message, cause == null ? {} : { cause });
}

function parseOptions(args: readonly string[], allowedOptions: ReadonlySet<string>): ParsedOptions {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    assertNonNullable(name, "CLI option名を取得できませんでした");
    if (!name.startsWith("--") || !allowedOptions.has(name)) {
      throw usageError(`未対応のoptionです。対象: ${name}`);
    }
    if (value == null || value.startsWith("--")) {
      throw usageError(`${name}には値が必要です`);
    }
    const existing = values.get(name) ?? [];
    values.set(name, [...existing, value]);
  }
  return values;
}

function singleOption(options: ParsedOptions, name: string, fallback: string): string {
  const values = options.get(name);
  if (values == null) {
    return fallback;
  }
  if (values.length !== 1) {
    throw usageError(`${name}は1回だけ指定してください`);
  }
  const value = values[0];
  assertNonNullable(value, `${name}の値を取得できませんでした`);
  if (value.length === 0) {
    throw usageError(`${name}に空文字は指定できません`);
  }
  return value;
}

function optionalSingleOption(options: ParsedOptions, name: string): string | undefined {
  const values = options.get(name);
  if (values == null) {
    return undefined;
  }
  if (values.length !== 1) {
    throw usageError(`${name}は1回だけ指定してください`);
  }
  const value = values[0];
  assertNonNullable(value, `${name}の値を取得できませんでした`);
  if (value.length === 0) {
    throw usageError(`${name}に空文字は指定できません`);
  }
  return value;
}

function requiredSingleOption(options: ParsedOptions, name: string, commandName: string): string {
  const value = optionalSingleOption(options, name);
  if (value == null) {
    throw usageError(`${commandName}には${name}が必要です`);
  }
  return value;
}

function parseSchedule(options: ParsedOptions): CliSchedule {
  const value = optionalSingleOption(options, "--scheduled-for");
  if (value == null) {
    return Object.freeze({
      kind: "current_time",
    });
  }
  try {
    return Object.freeze({
      kind: "specified",
      value: createUtcIsoDateTime(value),
    });
  } catch (error: unknown) {
    throw usageError("--scheduled-forにはタイムゾーン付きISO 8601日時を指定してください", error);
  }
}

function parseNotificationAction(options: ParsedOptions): NotificationAction {
  const result = notificationActionSchema.safeParse(
    singleOption(options, "--notification-action", "send"),
  );
  if (!result.success) {
    throw usageError(
      "--notification-actionにはsend、holdまたはacknowledge-currentを指定してください",
      result.error,
    );
  }
  return result.data;
}

function assertDifferentOutputPaths(reportPath: string, artifactPath: string): void {
  if (reportPath === artifactPath) {
    throw usageError("--reportと--artifactには異なるパスを指定してください");
  }
}

function parseOnlineFields(
  commandName: "daily" | "dry-run" | "backfill" | "collect-analyze",
  options: ParsedOptions,
): OnlineCommandFields {
  return Object.freeze({
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    reportPath: singleOption(
      options,
      "--report",
      `${DEFAULT_REPORT_DIRECTORY}/${commandName}.json`,
    ),
    schedule: parseSchedule(options),
  });
}

function parseDaily(args: readonly string[]): DailyCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--notification-action",
      "--report",
      "--sandbox-context",
      "--scheduled-for",
    ]),
  );
  return Object.freeze({
    kind: "daily",
    ...parseOnlineFields("daily", options),
    notificationAction: parseNotificationAction(options),
    sandboxContextPath: optionalSingleOption(options, "--sandbox-context"),
  });
}

function parseDryRun(args: readonly string[]): DryRunCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--config", "--report", "--scheduled-for"]),
  );
  const fields = parseOnlineFields("dry-run", options);
  const artifactPath = singleOption(
    options,
    "--artifact",
    `${DEFAULT_ARTIFACT_DIRECTORY}/dry-run.json`,
  );
  assertDifferentOutputPaths(fields.reportPath, artifactPath);
  return Object.freeze({
    kind: "dry-run",
    ...fields,
    artifactPath,
  });
}

function parseBackfillMode(value: string): BackfillCliCommand["mode"] {
  switch (value) {
    case "none":
    case "linked":
    case "all-open":
      return value;
    default:
      throw usageError("--modeにはnone、linked、all-openのいずれかを指定してください");
  }
}

function parseRepositoryFilter(options: ParsedOptions): readonly string[] {
  const repositoryFilter = options.get("--repository") ?? [];
  for (const repository of repositoryFilter) {
    if (!REPOSITORY_FILTER_PATTERN.test(repository)) {
      throw usageError("--repositoryにはVOICEVOX配下のowner/name形式を指定してください");
    }
  }
  if (new Set(repositoryFilter).size !== repositoryFilter.length) {
    throw usageError("--repositoryを重複して指定できません");
  }
  return Object.freeze([...repositoryFilter].sort());
}

function parseBackfill(args: readonly string[]): BackfillCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--mode",
      "--notification-action",
      "--report",
      "--repository",
      "--scheduled-for",
    ]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  return Object.freeze({
    kind: "backfill",
    ...parseOnlineFields("backfill", options),
    notificationAction: parseNotificationAction(options),
    mode,
    repositoryFilter,
  });
}

function parseCollectAnalyze(args: readonly string[]): CollectAnalyzeCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--artifact",
      "--config",
      "--mode",
      "--notification-action",
      "--report",
      "--repository",
      "--scheduled-for",
    ]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  const fields = parseOnlineFields("collect-analyze", options);
  const artifactPath = singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH);
  assertDifferentOutputPaths(fields.reportPath, artifactPath);
  return Object.freeze({
    kind: "collect-analyze",
    ...fields,
    notificationAction: parseNotificationAction(options),
    mode,
    repositoryFilter,
    artifactPath,
  });
}

function parsePersistState(args: readonly string[]): PersistStateCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config", "--receipt"]));
  const artifactPath = singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH);
  const receiptPath = singleOption(options, "--receipt", DEFAULT_INITIAL_STATE_RECEIPT_PATH);
  assertDifferentOutputPaths(artifactPath, receiptPath);
  return Object.freeze({
    kind: "persist-state",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    artifactPath,
    receiptPath,
  });
}

function parseBuildPages(args: readonly string[]): BuildPagesCliCommand {
  const options = parseOptions(
    args,
    new Set(["--receipt", "--build-artifact", "--config", "--output"]),
  );
  return Object.freeze({
    kind: "build-pages",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    initialStateReceiptPath: singleOption(options, "--receipt", DEFAULT_INITIAL_STATE_RECEIPT_PATH),
    buildArtifactPath: singleOption(
      options,
      "--build-artifact",
      "artifacts/workflow/initial-pages-build.json",
    ),
    outputDirectory: singleOption(options, "--output", "web/public/data"),
  });
}

function parsePagesUrl(options: ParsedOptions): string {
  const value = optionalSingleOption(options, "--pages-url");
  if (value == null) {
    throw usageError("notify-discordにはPages deploy成功時の--pages-urlが必要です");
  }
  if (!URL.canParse(value)) {
    throw usageError("--pages-urlには有効なHTTPS URLを指定してください");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw usageError("--pages-urlには認証情報とfragmentを含まないHTTPS URLを指定してください");
  }
  return url.href;
}

function parseNotifyDiscord(args: readonly string[]): NotifyDiscordCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config", "--pages-url"]));
  return Object.freeze({
    kind: "notify-discord",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    artifactPath: singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH),
    pagesUrl: parsePagesUrl(options),
  });
}

function parseResolveDiscordDelivery(args: readonly string[]): ResolveDiscordDeliveryCliCommand {
  const options = parseOptions(args, new Set(["--config", "--delivery-id", "--resolution"]));
  const deliveryIdSource = requiredSingleOption(
    options,
    "--delivery-id",
    "resolve-discord-delivery",
  );
  const deliveryIdResult = deliveryIdSchema.safeParse(deliveryIdSource);
  if (!deliveryIdResult.success) {
    throw usageError(
      "--delivery-idにはdiscord-digest:v1のdelivery IDを指定してください",
      deliveryIdResult.error,
    );
  }
  const resolutionResult = resolveDiscordDeliveryResolutionSchema.safeParse(
    requiredSingleOption(options, "--resolution", "resolve-discord-delivery"),
  );
  if (!resolutionResult.success) {
    throw usageError(
      "--resolutionにはretryまたはacknowledgeを指定してください",
      resolutionResult.error,
    );
  }
  return Object.freeze({
    kind: "resolve-discord-delivery",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    deliveryId: deliveryIdResult.data,
    resolution: resolutionResult.data,
  });
}

function parseNotifyOperations(args: readonly string[]): NotifyOperationsCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--incident-id",
      "--kind",
      "--occurred-at",
      "--retry-attempts",
      "--collect-analyze-report",
      "--public-boundary-status",
    ]),
  );
  const incidentKind = optionalSingleOption(options, "--kind");
  if (incidentKind !== "collection" && incidentKind !== "pages" && incidentKind !== "discord") {
    throw usageError("--kindにはcollection、pages、discordのいずれかを指定してください");
  }
  const incidentId = optionalSingleOption(options, "--incident-id");
  if (incidentId == null) {
    throw usageError("notify-operationsには--incident-idが必要です");
  }
  const occurredAtSource = optionalSingleOption(options, "--occurred-at");
  if (occurredAtSource == null) {
    throw usageError("notify-operationsには--occurred-atが必要です");
  }
  let occurredAt: UtcIsoDateTime;
  try {
    occurredAt = createUtcIsoDateTime(occurredAtSource);
  } catch (error: unknown) {
    throw usageError("--occurred-atにはタイムゾーン付きISO 8601日時を指定してください", error);
  }
  const retryAttemptsSource = singleOption(options, "--retry-attempts", "1");
  const retryAttempts = Number.parseInt(retryAttemptsSource, 10);
  if (
    !/^\d+$/u.test(retryAttemptsSource) ||
    !Number.isSafeInteger(retryAttempts) ||
    retryAttempts < 1
  ) {
    throw usageError("--retry-attemptsには1以上の整数を指定してください");
  }
  const common = {
    kind: "notify-operations",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    incidentId,
    occurredAt,
    retryAttempts,
  } satisfies NotifyOperationsCommandFields;
  if (incidentKind === "collection") {
    const publicBoundaryStatus =
      optionalSingleOption(options, "--public-boundary-status") ?? "unclassified";
    if (
      publicBoundaryStatus !== "confirmed" &&
      publicBoundaryStatus !== "not_confirmed" &&
      publicBoundaryStatus !== "unclassified"
    ) {
      throw usageError("--public-boundary-statusが不正です");
    }
    return Object.freeze({
      ...common,
      incidentKind,
      publicBoundaryStatus,
      collectAnalyzeReportPath: requiredSingleOption(
        options,
        "--collect-analyze-report",
        "notify-operations",
      ),
    });
  }
  if (optionalSingleOption(options, "--collect-analyze-report") != null) {
    throw usageError("--collect-analyze-reportはcollection障害だけに指定してください");
  }
  if (optionalSingleOption(options, "--public-boundary-status") != null) {
    throw usageError("--public-boundary-statusはcollection障害だけに指定してください");
  }
  return Object.freeze({ ...common, incidentKind });
}

function parseWorkflowJobResult(options: ParsedOptions, name: string): WorkflowJobResult {
  const value = requiredSingleOption(options, name, "report-workflow");
  switch (value) {
    case "success":
    case "failure":
    case "cancelled":
    case "skipped":
      return value;
    default:
      throw usageError(
        `${name}にはsuccess、failure、cancelled、skippedのいずれかを指定してください`,
      );
  }
}

function parseWorkflowRunAttempt(options: ParsedOptions): number {
  const source = requiredSingleOption(options, "--run-attempt", "report-workflow");
  const value = Number.parseInt(source, 10);
  if (!/^\d+$/u.test(source) || !Number.isSafeInteger(value) || value < 1) {
    throw usageError("--run-attemptには1以上の整数を指定してください");
  }
  return value;
}

function parseWorkflowRunId(options: ParsedOptions): string {
  const value = requiredSingleOption(options, "--run-id", "report-workflow");
  if (!/^[1-9]\d*$/u.test(value)) {
    throw usageError("--run-idには1以上の整数を指定してください");
  }
  return value;
}

function parseReportWorkflow(args: readonly string[]): ReportWorkflowCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--build-pages-result",
      "--collect-analyze-result",
      "--collect-report",
      "--deploy-pages-result",
      "--notify-discord-result",
      "--notify-operations-result",
      "--output",
      "--persist-state-result",
      "--publish-notification-history-result",
      "--run-attempt",
      "--run-id",
      "--quality-result",
    ]),
  );
  const collectAnalyzeReportPath = singleOption(
    options,
    "--collect-report",
    DEFAULT_COLLECT_ANALYZE_REPORT_PATH,
  );
  const outputPath = singleOption(options, "--output", DEFAULT_WORKFLOW_REPORT_PATH);
  if (collectAnalyzeReportPath === outputPath) {
    throw usageError("--collect-reportと--outputには異なるパスを指定してください");
  }
  return Object.freeze({
    kind: "report-workflow",
    collectAnalyzeReportPath,
    outputPath,
    workflowRunId: parseWorkflowRunId(options),
    workflowRunAttempt: parseWorkflowRunAttempt(options),
    jobResults: Object.freeze({
      quality: parseWorkflowJobResult(options, "--quality-result"),
      "collect-analyze": parseWorkflowJobResult(options, "--collect-analyze-result"),
      "persist-state": parseWorkflowJobResult(options, "--persist-state-result"),
      "build-pages": parseWorkflowJobResult(options, "--build-pages-result"),
      "deploy-pages": parseWorkflowJobResult(options, "--deploy-pages-result"),
      "notify-discord": parseWorkflowJobResult(options, "--notify-discord-result"),
      "publish-notification-history": parseWorkflowJobResult(
        options,
        "--publish-notification-history-result",
      ),
      "notify-operations": parseWorkflowJobResult(options, "--notify-operations-result"),
    }),
  });
}

function parseVerifyState(args: readonly string[]): VerifyStateCliCommand {
  const options = parseOptions(args, new Set(["--state-directory", "--config"]));
  return Object.freeze({
    kind: "verify-state",
    stateDirectory: requiredSingleOption(options, "--state-directory", "verify-state"),
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
  });
}

function parseVerifyCheckpoint(args: readonly string[]): VerifyCheckpointCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config"]));
  return Object.freeze({
    kind: "verify-checkpoint",
    artifactPath: singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH),
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
  });
}

function parseVerifyRuntimeRecovery(args: readonly string[]): VerifyRuntimeRecoveryCliCommand {
  const options = parseOptions(args, new Set(["--input", "--bundle-root"]));
  return Object.freeze({
    kind: "verify-runtime-recovery",
    inputPath: requiredSingleOption(options, "--input", "verify-runtime-recovery"),
    bundleRoot: optionalSingleOption(options, "--bundle-root"),
  });
}

function parseInspectRunState(args: readonly string[]): InspectRunStateCliCommand {
  const options = parseOptions(
    args,
    new Set(["--config", "--state-ref", "--run-id", "--state-revision"]),
  );
  const runId = optionalSingleOption(options, "--run-id");
  const revision = optionalSingleOption(options, "--state-revision");
  if ((runId == null) !== (revision == null)) {
    throw usageError("--run-idと--state-revisionは両方指定してください");
  }
  if (runId != null && !/^tracker-run:[0-9a-f]{64}$/u.test(runId)) {
    throw usageError("--run-idが不正です");
  }
  if (revision != null && !/^[0-9a-f]{40}$/u.test(revision)) {
    throw usageError("--state-revisionが不正です");
  }
  const recoveryIntent: InspectRunStateCliCommand["recoveryIntent"] =
    runId == null || revision == null
      ? { kind: "start_new" }
      : { kind: "retry_run", runId, exactStateRevision: revision };
  return Object.freeze({
    kind: "inspect-run-state",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    stateRef: optionalSingleOption(options, "--state-ref"),
    recoveryIntent,
  });
}

function parseVerifyReceiptChain(args: readonly string[]): VerifyReceiptChainCliCommand {
  const options = parseOptions(args, new Set(["--input"]));
  return Object.freeze({
    kind: "verify-receipt-chain",
    inputPath: requiredSingleOption(options, "--input", "verify-receipt-chain"),
  });
}

function parseReportFailure(args: readonly string[]): ReportFailureCliCommand {
  const options = parseOptions(args, new Set(["--input", "--output"]));
  return Object.freeze({
    kind: "report-failure",
    inputPath: requiredSingleOption(options, "--input", "report-failure"),
    outputPath: requiredSingleOption(options, "--output", "report-failure"),
  });
}

/** process argvからサブコマンドとoptionを検証して取り出す。 */
export function parseCliArguments(args: readonly string[]): CliCommand {
  const subcommand = args[0];
  if (subcommand == null) {
    throw usageError("サブコマンドが必要です");
  }
  if (subcommand === "--help" || subcommand === "help") {
    if (args.length !== 1) {
      throw usageError("helpに追加の引数は指定できません");
    }
    return Object.freeze({
      kind: "help",
    });
  }
  const options = args.slice(1);
  switch (subcommand) {
    case "daily":
      return parseDaily(options);
    case "dry-run":
      return parseDryRun(options);
    case "backfill":
      return parseBackfill(options);
    case "collect-analyze":
      return parseCollectAnalyze(options);
    case "persist-state":
      return parsePersistState(options);
    case "build-pages":
      return parseBuildPages(options);
    case "notify-discord":
      return parseNotifyDiscord(options);
    case "resolve-discord-delivery":
      return parseResolveDiscordDelivery(options);
    case "notify-operations":
      return parseNotifyOperations(options);
    case "report-workflow":
      return parseReportWorkflow(options);
    case "verify-state":
      return parseVerifyState(options);
    case "verify-checkpoint":
      return parseVerifyCheckpoint(options);
    case "verify-runtime-recovery":
      return parseVerifyRuntimeRecovery(options);
    case "inspect-run-state":
      return parseInspectRunState(options);
    case "verify-receipt-chain":
      return parseVerifyReceiptChain(options);
    case "report-failure":
      return parseReportFailure(options);
    default:
      throw usageError(`未対応のサブコマンドです。対象: ${subcommand}`);
  }
}

/** CLIで表示する簡潔な使用方法を返す。 */
export function formatCliUsage(): string {
  return [
    "使用方法:",
    "  voicevox-task-tracker daily [--config PATH] [--notification-action send|hold|acknowledge-current] [--sandbox-context PATH] [--scheduled-for ISO] [--report PATH]",
    "  voicevox-task-tracker dry-run [--config PATH] [--artifact PATH] [--report PATH]",
    "  voicevox-task-tracker backfill [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--repository VOICEVOX/REPO]",
    "  voicevox-task-tracker collect-analyze [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--scheduled-for ISO] [--artifact PATH]",
    "  voicevox-task-tracker persist-state [--config PATH] [--artifact PATH] [--receipt PATH]",
    "  voicevox-task-tracker build-pages [--config PATH] [--receipt PATH] [--build-artifact PATH] [--output PATH]",
    "  voicevox-task-tracker notify-discord --pages-url URL [--artifact PATH]",
    "  voicevox-task-tracker resolve-discord-delivery --delivery-id ID --resolution retry|acknowledge [--config PATH]",
    "  voicevox-task-tracker notify-operations --kind collection --incident-id ID --occurred-at ISO --collect-analyze-report PATH",
    "  voicevox-task-tracker notify-operations --kind pages|discord --incident-id ID --occurred-at ISO",
    "  voicevox-task-tracker report-workflow --run-id ID --run-attempt NUMBER --quality-result RESULT --collect-analyze-result RESULT --persist-state-result RESULT --build-pages-result RESULT --deploy-pages-result RESULT --notify-discord-result RESULT --publish-notification-history-result RESULT --notify-operations-result RESULT",
    "  voicevox-task-tracker verify-state --state-directory PATH [--config PATH]",
    "  voicevox-task-tracker verify-checkpoint [--artifact PATH] [--config PATH]",
    "  voicevox-task-tracker verify-runtime-recovery --input PATH [--bundle-root PATH]",
    "  voicevox-task-tracker inspect-run-state [--config PATH] [--state-ref REF] [--run-id ID --state-revision SHA]",
    "  voicevox-task-tracker verify-receipt-chain --input PATH",
    "  voicevox-task-tracker report-failure --input PATH --output PATH",
  ].join("\n");
}

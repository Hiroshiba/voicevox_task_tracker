import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { CliUsageError } from "./errors.js";

const DEFAULT_CONFIG_PATH = "config.yml";
const DEFAULT_REPORT_DIRECTORY = "artifacts/run-reports";
const DEFAULT_ARTIFACT_DIRECTORY = "artifacts";
const REPOSITORY_FILTER_PATTERN = /^VOICEVOX\/[A-Za-z0-9._-]+$/u;

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

/** 通常の日次実行を表すCLI入力。 */
export type DailyCliCommand = OnlineCommandFields &
  Readonly<{
    kind: "daily";
  }>;

/** 外部公開を行わない日次実行を表すCLI入力。 */
export type DryRunCliCommand = OnlineCommandFields &
  Readonly<{
    kind: "dry-run";
    artifactPath: string;
  }>;

/** 追跡対象を追加する日次実行を表すCLI入力。 */
export type BackfillCliCommand = OnlineCommandFields &
  Readonly<{
    kind: "backfill";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
  }>;

/** replayへ渡すfixtureまたは過去stateの入力元。 */
export type ReplaySource =
  | Readonly<{
      kind: "fixture";
      path: string;
    }>
  | Readonly<{
      kind: "state";
      path: string;
    }>;

/** 保存済み入力をネットワークなしで再判定するCLI入力。 */
export type ReplayCliCommand = Readonly<{
  kind: "replay";
  source: ReplaySource;
  artifactPath: string;
  reportPath: string;
  schedule: CliSchedule;
}>;

/** golden fixtureを比較するCLI入力。 */
export type EvalCliCommand = Readonly<{
  kind: "eval";
  fixturesPath: string;
  artifactPath: string;
  reportPath: string;
  schedule: CliSchedule;
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
  | ReplayCliCommand
  | EvalCliCommand
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

function assertDifferentOutputPaths(reportPath: string, artifactPath: string): void {
  if (reportPath === artifactPath) {
    throw usageError("--reportと--artifactには異なるパスを指定してください");
  }
}

function parseOnlineFields(
  commandName: "daily" | "dry-run" | "backfill",
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
  const options = parseOptions(args, new Set(["--config", "--report", "--scheduled-for"]));
  return Object.freeze({
    kind: "daily",
    ...parseOnlineFields("daily", options),
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
    new Set(["--config", "--mode", "--report", "--repository", "--scheduled-for"]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  return Object.freeze({
    kind: "backfill",
    ...parseOnlineFields("backfill", options),
    mode,
    repositoryFilter,
  });
}

function parseReplaySource(options: ParsedOptions): ReplaySource {
  const fixturePath = optionalSingleOption(options, "--fixture");
  const statePath = optionalSingleOption(options, "--state");
  if ((fixturePath == null) === (statePath == null)) {
    throw usageError("--fixtureまたは--stateのどちらか一方を指定してください");
  }
  if (fixturePath != null) {
    return Object.freeze({
      kind: "fixture",
      path: fixturePath,
    });
  }
  assertNonNullable(statePath, "--stateの値を取得できませんでした");
  return Object.freeze({
    kind: "state",
    path: statePath,
  });
}

function parseReplay(args: readonly string[]): ReplayCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--fixture", "--report", "--scheduled-for", "--state"]),
  );
  const reportPath = singleOption(options, "--report", `${DEFAULT_REPORT_DIRECTORY}/replay.json`);
  const artifactPath = singleOption(
    options,
    "--artifact",
    `${DEFAULT_ARTIFACT_DIRECTORY}/replay.json`,
  );
  assertDifferentOutputPaths(reportPath, artifactPath);
  return Object.freeze({
    kind: "replay",
    source: parseReplaySource(options),
    artifactPath,
    reportPath,
    schedule: parseSchedule(options),
  });
}

function parseEval(args: readonly string[]): EvalCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--fixtures", "--report", "--scheduled-for"]),
  );
  const fixturesPath = optionalSingleOption(options, "--fixtures");
  if (fixturesPath == null) {
    throw usageError("evalには--fixturesが必要です");
  }
  const reportPath = singleOption(options, "--report", `${DEFAULT_REPORT_DIRECTORY}/eval.json`);
  const artifactPath = singleOption(
    options,
    "--artifact",
    `${DEFAULT_ARTIFACT_DIRECTORY}/eval.json`,
  );
  assertDifferentOutputPaths(reportPath, artifactPath);
  return Object.freeze({
    kind: "eval",
    fixturesPath,
    artifactPath,
    reportPath,
    schedule: parseSchedule(options),
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
    case "replay":
      return parseReplay(options);
    case "eval":
      return parseEval(options);
    default:
      throw usageError(`未対応のサブコマンドです。対象: ${subcommand}`);
  }
}

/** CLIで表示する簡潔な使用方法を返す。 */
export function formatCliUsage(): string {
  return [
    "使用方法:",
    "  voicevox-task-tracker daily [--config PATH] [--scheduled-for ISO] [--report PATH]",
    "  voicevox-task-tracker dry-run [--config PATH] [--artifact PATH] [--report PATH]",
    "  voicevox-task-tracker backfill [--mode none|linked|all-open] [--repository VOICEVOX/REPO]",
    "  voicevox-task-tracker replay (--fixture PATH | --state PATH) [--artifact PATH]",
    "  voicevox-task-tracker eval --fixtures PATH [--artifact PATH]",
  ].join("\n");
}

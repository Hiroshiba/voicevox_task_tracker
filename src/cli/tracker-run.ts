import { pathToFileURL } from "node:url";

import { z } from "zod";

import { parseCliArguments, type BackfillCliCommand } from "./command.js";
import { CliUsageError } from "./errors.js";

const REPOSITORY_FILTER_SEPARATOR = ",";

type TrackerRunOptionName =
  "--backfill" | "--config" | "--repository-filter" | "--report" | "--scheduled-for";

const trackerRunOptionsSchema = z.strictObject({
  "--backfill": z.enum(["none", "linked", "all-open"]),
  "--config": z.string().min(1).optional(),
  "--repository-filter": z.string().min(1).optional(),
  "--report": z.string().min(1).optional(),
  "--scheduled-for": z.string().min(1).optional(),
});

type TrackerRunOptions = z.output<typeof trackerRunOptionsSchema>;

function parseTrackerRunOptions(args: readonly string[]): TrackerRunOptions {
  const options: Partial<Record<TrackerRunOptionName, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name !== "--backfill" &&
      name !== "--config" &&
      name !== "--repository-filter" &&
      name !== "--report" &&
      name !== "--scheduled-for"
    ) {
      throw new CliUsageError(`未対応のtracker:run optionです。対象: ${name ?? ""}`, {});
    }
    if (value == null || value.startsWith("--") || value.length === 0) {
      throw new CliUsageError(`${name}には値が必要です`, {});
    }
    if (Object.hasOwn(options, name)) {
      throw new CliUsageError(`${name}は1回だけ指定してください`, {});
    }
    options[name] = value;
  }
  const result = trackerRunOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new CliUsageError("tracker:run optionが不正です", {
      cause: result.error,
    });
  }
  return result.data;
}

function appendOption(
  args: string[],
  options: TrackerRunOptions,
  trackerRunName: TrackerRunOptionName,
  cliName: string,
): void {
  const value = options[trackerRunName];
  if (value != null) {
    args.push(cliName, value);
  }
}

function parseRepositoryFilter(value: string): readonly string[] {
  const repositories = value
    .split(REPOSITORY_FILTER_SEPARATOR)
    .map((repository) => repository.trim());
  if (repositories.some((repository) => repository.length === 0)) {
    throw new CliUsageError("--repository-filterに空のrepositoryは指定できません", {});
  }
  return Object.freeze(repositories);
}

/** workflow向けoptionを既存CLIのbackfillサブコマンドへ変換する。 */
export function createTrackerRunCliArguments(args: readonly string[]): readonly string[] {
  const options = parseTrackerRunOptions(args);
  const cliArguments = ["backfill", "--mode", options["--backfill"]];
  appendOption(cliArguments, options, "--config", "--config");
  appendOption(cliArguments, options, "--report", "--report");
  appendOption(cliArguments, options, "--scheduled-for", "--scheduled-for");

  const repositoryFilter = options["--repository-filter"];
  if (repositoryFilter != null) {
    for (const repository of parseRepositoryFilter(repositoryFilter)) {
      cliArguments.push("--repository", repository);
    }
  }

  const command = parseCliArguments(cliArguments);
  if (command.kind !== "backfill") {
    throw new TypeError("tracker:runの変換結果がbackfill commandではありません");
  }
  return Object.freeze(cliArguments);
}

/** workflow向けoptionを検証し、既存CLIの実行境界へ渡す。 */
export async function runTrackerCommand<Result>(
  args: readonly string[],
  runCli: (args: readonly string[]) => Promise<Result>,
): Promise<Result> {
  return runCli(createTrackerRunCliArguments(args));
}

function validateTrackerCommand(args: readonly string[]): Promise<BackfillCliCommand> {
  const command = parseCliArguments(args);
  if (command.kind !== "backfill") {
    throw new TypeError("tracker:runはbackfill commandだけを実行できます");
  }
  return Promise.resolve(command);
}

function isMainModule(moduleUrl: string, executablePath: string | undefined): boolean {
  return executablePath != null && pathToFileURL(executablePath).href === moduleUrl;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await runTrackerCommand(process.argv.slice(2), validateTrackerCommand);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "tracker:runの実行に失敗しました";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

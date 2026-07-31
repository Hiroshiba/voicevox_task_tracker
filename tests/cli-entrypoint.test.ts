import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTrackerRunCliArguments,
  parseCliArguments,
  runTrackerCommand,
  type BackfillCliCommand,
} from "../src/cli/index.js";

describe("tracker:run実行入口", () => {
  it("ビルド済みJavaScriptをpackage scriptから起動する", async () => {
    const packageSchema = z
      .object({
        scripts: z
          .object({
            "tracker:run": z.string(),
          })
          .loose(),
      })
      .loose();
    const source = await readFile(join(import.meta.dirname, "..", "package.json"), "utf8");
    const packageDefinition = packageSchema.parse(JSON.parse(source));

    expect(packageDefinition.scripts["tracker:run"]).toBe("node dist/cli/tracker-run.js");
  });

  it("backfill modeとrepository filterを既存CLIへ渡す", async () => {
    const runCli = vi.fn((args: readonly string[]): Promise<BackfillCliCommand> => {
      const command = parseCliArguments(args);
      if (command.kind !== "backfill") {
        throw new TypeError("backfill commandではありません");
      }
      return Promise.resolve(command);
    });

    const result = await runTrackerCommand(
      [
        "--backfill",
        "all-open",
        "--repository-filter",
        "VOICEVOX/voicevox_engine, VOICEVOX/voicevox",
        "--scheduled-for",
        "2026-07-30T23:00:00.000Z",
      ],
      runCli,
    );

    expect(runCli).toHaveBeenCalledWith([
      "backfill",
      "--mode",
      "all-open",
      "--scheduled-for",
      "2026-07-30T23:00:00.000Z",
      "--repository",
      "VOICEVOX/voicevox_engine",
      "--repository",
      "VOICEVOX/voicevox",
    ]);
    expect(result).toMatchObject({
      kind: "backfill",
      mode: "all-open",
      repositoryFilter: ["VOICEVOX/voicevox", "VOICEVOX/voicevox_engine"],
    });
  });

  it("--backfill noneをdailyへ変換する", () => {
    expect(createTrackerRunCliArguments(["--backfill", "none"])).toEqual(["daily"]);
  });

  it("--helpをhelpサブコマンドへ変換する", () => {
    expect(createTrackerRunCliArguments(["--help"])).toEqual(["help"]);
  });
});

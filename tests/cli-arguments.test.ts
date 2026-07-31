import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArguments } from "../src/cli/index.js";

describe("CLI引数解析", () => {
  it("dailyの既定値と明示した予定時刻を解析する", () => {
    expect(parseCliArguments(["daily", "--scheduled-for", "2026-07-31T08:00:00+09:00"])).toEqual({
      kind: "daily",
      configPath: "config.yml",
      reportPath: "artifacts/run-reports/daily.json",
      schedule: {
        kind: "specified",
        value: "2026-07-30T23:00:00.000Z",
      },
    });
  });

  it("dry-runの設定、artifact、reportを解析する", () => {
    expect(
      parseCliArguments([
        "dry-run",
        "--config",
        "fixture.yml",
        "--artifact",
        "output/result.json",
        "--report",
        "output/report.json",
      ]),
    ).toEqual({
      kind: "dry-run",
      configPath: "fixture.yml",
      artifactPath: "output/result.json",
      reportPath: "output/report.json",
      schedule: {
        kind: "current_time",
      },
    });
  });

  it("backfillのmodeと複数repository filterを決定論的順序にする", () => {
    expect(
      parseCliArguments([
        "backfill",
        "--mode",
        "all-open",
        "--repository",
        "VOICEVOX/voicevox_engine",
        "--repository",
        "VOICEVOX/voicevox",
      ]),
    ).toEqual({
      kind: "backfill",
      configPath: "config.yml",
      mode: "all-open",
      repositoryFilter: ["VOICEVOX/voicevox", "VOICEVOX/voicevox_engine"],
      reportPath: "artifacts/run-reports/backfill.json",
      schedule: {
        kind: "current_time",
      },
    });
  });

  it("replayのfixtureとstateを区別する", () => {
    expect(parseCliArguments(["replay", "--fixture", "fixtures/run.json"])).toMatchObject({
      kind: "replay",
      source: {
        kind: "fixture",
        path: "fixtures/run.json",
      },
    });
    expect(parseCliArguments(["replay", "--state", "state/snapshot.json"])).toMatchObject({
      kind: "replay",
      source: {
        kind: "state",
        path: "state/snapshot.json",
      },
    });
  });

  it("evalのfixture pathを解析する", () => {
    expect(parseCliArguments(["eval", "--fixtures", "tests/fixtures/golden"])).toEqual({
      kind: "eval",
      fixturesPath: "tests/fixtures/golden",
      artifactPath: "artifacts/eval.json",
      reportPath: "artifacts/run-reports/eval.json",
      schedule: {
        kind: "current_time",
      },
    });
  });

  it("不正な引数を拒否する", () => {
    const invalidArguments: readonly (readonly string[])[] = [
      [],
      ["unknown"],
      ["daily", "--unknown", "value"],
      ["backfill", "--mode", "invalid"],
      ["backfill", "--mode", "none", "--repository", "VOICEVOX/voicevox"],
      ["backfill", "--mode", "linked", "--repository", "other/repository"],
      ["replay"],
      ["replay", "--fixture", "a.json", "--state", "b.json"],
      ["eval"],
      ["dry-run", "--artifact", "same.json", "--report", "same.json"],
    ];
    for (const args of invalidArguments) {
      expect(() => parseCliArguments(args)).toThrow(CliUsageError);
    }
  });
});

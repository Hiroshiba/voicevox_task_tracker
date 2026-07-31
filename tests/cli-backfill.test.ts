import { describe, expect, it } from "vitest";

import {
  createTrackingBackfillRequest,
  parseCliArguments,
  type OnlineCliCommand,
} from "../src/cli/index.js";
import {
  createGitHubNodeId,
  createUtcIsoDateTime,
  selectTrackingItems,
  type OrganizationTrackingCandidate,
  type SelectTrackingItemsInput,
  type TrackingSelectionResult,
} from "../src/domain/index.js";

const START_AT = createUtcIsoDateTime("2026-07-01T00:00:00.000Z");
const EVALUATED_AT = createUtcIsoDateTime("2026-07-31T00:00:00.000Z");
const CREATED_AT = createUtcIsoDateTime("2026-06-01T00:00:00.000Z");

function parseOnlineCommand(args: readonly string[]): OnlineCliCommand {
  const command = parseCliArguments(args);
  if (command.kind !== "daily" && command.kind !== "dry-run" && command.kind !== "backfill") {
    throw new TypeError("online commandではありません");
  }
  return command;
}

function createCandidate(
  nodeId: string,
  repositoryFullName: "VOICEVOX/alpha" | "VOICEVOX/beta",
  number: number,
): OrganizationTrackingCandidate {
  const repositoryName = repositoryFullName.split("/")[1];
  if (repositoryName == null) {
    throw new TypeError("repository名がありません");
  }
  return Object.freeze({
    scope: "organization",
    nodeId: createGitHubNodeId(nodeId),
    repositoryFullName,
    number,
    url: `https://github.com/VOICEVOX/${repositoryName}/issues/${number.toString()}`,
    title: `${repositoryName}の項目`,
    state: "open",
    createdAt: CREATED_AT,
    activity: Object.freeze({
      lastHumanActivityAt: CREATED_AT,
      lastProgressAt: CREATED_AT,
    }),
    authorType: "human",
    notificationClass: "standard",
  });
}

function selectFor(command: OnlineCliCommand): TrackingSelectionResult {
  const input = {
    startAt: START_AT,
    evaluatedAt: EVALUATED_AT,
    candidates: Object.freeze([
      createCandidate("I_alpha", "VOICEVOX/alpha", 1),
      createCandidate("I_beta", "VOICEVOX/beta", 2),
    ]),
    connections: Object.freeze([]),
    previouslyTrackedNodeIds: Object.freeze([]),
    explicitIncludes: Object.freeze([]),
    autoInclude: Object.freeze({
      createdAfterStart: false,
      changedAfterStart: false,
      referencedByTracked: false,
      referencesTracked: false,
      nativeRelations: false,
      relationDepth: 0,
    }),
    backfill: createTrackingBackfillRequest(
      command,
      Object.freeze({
        status: "start",
      }),
    ),
    maxBackfillItemsPerRun: 10,
  } satisfies SelectTrackingItemsInput;
  return selectTrackingItems(input);
}

describe("CLI backfill変換", () => {
  it("dry-runでは追跡対象を追加せず、all-openではfilter内だけを追加する", () => {
    const dryRunSelection = selectFor(parseOnlineCommand(["dry-run"]));
    const backfillSelection = selectFor(
      parseOnlineCommand(["backfill", "--mode", "all-open", "--repository", "VOICEVOX/beta"]),
    );

    expect(dryRunSelection.newlyTrackedItems).toEqual([]);
    expect(backfillSelection.newlyTrackedItems.map((selected) => selected.item.nodeId)).toEqual([
      "I_beta",
    ]);
    expect(backfillSelection.backfill).toMatchObject({
      mode: "all-open",
      status: "complete",
      addedNodeIds: ["I_beta"],
    });
  });
});

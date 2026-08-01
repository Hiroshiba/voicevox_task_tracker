import { describe, expect, it } from "vitest";

import {
  aggregatePullRequestCheckState,
  aggregatePullRequestReviewState,
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type FreshObservedGitHubPullRequest,
  type NormalizedEvent,
  type ObservedGitHubHeadChecks,
  type ObservedGitHubPullRequestMergeState,
  type ReviewState,
} from "../src/domain/index.js";

type ReviewEvent = Extract<NormalizedEvent, { kind: "review" }>;

const itemNodeId = createGitHubNodeId("PR_aggregate_state");
const reviewerNodeId = createGitHubNodeId("U_reviewer");

function createReviewEvent(
  state: ReviewEvent["state"],
  occurredAt: string,
  sourceName: string,
): ReviewEvent {
  return Object.freeze({
    kind: "review",
    sourceId: buildSourceId("review", sourceName),
    itemNodeId,
    occurredAt: createUtcIsoDateTime(occurredAt),
    actor: Object.freeze({
      type: "human",
      nodeId: reviewerNodeId,
      login: "reviewer",
    }),
    state,
    bodyFingerprint: `sha256:${sourceName}`,
    bodyEmpty: true,
    commitStatus: "unavailable",
  });
}

function aggregateReviewState(
  events: readonly NormalizedEvent[],
  reviewRequests: FreshObservedGitHubPullRequest["reviewRequests"],
): ReviewState {
  return aggregatePullRequestReviewState({ events, reviewRequests });
}

function createChecks(
  combinedState: Extract<ObservedGitHubHeadChecks, { status: "configured" }>["combinedState"],
): ObservedGitHubHeadChecks {
  return Object.freeze({
    status: "configured",
    sourceId: buildSourceId("check_rollup", combinedState),
    nodeId: createGitHubNodeId(`CHECK_${combinedState}`),
    combinedState,
    contexts: Object.freeze([]),
  });
}

function createMergeState(
  options: Readonly<{
    mergeability: ObservedGitHubPullRequestMergeState["mergeability"];
    mergeState: ObservedGitHubPullRequestMergeState["mergeState"];
    checks: ObservedGitHubHeadChecks;
  }>,
): ObservedGitHubPullRequestMergeState {
  return Object.freeze({
    mergeability: options.mergeability,
    mergeState: options.mergeState,
    autoMerge: Object.freeze({ status: "not_enabled" }),
    mergeQueue: Object.freeze({ status: "not_queued" }),
    checks: options.checks,
  });
}

describe("Pull Request review状態集約", () => {
  const noRequests = Object.freeze([]);

  it.each([
    {
      fixtureName: "APPROVED",
      events: [createReviewEvent("approved", "2026-08-01T00:00:00Z", "approved")],
      expected: "approved",
    },
    {
      fixtureName: "CHANGES_REQUESTED",
      events: [
        createReviewEvent("approved", "2026-08-01T00:00:00Z", "before-changes"),
        createReviewEvent("changes_requested", "2026-08-01T01:00:00Z", "changes"),
      ],
      expected: "changes_requested",
    },
    {
      fixtureName: "DISMISSED",
      events: [
        createReviewEvent("dismissed", "2026-08-01T01:00:00Z", "dismissed"),
        createReviewEvent("approved", "2026-08-01T00:00:00Z", "before-dismissal"),
      ],
      expected: "not_requested",
    },
  ] satisfies readonly Readonly<{
    fixtureName: string;
    events: readonly ReviewEvent[];
    expected: ReviewState;
  }>[])("$fixtureName fixtureを$expectedへ集約する", ({ events, expected }) => {
    expect(aggregateReviewState(events, noRequests)).toBe(expected);
  });

  it("現行のhuman review requestを依頼済みとして集約する", () => {
    const reviewRequest = Object.freeze({
      sourceId: buildSourceId("review_request", "human"),
      nodeId: createGitHubNodeId("RR_human"),
      target: Object.freeze({
        type: "user",
        actor: Object.freeze({
          type: "human",
          nodeId: reviewerNodeId,
          login: "reviewer",
        }),
      }),
      requestedAt: Object.freeze({
        status: "available",
        value: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
      }),
    } satisfies FreshObservedGitHubPullRequest["reviewRequests"][number]);

    expect(aggregateReviewState([], [reviewRequest])).toBe("requested");
  });
});

describe("Pull Request check状態集約", () => {
  it.each([
    {
      fixtureName: "ready",
      mergeability: "mergeable",
      mergeState: "clean",
      checks: createChecks("success"),
      expected: "passing",
    },
    {
      fixtureName: "running",
      mergeability: "mergeable",
      mergeState: "unstable",
      checks: createChecks("pending"),
      expected: "pending",
    },
    {
      fixtureName: "failing",
      mergeability: "mergeable",
      mergeState: "unstable",
      checks: createChecks("failure"),
      expected: "failing",
    },
    {
      fixtureName: "conflict",
      mergeability: "conflicting",
      mergeState: "dirty",
      checks: createChecks("success"),
      expected: "conflict",
    },
  ] satisfies readonly Readonly<{
    fixtureName: string;
    mergeability: ObservedGitHubPullRequestMergeState["mergeability"];
    mergeState: ObservedGitHubPullRequestMergeState["mergeState"];
    checks: ObservedGitHubHeadChecks;
    expected: ReturnType<typeof aggregatePullRequestCheckState>;
  }>[])("$fixtureName fixtureを$expectedへ集約する", (fixture) => {
    expect(aggregatePullRequestCheckState(createMergeState(fixture))).toBe(fixture.expected);
  });

  it.each([
    { combinedState: "expected", expected: "pending" },
    { combinedState: "error", expected: "failing" },
  ] satisfies readonly Readonly<{
    combinedState: Extract<ObservedGitHubHeadChecks, { status: "configured" }>["combinedState"];
    expected: ReturnType<typeof aggregatePullRequestCheckState>;
  }>[])("$combinedStateも取得済み状態へ集約する", ({ combinedState, expected }) => {
    const mergeState = createMergeState({
      mergeability: "mergeable",
      mergeState: "unstable",
      checks: createChecks(combinedState),
    });

    expect(aggregatePullRequestCheckState(mergeState)).toBe(expected);
  });

  it("checks不要をnot_requiredへ集約する", () => {
    const mergeState = createMergeState({
      mergeability: "mergeable",
      mergeState: "clean",
      checks: Object.freeze({ status: "not_configured" }),
    });

    expect(aggregatePullRequestCheckState(mergeState)).toBe("not_required");
  });

  it("merge状態を取得できない場合だけunknownへ集約する", () => {
    const mergeState = createMergeState({
      mergeability: "unknown",
      mergeState: "unknown",
      checks: Object.freeze({ status: "not_configured" }),
    });

    expect(aggregatePullRequestCheckState(mergeState)).toBe("unknown");
  });
});

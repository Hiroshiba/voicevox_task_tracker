import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type NormalizedEvent,
  type Repository,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  createGitHubBodyFingerprint,
  createPublicRepositoryAllowlist,
  markObservedGitHubItemsStale,
  normalizeGitHubActor,
  normalizeGitHubEvents,
  normalizeObservedGitHubItem,
  type EnumeratedGitHubItem,
  type GitHubApiAccountType,
  type GitHubDetailActor,
  type GitHubItemDetail,
  type GitHubIssueComment,
  type GitHubPullRequestCommit,
  type GitHubTimelineEvent,
} from "../src/github/index.js";

const occurredAt = createUtcIsoDateTime("2026-07-31T12:00:00Z");
const observedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const pullRequestCreatedAt = createUtcIsoDateTime("2026-07-15T00:00:00Z");
const timelineCommitSourceId = buildSourceId("github_commit", "C_timeline_commit");
const headCommitSourceId = buildSourceId("github_commit", "C_head_commit");
const repositoryId = createGitHubRepositoryId("R_normalization");
const repository = {
  id: repositoryId,
  owner: "VOICEVOX",
  name: "example",
  visibility: "public",
  archived: false,
  disabled: false,
  observedAt,
} satisfies Repository;
const publicRepositoryId = createPublicRepositoryAllowlist([repository]).require(repositoryId).id;

function createAccountActor(
  nodeIdValue: string,
  login: string,
  apiType: GitHubApiAccountType,
): GitHubDetailActor {
  const nodeId = createGitHubNodeId(nodeIdValue);
  return {
    status: "identified",
    account: {
      sourceId: buildSourceId("github_actor", nodeId),
      nodeId,
      login,
      apiType,
    },
  };
}

function createItem(
  displayReference: GitHubItemDisplayReference,
  url: GitHubItemUrl,
): EnumeratedGitHubItem {
  const nodeId = createGitHubNodeId("PR_normalization");
  const bodyFingerprint = createGitHubBodyFingerprint("列挙時の本文");
  return {
    nodeId,
    repositoryId: publicRepositoryId,
    displayReference,
    number: 1,
    url,
    title: "正規化対象",
    bodyFingerprint,
    bodyLocator: {
      kind: "github_item_body",
      repositoryId: publicRepositoryId,
      itemNodeId: nodeId,
      number: 1,
    },
    author: {
      kind: "account",
      account: {
        nodeId: createGitHubNodeId("U_author"),
        login: "author",
        apiType: "User",
      },
    },
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00Z"),
    updatedAt: occurredAt,
    state: "closed",
    stateReason: "completed",
    closedAt: occurredAt,
    draft: false,
    assignees: [
      {
        nodeId: createGitHubNodeId("U_assignee"),
        login: "assignee",
        apiType: "User",
      },
    ],
    labels: ["bug"],
    milestone: {
      nodeId: createGitHubNodeId("M_v1"),
      number: 1,
      title: "v1",
      state: "open",
    },
    itemFingerprint: bodyFingerprint,
    observedAt,
    type: "pull_request",
  };
}

function createTimeline(): readonly GitHubTimelineEvent[] {
  const humanActor = createAccountActor("U_human", "human", "User");
  const reviewRequestEvent = {
    sourceId: buildSourceId("github_timeline_event", "R_review_request"),
    nodeId: createGitHubNodeId("R_review_request"),
    sequence: 0,
    occurredAt,
    actor: humanActor,
    kind: "review_requested",
    target: {
      type: "user",
      sourceId: buildSourceId("github_user", "B_reviewer"),
      nodeId: createGitHubNodeId("B_reviewer"),
      login: "bot-reviewer",
      apiType: "Bot",
    },
  } satisfies GitHubTimelineEvent;
  return [
    {
      sourceId: buildSourceId("github_timeline_event", "A_assigned"),
      nodeId: createGitHubNodeId("A_assigned"),
      sequence: 1,
      occurredAt,
      actor: humanActor,
      kind: "assigned",
      assignee: {
        type: "account",
        account: {
          sourceId: buildSourceId("github_actor", "U_assignee"),
          nodeId: createGitHubNodeId("U_assignee"),
          login: "assignee",
          apiType: "User",
        },
      },
    },
    {
      sourceId: buildSourceId("github_timeline_event", "L_labeled"),
      nodeId: createGitHubNodeId("L_labeled"),
      sequence: 2,
      occurredAt,
      actor: createAccountActor("B_labeler", "configured-bot", "User"),
      kind: "labeled",
      label: {
        sourceId: buildSourceId("github_label", "LA_bug"),
        nodeId: createGitHubNodeId("LA_bug"),
        name: "bug",
      },
    },
    reviewRequestEvent,
    {
      sourceId: buildSourceId("github_timeline_event", "S_closed"),
      nodeId: createGitHubNodeId("S_closed"),
      sequence: 4,
      occurredAt,
      actor: humanActor,
      kind: "closed",
    },
    {
      sourceId: buildSourceId("github_timeline_event", "Z_connected"),
      nodeId: createGitHubNodeId("Z_connected"),
      sequence: 5,
      occurredAt,
      actor: humanActor,
      kind: "connected",
      subject: {
        sourceId: buildSourceId("github_item", "I_related"),
        nodeId: createGitHubNodeId("I_related"),
        repositoryId: publicRepositoryId,
        repositoryOwner: "VOICEVOX",
        repositoryName: "example",
        repositoryArchived: false,
        repositoryDisabled: false,
        type: "issue",
        number: 2,
        url: "https://github.com/VOICEVOX/example/issues/2",
        state: "open",
      },
    },
  ];
}

function createDetail(): Extract<GitHubItemDetail, { type: "pull_request" }> {
  const comment = {
    sourceId: buildSourceId("github_issue_comment", "C_comment"),
    nodeId: createGitHubNodeId("C_comment"),
    sequence: 0,
    author: createAccountActor("B_commenter", "api-bot", "Bot"),
    body: "公開結果へ残してはいけないコメント全文",
    createdAt: occurredAt,
    updatedAt: occurredAt,
    url: "https://github.com/VOICEVOX/example/pull/1#issuecomment-1",
  } satisfies GitHubIssueComment;
  const timeline = createTimeline();
  return {
    sourceId: buildSourceId("github_item_detail", "PR_normalization"),
    nodeId: createGitHubNodeId("PR_normalization"),
    repositoryId: publicRepositoryId,
    number: 1,
    bodySourceId: buildSourceId("github_item_body", "PR_normalization"),
    body: "公開結果へ残してはいけない本文全文",
    comments: [comment, comment],
    timeline,
    inboundCrossReferences: [],
    observedAt,
    type: "pull_request",
    reviews: [
      {
        sourceId: buildSourceId("github_pull_request_review", "V_review"),
        nodeId: createGitHubNodeId("V_review"),
        sequence: 0,
        state: "approved",
        author: createAccountActor("U_reviewer", "reviewer", "User"),
        commit: {
          status: "available",
          sourceId: buildSourceId("github_commit", "C_reviewed"),
          nodeId: createGitHubNodeId("C_reviewed"),
          sha: "reviewed-sha",
        },
        submittedAt: occurredAt,
        body: "公開結果へ残してはいけないレビュー全文",
        url: "https://github.com/VOICEVOX/example/pull/1#pullrequestreview-1",
      },
    ],
    reviewThreads: [],
    reviewRequests: {
      current: [
        {
          sourceId: buildSourceId("github_review_request", "RR_current"),
          nodeId: createGitHubNodeId("RR_current"),
          target: {
            type: "user",
            sourceId: buildSourceId("github_user", "B_reviewer"),
            nodeId: createGitHubNodeId("B_reviewer"),
            login: "bot-reviewer",
            apiType: "Bot",
          },
          requestedAt: {
            status: "available",
            value: occurredAt,
          },
        },
      ],
      history: timeline.filter(
        (
          event,
        ): event is Extract<
          GitHubTimelineEvent,
          { kind: "review_requested" | "review_request_removed" }
        > => event.kind === "review_requested" || event.kind === "review_request_removed",
      ),
    },
    headSha: "head-sha",
    headCommit: {
      sourceId: buildSourceId("github_commit", "P_head"),
      nodeId: createGitHubNodeId("P_head"),
      sha: "head-sha",
      committedAt: occurredAt,
      pushedAt: {
        status: "available",
        value: occurredAt,
      },
    },
    mergeState: {
      mergeability: "mergeable",
      mergeState: "clean",
      autoMerge: {
        status: "enabled",
        sourceId: buildSourceId(
          "github_auto_merge_request",
          createGitHubNodeId("PR_normalization"),
        ),
        enabledAt: occurredAt,
        enabledBy: createAccountActor("U_auto_merge", "auto-merge-enabler", "User"),
        mergeMethod: "squash",
      },
      mergeQueue: {
        status: "not_queued",
      },
      checks: {
        status: "not_configured",
      },
    },
  };
}

function createCommit(
  id: string,
  committedAt: UtcIsoDateTime,
  pushedAt: GitHubPullRequestCommit["pushedAt"],
): GitHubPullRequestCommit {
  return {
    sourceId: buildSourceId("github_commit", id),
    nodeId: createGitHubNodeId(id),
    sha: `${id}-sha`,
    committedAt,
    pushedAt,
  };
}

function createCommitOnlyDetail(
  committedAt: UtcIsoDateTime,
  pushedAt: GitHubPullRequestCommit["pushedAt"],
): Extract<GitHubItemDetail, { type: "pull_request" }> {
  const detail = createDetail();
  const timelineCommit = createCommit("C_timeline_commit", committedAt, pushedAt);
  const headCommit = createCommit("C_head_commit", committedAt, pushedAt);
  return {
    ...detail,
    comments: [],
    timeline: [
      {
        sourceId: buildSourceId("github_timeline_event", "E_commit_added"),
        nodeId: createGitHubNodeId("E_commit_added"),
        sequence: 0,
        kind: "commit_added",
        commit: timelineCommit,
      },
    ],
    reviews: [],
    reviewThreads: [],
    reviewRequests: {
      current: [],
      history: [],
    },
    headSha: headCommit.sha,
    headCommit,
  };
}

function normalizeCommitOnlyPullRequest(
  committedAt: UtcIsoDateTime,
  pushedAt: GitHubPullRequestCommit["pushedAt"],
): readonly Extract<NormalizedEvent, { kind: "push" }>[] {
  const item = {
    ...createItem("VOICEVOX/example#1", "https://github.com/VOICEVOX/example/pull/1"),
    createdAt: pullRequestCreatedAt,
  };
  return normalizeGitHubEvents({
    item,
    detail: createCommitOnlyDetail(committedAt, pushedAt),
    isBot,
  }).filter((event) => event.kind === "push");
}

const isBot = (account: Readonly<{ login: string }>): boolean => account.login === "configured-bot";

describe("GitHubイベント正規化", () => {
  it("Pull Request作成前のcommittedDateを作成時刻へ寄せる", () => {
    const events = normalizeCommitOnlyPullRequest(createUtcIsoDateTime("2026-07-14T00:00:00Z"), {
      status: "unavailable",
      reason: "github_did_not_return_pushed_at",
    });

    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: timelineCommitSourceId,
          occurredAt: pullRequestCreatedAt,
        }),
        expect.objectContaining({
          sourceId: headCommitSourceId,
          occurredAt: pullRequestCreatedAt,
        }),
      ]),
    );
  });

  it("Pull Request作成前のpushedDateを作成時刻へ寄せる", () => {
    const events = normalizeCommitOnlyPullRequest(createUtcIsoDateTime("2026-07-13T00:00:00Z"), {
      status: "available",
      value: createUtcIsoDateTime("2026-07-14T00:00:00Z"),
    });

    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: timelineCommitSourceId,
          occurredAt: pullRequestCreatedAt,
        }),
        expect.objectContaining({
          sourceId: headCommitSourceId,
          occurredAt: pullRequestCreatedAt,
        }),
      ]),
    );
  });

  it("committedDateが作成後でもPull Request作成前のpushedDateを作成時刻へ寄せる", () => {
    const events = normalizeCommitOnlyPullRequest(createUtcIsoDateTime("2026-07-16T00:00:00Z"), {
      status: "available",
      value: createUtcIsoDateTime("2026-07-14T00:00:00Z"),
    });

    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: timelineCommitSourceId,
          occurredAt: pullRequestCreatedAt,
        }),
        expect.objectContaining({
          sourceId: headCommitSourceId,
          occurredAt: pullRequestCreatedAt,
        }),
      ]),
    );
  });

  it("Pull Request作成後のpushedDateをそのまま保持する", () => {
    const pushedAt = createUtcIsoDateTime("2026-07-17T00:00:00Z");
    const events = normalizeCommitOnlyPullRequest(createUtcIsoDateTime("2026-07-16T00:00:00Z"), {
      status: "available",
      value: pushedAt,
    });

    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: timelineCommitSourceId,
          occurredAt: pushedAt,
        }),
        expect.objectContaining({
          sourceId: headCommitSourceId,
          occurredAt: pushedAt,
        }),
      ]),
    );
  });

  it("8種別を保持してsource IDで重複排除し同時刻を決定論的に並べる", () => {
    const item = createItem("VOICEVOX/example#1", "https://github.com/VOICEVOX/example/pull/1");
    const detail = createDetail();

    const events = normalizeGitHubEvents({
      item,
      detail,
      isBot,
    });

    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "comment",
        "push",
        "review",
        "review_request",
        "label",
        "assignee",
        "state",
        "relation",
      ]),
    );
    expect(new Set(events.map((event) => event.kind))).toEqual(
      new Set([
        "comment",
        "push",
        "review",
        "review_request",
        "label",
        "assignee",
        "state",
        "relation",
      ]),
    );
    expect(events).toHaveLength(8);
    expect(events.filter((event) => event.kind === "comment")).toHaveLength(1);
    expect(events.map((event) => event.sourceId)).toEqual(
      [...events.map((event) => event.sourceId)].sort(),
    );
    const commentEvent = events.find((event) => event.kind === "comment");
    if (commentEvent?.kind !== "comment") {
      throw new Error("comment eventがありません");
    }
    expect(commentEvent.actor.type).toBe("bot");
    const reviewEvent = events.find((event) => event.kind === "review");
    if (reviewEvent?.kind !== "review") {
      throw new Error("review eventがありません");
    }
    expect(reviewEvent.bodyFingerprint).toBe(
      createGitHubBodyFingerprint("公開結果へ残してはいけないレビュー全文"),
    );
    expect(reviewEvent).not.toHaveProperty("body");
  });

  it("同じ入力から同じsource IDと順序を生成し表示用別名の変更に影響されない", () => {
    const detail = createDetail();
    const beforeRename = createItem(
      "VOICEVOX/example#1",
      "https://github.com/VOICEVOX/example/pull/1",
    );
    const afterRename = createItem(
      "VOICEVOX/renamed#1",
      "https://github.com/VOICEVOX/renamed/pull/1",
    );

    const first = normalizeGitHubEvents({
      item: beforeRename,
      detail,
      isBot,
    });
    const second = normalizeGitHubEvents({
      item: beforeRename,
      detail,
      isBot,
    });
    const renamed = normalizeGitHubEvents({
      item: afterRename,
      detail,
      isBot,
    });

    expect(second).toEqual(first);
    expect(renamed.map((event) => event.sourceId)).toEqual(first.map((event) => event.sourceId));
  });

  it("GitHub Bot型、設定判定、通常アカウント、取得不能を区別する", () => {
    let directBotPredicateCalls = 0;
    const directBot = normalizeGitHubActor(
      createAccountActor("B_direct", "direct-bot", "Bot"),
      () => {
        directBotPredicateCalls += 1;
        return false;
      },
    );
    const configuredBot = normalizeGitHubActor(
      createAccountActor("U_configured", "configured-bot", "User"),
      isBot,
    );
    const human = normalizeGitHubActor(createAccountActor("U_human", "human", "User"), isBot);
    const system = normalizeGitHubActor(
      {
        status: "unavailable",
        reason: "github_did_not_return_actor",
      },
      isBot,
    );

    expect(directBot.type).toBe("bot");
    expect(directBotPredicateCalls).toBe(0);
    expect(configuredBot.type).toBe("bot");
    expect(human.type).toBe("human");
    expect(system).toEqual({
      type: "system",
      name: "github",
    });
  });
});

describe("GitHub項目観測値", () => {
  it("基本メタデータと判定前情報を本文なしで保持する", () => {
    const item = createItem("VOICEVOX/example#1", "https://github.com/VOICEVOX/example/pull/1");
    const observation = normalizeObservedGitHubItem({
      item,
      detail: createDetail(),
      isBot,
    });

    expect(observation).toMatchObject({
      freshness: "fresh",
      nodeId: "PR_normalization",
      repositoryId: "R_normalization",
      displayReference: "VOICEVOX/example#1",
      title: "正規化対象",
      state: "closed",
      stateReason: "completed",
      draft: false,
      labels: ["bug"],
      milestone: {
        title: "v1",
      },
      bodySourceId: "github_item_body:PR_normalization",
      observedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(observation.bodyFingerprint).toBe(
      createGitHubBodyFingerprint("公開結果へ残してはいけない本文全文"),
    );
    if (observation.type !== "pull_request") {
      throw new Error("Pull Request観測値ではありません");
    }
    const target = observation.reviewRequests[0]?.target;
    if (target?.type !== "user") {
      throw new Error("user review request観測値がありません");
    }
    expect(target.actor.type).toBe("bot");
    expect(observation.mergeState.autoMerge).toEqual({
      status: "enabled",
      sourceId: "github_auto_merge_request:PR_normalization",
      enabledAt: "2026-07-31T12:00:00.000Z",
      enabledBy: {
        type: "human",
        nodeId: "U_auto_merge",
        login: "auto-merge-enabler",
      },
      mergeMethod: "squash",
    });
    expect(JSON.stringify(observation)).not.toContain("公開結果へ残してはいけない");
    expect(observation).not.toHaveProperty("status");
    expect(observation).not.toHaveProperty("waitingOn");
    expect(observation).not.toHaveProperty("stallSince");
  });

  it("取得失敗時は前回値を最新値と異なるstale型で保持する", () => {
    const previousObservation = normalizeObservedGitHubItem({
      item: createItem("VOICEVOX/example#1", "https://github.com/VOICEVOX/example/pull/1"),
      detail: createDetail(),
      isBot,
    });
    const staleItems = markObservedGitHubItemsStale({
      previousItems: [previousObservation],
      failedAt: createUtcIsoDateTime("2026-08-02T00:00:00Z"),
      diagnostic: {
        code: "github_repository_temporarily_unavailable",
        message: "取得に失敗したため前回値を保持しています",
      },
    });
    const staleItem = staleItems[0];
    if (staleItem == null) {
      throw new Error("stale観測値がありません");
    }

    expect(staleItem).toMatchObject({
      freshness: "stale",
      nodeId: "PR_normalization",
      lastSuccessfulAt: "2026-08-01T00:00:00.000Z",
      failedAt: "2026-08-02T00:00:00.000Z",
      previousObservation: {
        freshness: "fresh",
        title: "正規化対象",
      },
    });
    expect(staleItem).not.toHaveProperty("observedAt");
    expect(staleItem).not.toHaveProperty("title");
  });
});

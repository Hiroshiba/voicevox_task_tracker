import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  determinePullRequestState,
  PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
  type Actor,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type NormalizedEvent,
  type PullRequestBlocker,
  type PullRequestStateMachineInput,
  type ResolvedLabelEffects,
  type ResolvedRepositoryTeams,
} from "../src/domain/index.js";

const headPushedAt = createUtcIsoDateTime("2026-07-31T03:00:00Z");
const pullRequestCreatedAt = createUtcIsoDateTime("2026-07-31T01:00:00Z");
const observedAt = createUtcIsoDateTime("2026-07-31T08:00:00Z");
const evaluatedAt = createUtcIsoDateTime("2026-07-31T09:00:00Z");
const pullRequestNodeId = createGitHubNodeId("PR_state_machine");
const headSha = "head-sha";
const systemActor = {
  type: "system",
  name: "github",
} satisfies Actor;
const author = {
  type: "human",
  nodeId: createGitHubNodeId("U_author"),
  login: "author",
} satisfies GitHubAccountActor;
const reviewer = {
  type: "human",
  nodeId: createGitHubNodeId("U_reviewer"),
  login: "reviewer",
} satisfies GitHubAccountActor;
const bot = {
  type: "bot",
  nodeId: createGitHubNodeId("B_copilot"),
  login: "copilot-pull-request-reviewer[bot]",
} satisfies GitHubAccountActor;

const labelEffects = {
  priorityWeight: 0,
  severityLift: 0,
  requiresMaintainerDecision: false,
  suppressNotifications: false,
  countsAsProgress: false,
} satisfies ResolvedLabelEffects;

const teams = {
  maintainers: [
    {
      nodeId: createGitHubNodeId("T_maintainers"),
      org: "VOICEVOX",
      slug: "maintainers",
      members: [],
    },
  ],
  reviewers: [
    {
      nodeId: createGitHubNodeId("T_reviewers"),
      org: "VOICEVOX",
      slug: "reviewers",
      members: [],
    },
  ],
} satisfies ResolvedRepositoryTeams;

function createPushEvent(
  sha: string,
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
): Extract<NormalizedEvent, { kind: "push" }> {
  return {
    kind: "push",
    sourceId: buildSourceId("github_commit", sha),
    itemNodeId: pullRequestNodeId,
    occurredAt,
    actor: systemActor,
    headCommitSha: sha,
    forcePush: false,
  };
}

function createReviewEvent(options: {
  id: string;
  actor: GitHubAccountActor;
  state: Extract<NormalizedEvent, { kind: "review" }>["state"];
  occurredAt: ReturnType<typeof createUtcIsoDateTime>;
  commitSha: string;
}): Extract<NormalizedEvent, { kind: "review" }> {
  return {
    kind: "review",
    sourceId: buildSourceId("github_pull_request_review", options.id),
    itemNodeId: pullRequestNodeId,
    occurredAt: options.occurredAt,
    actor: options.actor,
    state: options.state,
    bodyFingerprint: `sha256:${options.id}`,
    bodyEmpty: false,
    commitStatus: "available",
    commitSha: options.commitSha,
  };
}

function createCommentEvent(options: {
  id: string;
  actor: GitHubAccountActor;
  occurredAt: ReturnType<typeof createUtcIsoDateTime>;
}): Extract<NormalizedEvent, { kind: "comment" }> {
  return {
    kind: "comment",
    sourceId: buildSourceId("github_pull_request_review_comment", options.id),
    itemNodeId: pullRequestNodeId,
    occurredAt: options.occurredAt,
    actor: options.actor,
    bodyFingerprint: `sha256:${options.id}`,
    bodyEmpty: false,
  };
}

function createReviewRequest(
  target: "user" | "team",
  id: string,
  requestedAt: ReturnType<typeof createUtcIsoDateTime>,
): FreshObservedGitHubPullRequest["reviewRequests"][number] {
  const sourceId = buildSourceId("github_review_request", id);
  if (target === "user") {
    return {
      sourceId,
      nodeId: createGitHubNodeId(`RR_${id}`),
      target: {
        type: "user",
        actor: reviewer,
      },
      requestedAt: {
        status: "available",
        value: requestedAt,
      },
    };
  }
  return {
    sourceId,
    nodeId: createGitHubNodeId(`RR_${id}`),
    target: {
      type: "team",
      sourceId: buildSourceId("github_team", "VOICEVOX/reviewers"),
      nodeId: createGitHubNodeId("T_reviewers"),
      organizationLogin: "VOICEVOX",
      slug: "reviewers",
      name: "Reviewers",
    },
    requestedAt: {
      status: "available",
      value: requestedAt,
    },
  };
}

function createOpenPullRequest(): FreshObservedGitHubPullRequest {
  return {
    freshness: "fresh",
    sourceId: buildSourceId("github_item_detail", pullRequestNodeId),
    nodeId: pullRequestNodeId,
    type: "pull_request",
    createdAt: pullRequestCreatedAt,
    state: "open",
    stateReason: null,
    closedAt: null,
    author: {
      status: "identified",
      actor: author,
    },
    assignees: [],
    draft: false,
    headSha,
    headCommit: {
      sourceId: buildSourceId("github_commit", headSha),
      nodeId: createGitHubNodeId("C_head"),
      sha: headSha,
      committedAt: headPushedAt,
      pushedAt: {
        status: "available",
        value: headPushedAt,
      },
    },
    reviewThreads: [],
    reviewRequests: [],
    mergeState: {
      mergeability: "mergeable",
      mergeState: "blocked",
      autoMerge: {
        status: "not_enabled",
      },
      mergeQueue: {
        status: "not_queued",
      },
      checks: {
        status: "not_configured",
      },
    },
    events: [createPushEvent(headSha, headPushedAt)],
    observedAt,
  };
}

function createInput(pullRequest: FreshObservedGitHubPullRequest): PullRequestStateMachineInput {
  return {
    pullRequest,
    blockers: [],
    checkFailureAssessment: {
      cause: "not_assessed",
    },
    labelEffects,
    teams,
    confidenceThresholds: {
      high: 0.85,
      medium: 0.65,
    },
    evaluatedAt,
  };
}

function createBlocker(options: {
  candidateId: string;
  state: PullRequestBlocker["state"];
  authority: PullRequestBlocker["authority"];
  confidence: number;
  becameBlockingAt: ReturnType<typeof createUtcIsoDateTime>;
}): PullRequestBlocker {
  return {
    candidateId: options.candidateId,
    state: options.state,
    authority: options.authority,
    confidence: options.confidence,
    sourceIds: [buildSourceId("relation", options.candidateId)],
    becameBlockingAt: options.becameBlockingAt,
  };
}

describe("Pull Request状態機械の入力契約", () => {
  it("ドメインの最新Pull Request観測値を直接受け取る", () => {
    expectTypeOf<
      PullRequestStateMachineInput["pullRequest"]
    >().toEqualTypeOf<FreshObservedGitHubPullRequest>();
  });

  it("同じ入力からversionを含む同じ結果を返す", () => {
    const input = createInput({
      ...createOpenPullRequest(),
      reviewRequests: [
        createReviewRequest("user", "user-request", createUtcIsoDateTime("2026-07-31T04:00:00Z")),
      ],
    });

    const first = determinePullRequestState(input);
    const second = determinePullRequestState(input);

    expect(second).toEqual(first);
    expect(first.deterministicRulesVersion).toBe(PULL_REQUEST_DETERMINISTIC_RULES_VERSION);
    expect(first.determination).toBe("determined");
  });
});

describe("Pull Request判定の優先順位", () => {
  it("terminalをblockerとautomationより優先する", () => {
    const mergedAt = createUtcIsoDateTime("2026-07-31T07:00:00Z");
    const mergedEvent = {
      kind: "state",
      sourceId: buildSourceId("github_timeline_event", "merged"),
      itemNodeId: pullRequestNodeId,
      occurredAt: mergedAt,
      actor: reviewer,
      state: "merged",
    } satisfies NormalizedEvent;
    const openPullRequest = createOpenPullRequest();
    const pullRequest = {
      ...openPullRequest,
      state: "closed",
      stateReason: "completed",
      closedAt: mergedAt,
      mergeState: {
        ...openPullRequest.mergeState,
        mergeQueue: {
          status: "queued",
          sourceId: buildSourceId("github_merge_queue", "queue"),
          nodeId: createGitHubNodeId("MQ_queue"),
        },
      },
      events: [...openPullRequest.events, mergedEvent],
    } satisfies FreshObservedGitHubPullRequest;
    const decision = determinePullRequestState({
      ...createInput(pullRequest),
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#1",
          state: "open",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
      ],
    });

    expect(decision.status).toBe("terminal_merged");
    expect(decision.waitingOn).toEqual([]);
    expect(decision.primaryWaitingOn.index).toBe("not_applicable");
  });

  it("確定済みopen blockerをautomationより優先しclosed blockerを除外する", () => {
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState({
      ...createInput({
        ...pullRequest,
        mergeState: {
          ...pullRequest.mergeState,
          autoMerge: {
            status: "enabled",
            sourceId: buildSourceId("github_auto_merge_request", pullRequestNodeId),
            enabledAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
            enabledBy: reviewer,
            mergeMethod: "squash",
          },
        },
      }),
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#1",
          state: "open",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
        createBlocker({
          candidateId: "VOICEVOX/core#2",
          state: "closed",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-29T00:00:00Z"),
        }),
      ],
    });

    expect(decision.status).toBe("blocked");
    expect(decision.waitingOn.map((value) => value.candidateId)).toEqual(["VOICEVOX/core#1"]);
  });

  it("merge queue、auto-merge、実行中checksをhumanの変更要求より優先する", () => {
    const changesRequested = createReviewEvent({
      id: "current-changes",
      actor: reviewer,
      state: "changes_requested",
      occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
      commitSha: headSha,
    });
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        mergeState: {
          mergeability: "mergeable",
          mergeState: "blocked",
          mergeQueue: {
            status: "queued",
            sourceId: buildSourceId("github_merge_queue", "queue"),
            nodeId: createGitHubNodeId("MQ_queue"),
          },
          autoMerge: {
            status: "enabled",
            sourceId: buildSourceId("github_auto_merge_request", pullRequestNodeId),
            enabledAt: createUtcIsoDateTime("2026-07-31T04:00:00Z"),
            enabledBy: reviewer,
            mergeMethod: "squash",
          },
          checks: {
            status: "configured",
            sourceId: buildSourceId("github_check_rollup", headSha),
            nodeId: createGitHubNodeId("CR_head"),
            combinedState: "pending",
            contexts: [],
          },
        },
        events: [...pullRequest.events, changesRequested],
      }),
    );

    expect(decision.status).toBe("waiting_for_automation");
    expect(decision.waitingOn.map((value) => value.candidateId)).toEqual([
      "merge_queue",
      "auto_merge",
      "required_checks",
    ]);
  });

  it("現行headへのhuman変更要求をreview requestより優先する", () => {
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        reviewRequests: [
          createReviewRequest("team", "team-request", createUtcIsoDateTime("2026-07-31T04:00:00Z")),
        ],
        events: [
          ...pullRequest.events,
          createReviewEvent({
            id: "changes-requested",
            actor: reviewer,
            state: "changes_requested",
            occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
            commitSha: headSha,
          }),
        ],
      }),
    );

    expect(decision.status).toBe("waiting_for_author");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "role",
      role: "author",
      candidateId: "author",
    });
  });

  it("現行review requestをdraftの既定より優先する", () => {
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        draft: true,
        reviewRequests: [
          createReviewRequest("user", "user-request", createUtcIsoDateTime("2026-07-31T04:00:00Z")),
        ],
      }),
    );

    expect(decision.status).toBe("waiting_for_review");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "user",
      candidateId: "reviewer",
    });
  });

  it("明示的なmaintainer判断ラベルをdraftの既定より優先する", () => {
    const decision = determinePullRequestState({
      ...createInput({
        ...createOpenPullRequest(),
        draft: true,
      }),
      labelEffects: {
        ...labelEffects,
        requiresMaintainerDecision: true,
      },
    });

    expect(decision.status).toBe("needs_maintainer_decision");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "team",
      role: "maintainer",
      candidateId: "VOICEVOX/maintainers",
    });
  });
});

describe("reviewと責務の遷移", () => {
  it("変更要求後のhead pushでreviewer側へ責務を戻す", () => {
    const pullRequest = createOpenPullRequest();
    const changesRequestedAt = createUtcIsoDateTime("2026-07-31T02:00:00Z");
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        events: [
          createReviewEvent({
            id: "old-changes-requested",
            actor: reviewer,
            state: "changes_requested",
            occurredAt: changesRequestedAt,
            commitSha: "old-head",
          }),
          ...pullRequest.events,
          createCommentEvent({
            id: "bot-after-push",
            actor: bot,
            occurredAt: createUtcIsoDateTime("2026-07-31T04:00:00Z"),
          }),
        ],
      }),
    );

    expect(decision.status).toBe("waiting_for_review");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "user",
      role: "reviewer",
      candidateId: "reviewer",
    });
    expect(decision.responsibilityBasis).toEqual({
      sourceIds: [buildSourceId("github_commit", headSha)],
      occurredAt: headPushedAt,
      precision: "event",
    });
  });

  it("未解決human review threadをresolved版よりauthor待ちとして優先する", () => {
    const comment = createCommentEvent({
      id: "human-thread",
      actor: reviewer,
      occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    });
    const pullRequest = createOpenPullRequest();
    const unresolved = {
      ...pullRequest,
      reviewThreads: [
        {
          sourceId: buildSourceId("github_review_thread", "thread"),
          nodeId: createGitHubNodeId("RT_thread"),
          isResolved: false,
          isOutdated: false,
          commentSourceIds: [comment.sourceId],
        },
      ],
      reviewRequests: [
        createReviewRequest("user", "user-request", createUtcIsoDateTime("2026-07-31T04:00:00Z")),
      ],
      events: [...pullRequest.events, comment],
    } satisfies FreshObservedGitHubPullRequest;
    const resolved = {
      ...unresolved,
      reviewThreads: unresolved.reviewThreads.map((thread) => ({
        ...thread,
        isResolved: true,
      })),
    } satisfies FreshObservedGitHubPullRequest;

    expect(determinePullRequestState(createInput(unresolved)).status).toBe("waiting_for_author");
    expect(determinePullRequestState(createInput(resolved)).status).toBe("waiting_for_review");
  });

  it("bot reviewとcommentだけではbotへボールを移さない", () => {
    const pullRequest = createOpenPullRequest();
    const botRequestSourceId = buildSourceId("github_review_request", "bot");
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        reviewRequests: [
          {
            sourceId: botRequestSourceId,
            nodeId: createGitHubNodeId("RR_bot"),
            target: {
              type: "user",
              actor: bot,
            },
            requestedAt: {
              status: "available",
              value: createUtcIsoDateTime("2026-07-31T04:00:00Z"),
            },
          },
        ],
        events: [
          ...pullRequest.events,
          createReviewEvent({
            id: "bot-review",
            actor: bot,
            state: "changes_requested",
            occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
            commitSha: headSha,
          }),
          createCommentEvent({
            id: "bot-comment",
            actor: bot,
            occurredAt: createUtcIsoDateTime("2026-07-31T06:00:00Z"),
          }),
        ],
      }),
    );

    expect(decision.status).toBe("needs_maintainer_decision");
    expect(decision.waitingOn.some((value) => value.candidateId === bot.login)).toBe(false);
    expect(decision.waitingOn.some((value) => value.kind === "automation")).toBe(false);
    expect(decision.determination).toBe("determined");
  });

  it("意味を確定できないhuman commentをCodex候補にする", () => {
    const pullRequest = createOpenPullRequest();
    const comment = createCommentEvent({
      id: "ambiguous-human-comment",
      actor: reviewer,
      occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    });
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        events: [...pullRequest.events, comment],
      }),
    );

    expect(decision.status).toBe("needs_maintainer_decision");
    expect(decision.determination).toBe("codex_candidate");
    expect(decision.uncertainties).toContain("human commentの意味を決定論的に確定できません");
    expect(decision.evidence).toContainEqual({
      sourceId: comment.sourceId,
      supports: "uncertainty",
      summary: "human commentの意味を決定論的に確定できません",
    });
  });

  it("userとteamの現行review requestをAIなしで保持する", () => {
    const decision = determinePullRequestState(
      createInput({
        ...createOpenPullRequest(),
        reviewRequests: [
          createReviewRequest("team", "team-request", createUtcIsoDateTime("2026-07-31T05:00:00Z")),
          createReviewRequest("user", "user-request", createUtcIsoDateTime("2026-07-31T04:00:00Z")),
        ],
      }),
    );

    expect(decision.status).toBe("waiting_for_review");
    expect(decision.waitingOn.map((value) => [value.kind, value.candidateId])).toEqual([
      ["user", "reviewer"],
      ["team", "VOICEVOX/reviewers"],
    ]);
    expect(decision.determination).toBe("determined");
    expect(decision.uncertainties).toEqual([]);
  });

  it("draftではstatusと責務を別々に保持する", () => {
    const draftDecision = determinePullRequestState(
      createInput({
        ...createOpenPullRequest(),
        draft: true,
      }),
    );
    const pullRequest = createOpenPullRequest();
    const changesDecision = determinePullRequestState(
      createInput({
        ...pullRequest,
        events: [
          ...pullRequest.events,
          createReviewEvent({
            id: "changes-requested",
            actor: reviewer,
            state: "changes_requested",
            occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
            commitSha: headSha,
          }),
        ],
      }),
    );

    expect(draftDecision.status).toBe("in_progress");
    expect(changesDecision.status).toBe("waiting_for_author");
    expect(draftDecision.waitingOn[0]).toMatchObject({
      kind: changesDecision.waitingOn[0]?.kind,
      role: changesDecision.waitingOn[0]?.role,
      candidateId: changesDecision.waitingOn[0]?.candidateId,
    });
  });
});

describe("merge readinessと失敗時の判定", () => {
  it("承認とchecksを満たしたPRをready_to_mergeとする", () => {
    const approval = createReviewEvent({
      id: "approval",
      actor: reviewer,
      state: "approved",
      occurredAt: createUtcIsoDateTime("2026-07-31T05:00:00Z"),
      commitSha: headSha,
    });
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        mergeState: {
          ...pullRequest.mergeState,
          mergeState: "clean",
          checks: {
            status: "configured",
            sourceId: buildSourceId("github_check_rollup", headSha),
            nodeId: createGitHubNodeId("CR_head"),
            combinedState: "success",
            contexts: [],
          },
        },
        events: [...pullRequest.events, approval],
      }),
    );

    expect(decision.status).toBe("ready_to_merge");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "team",
      role: "merge_decider",
      candidateId: "VOICEVOX/maintainers",
    });
  });

  it("ready for reviewでreview未依頼ならmaintainer待ちとする", () => {
    const decision = determinePullRequestState(createInput(createOpenPullRequest()));

    expect(decision.status).toBe("needs_maintainer_decision");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "team",
      role: "maintainer",
      candidateId: "VOICEVOX/maintainers",
    });
  });

  it("高信頼のPull Request起因required check失敗をauthor待ちとする", () => {
    const pullRequest = createOpenPullRequest();
    const checkSourceId = buildSourceId("github_check_rollup", headSha);
    const decision = determinePullRequestState({
      ...createInput({
        ...pullRequest,
        mergeState: {
          ...pullRequest.mergeState,
          checks: {
            status: "configured",
            sourceId: checkSourceId,
            nodeId: createGitHubNodeId("CR_head"),
            combinedState: "failure",
            contexts: [],
          },
        },
      }),
      checkFailureAssessment: {
        cause: "pull_request_change",
        confidence: 0.95,
        sourceIds: [buildSourceId("check_failure_assessment", "deterministic-test")],
      },
    });

    expect(decision.status).toBe("waiting_for_author");
    expect(decision.waitingOn[0]?.role).toBe("author");
    expect(decision.determination).toBe("determined");
  });

  it("infrastructureまたはflaky疑いの失敗はauthorと断定せずCodex候補にする", () => {
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState({
      ...createInput({
        ...pullRequest,
        mergeState: {
          ...pullRequest.mergeState,
          checks: {
            status: "configured",
            sourceId: buildSourceId("github_check_rollup", headSha),
            nodeId: createGitHubNodeId("CR_head"),
            combinedState: "error",
            contexts: [],
          },
        },
      }),
      checkFailureAssessment: {
        cause: "infrastructure_or_flaky",
        confidence: 0.9,
        sourceIds: [buildSourceId("check_failure_assessment", "runner-outage")],
      },
    });

    expect(decision.status).toBe("needs_maintainer_decision");
    expect(decision.waitingOn[0]?.role).toBe("maintainer");
    expect(decision.determination).toBe("codex_candidate");
    expect(decision.confidence).toBeLessThanOrEqual(0.65);
    expect(decision.uncertainties).toContain(
      "required check失敗にinfrastructureまたはflakyの疑いがあります",
    );
  });

  it("低信頼blockerはblockedと断定せずreviewer待ちを推定表示に縮退する", () => {
    const decision = determinePullRequestState({
      ...createInput({
        ...createOpenPullRequest(),
        reviewRequests: [
          createReviewRequest("user", "user-request", createUtcIsoDateTime("2026-07-31T04:00:00Z")),
        ],
      }),
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#99",
          state: "open",
          authority: "inferred",
          confidence: 0.6,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
      ],
    });

    expect(decision.status).toBe("waiting_for_review");
    expect(decision.determination).toBe("codex_candidate");
    expect(decision.confidence).toBeLessThanOrEqual(0.65);
    expect(decision.waitingOn.some((value) => value.kind === "item")).toBe(false);
  });

  it("他の明示的な待ち先がないmerge conflictをauthor待ちとする", () => {
    const pullRequest = createOpenPullRequest();
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        mergeState: {
          ...pullRequest.mergeState,
          mergeability: "conflicting",
          mergeState: "dirty",
        },
      }),
    );

    expect(decision.status).toBe("waiting_for_author");
    expect(decision.waitingOn[0]?.role).toBe("author");
    expect(decision.nextAction).toContain("base branch");
  });
});

describe("blockerとterminalの詳細", () => {
  it("複数の確定済みopen blockerを保持してprimaryの選定理由を返す", () => {
    const decision = determinePullRequestState({
      ...createInput(createOpenPullRequest()),
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#3",
          state: "open",
          authority: "inferred",
          confidence: 0.95,
          becameBlockingAt: createUtcIsoDateTime("2026-07-27T00:00:00Z"),
        }),
        createBlocker({
          candidateId: "VOICEVOX/core#2",
          state: "open",
          authority: "authoritative",
          confidence: 0.9,
          becameBlockingAt: createUtcIsoDateTime("2026-07-29T00:00:00Z"),
        }),
        createBlocker({
          candidateId: "VOICEVOX/core#1",
          state: "open",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
      ],
    });

    expect(decision.status).toBe("blocked");
    expect(decision.waitingOn.map((value) => value.candidateId)).toEqual([
      "VOICEVOX/core#1",
      "VOICEVOX/core#2",
      "VOICEVOX/core#3",
    ]);
    expect(decision.primaryWaitingOn).toMatchObject({
      index: 0,
      selectionReason:
        "authoritative、confidence、blockerになった時刻、candidate IDの順で選定しました",
    });
  });

  it.each([
    ["terminal_merged", "completed", true],
    ["terminal_completed", "completed", false],
    ["terminal_not_planned", "not_planned", false],
  ] satisfies readonly (readonly [
    "terminal_merged" | "terminal_completed" | "terminal_not_planned",
    "completed" | "not_planned",
    boolean,
  ])[])("%sを他のterminal状態と区別する", (expectedStatus, stateReason, merged) => {
    const terminalAt = createUtcIsoDateTime("2026-07-31T07:00:00Z");
    const pullRequest = createOpenPullRequest();
    const stateEvent = merged
      ? ({
          kind: "state",
          sourceId: buildSourceId("github_timeline_event", "merged"),
          itemNodeId: pullRequestNodeId,
          occurredAt: terminalAt,
          actor: reviewer,
          state: "merged",
        } satisfies NormalizedEvent)
      : ({
          kind: "state",
          sourceId: buildSourceId("github_timeline_event", expectedStatus),
          itemNodeId: pullRequestNodeId,
          occurredAt: terminalAt,
          actor: reviewer,
          state: "closed",
          stateReason,
        } satisfies NormalizedEvent);
    const decision = determinePullRequestState(
      createInput({
        ...pullRequest,
        state: "closed",
        stateReason,
        closedAt: terminalAt,
        events: [...pullRequest.events, stateEvent],
      }),
    );

    expect(decision.status).toBe(expectedStatus);
    expect(decision.waitingOn).toEqual([]);
  });
});

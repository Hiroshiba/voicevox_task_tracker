import {
  type GitHubItemUrl,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type GitHubApiAccountType } from "./account-types.js";
import { type PublicRepositoryId } from "./public-repository-allowlist.js";

/** GitHub APIが識別情報を返したアカウント。 */
export type GitHubDetailAccount = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  login: string;
  apiType: GitHubApiAccountType;
}>;

/** GitHub API上のアクター取得結果。 */
export type GitHubDetailActor =
  | Readonly<{
      status: "identified";
      account: GitHubDetailAccount;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_actor";
    }>;

/** レビュー依頼先となるGitHub userまたはteam。 */
export type GitHubReviewRequestTarget =
  | Readonly<{
      type: "user";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      login: string;
      apiType: GitHubApiAccountType;
    }>
  | Readonly<{
      type: "team";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      organizationLogin: string;
      slug: string;
      name: string;
    }>;

/** GitHub上の公開IssueまたはPull Requestへの参照。 */
export type GitHubReferencedItem = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  repositoryOwner: string;
  repositoryName: string;
  repositoryArchived: boolean;
  repositoryDisabled: boolean;
  type: "issue" | "pull_request";
  number: number;
  url: GitHubItemUrl;
  state: "open" | "closed" | "merged";
}>;

/** 信頼できないbodyはCodex入力データだけに利用し、永続化や公開用DTOへ渡してはならないissue comment取得値。 */
export type GitHubIssueComment = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  author: GitHubDetailActor;
  body: string;
  createdAt: UtcIsoDateTime;
  updatedAt: UtcIsoDateTime;
  url: GitHubItemUrl;
}>;

/** Pull Request reviewが対象としたcommitの取得結果。 */
export type GitHubReviewCommit =
  | Readonly<{
      status: "available";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      sha: string;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_commit";
    }>;

/** 信頼できないbodyはCodex入力データだけに利用し、永続化や公開用DTOへ渡してはならないreview submission取得値。 */
export type GitHubPullRequestReview = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  author: GitHubDetailActor;
  commit: GitHubReviewCommit;
  submittedAt: UtcIsoDateTime;
  body: string;
}>;

/** 信頼できないbodyはCodex入力データだけに利用し、永続化や公開用DTOへ渡してはならないinline review comment取得値。 */
export type GitHubPullRequestReviewComment = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  author: GitHubDetailActor;
  body: string;
  createdAt: UtcIsoDateTime;
  updatedAt: UtcIsoDateTime;
  url: GitHubItemUrl;
}>;

/** resolved状態と全文を含むinline review thread取得値。 */
export type GitHubPullRequestReviewThread = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  resolvedBy: GitHubDetailActor;
  comments: readonly GitHubPullRequestReviewComment[];
}>;

/** レビュー依頼時刻の取得結果。 */
export type GitHubReviewRequestTimestamp =
  | Readonly<{
      status: "available";
      value: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "timeline_event_not_found";
    }>;

/** GitHubが返した現行review request。 */
export type GitHubCurrentReviewRequest = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  target: GitHubReviewRequestTarget;
  requestedAt: GitHubReviewRequestTimestamp;
}>;

/** Pull RequestのcommitがGitHubへpushされた時刻の取得結果。 */
export type GitHubCommitPushedAt =
  | Readonly<{
      status: "available";
      value: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_pushed_at";
    }>;

/** Pull Request timelineまたはheadから取得したcommit。 */
export type GitHubPullRequestCommit = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sha: string;
  committedAt: UtcIsoDateTime;
  pushedAt: GitHubCommitPushedAt;
}>;

type GitHubTimelineEventBase = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  occurredAt: UtcIsoDateTime;
  actor: GitHubDetailActor;
}>;

export type GitHubTimelineAssignee = Readonly<{
  type: "account";
  account: GitHubDetailAccount;
}>;

/** 判定に必要なIssueとPull Requestのtimelineイベント。 */
export type GitHubTimelineEvent =
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "assigned" | "unassigned";
        assignee: GitHubTimelineAssignee;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "labeled" | "unlabeled";
        label: Readonly<{
          sourceId: SourceId;
          nodeId: GitHubNodeId;
          name: string;
        }>;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "review_requested" | "review_request_removed";
        target: GitHubReviewRequestTarget;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind:
          | "closed"
          | "reopened"
          | "merged"
          | "ready_for_review"
          | "converted_to_draft"
          | "added_to_merge_queue"
          | "removed_from_merge_queue"
          | "auto_merge_enabled"
          | "auto_merge_disabled";
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "cross_referenced";
        source: GitHubReferencedItem;
        willCloseTarget: boolean;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "connected" | "disconnected";
        subject: GitHubReferencedItem;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "head_ref_force_pushed";
        beforeSha: string;
        afterSha: string;
      }>)
  | Readonly<{
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      sequence: number;
      kind: "commit_added";
      commit: GitHubPullRequestCommit;
    }>;

/** tracked targetを参照したsource itemを追跡へ追加するための候補。 */
export type GitHubInboundCrossReferenceCandidate = Readonly<{
  sourceId: SourceId;
  candidateOnly: true;
  provenance: "cross_reference";
  eventSourceId: SourceId;
  sourceItem: GitHubReferencedItem;
}>;

/** GitHub native issue dependencyを推定関係と混ぜずに保持するauthoritative relation。 */
export type GitHubNativeDependency = Readonly<{
  sourceId: SourceId;
  authoritative: true;
  provenance: "native";
  direction: "blocked_by" | "blocking";
  relatedItem: GitHubReferencedItem;
}>;

/** native issue dependency APIの利用可否を含む取得結果。 */
export type GitHubNativeDependencyCollection =
  | Readonly<{
      availability: "available";
      relations: readonly GitHubNativeDependency[];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "api_not_supported";
    }>;

/** GitHub native sub-issueを推定関係と混ぜずに保持するauthoritative relation。 */
export type GitHubNativeHierarchy = Readonly<{
  sourceId: SourceId;
  authoritative: true;
  provenance: "native";
  relationship: "parent" | "sub_issue";
  relatedItem: GitHubReferencedItem;
}>;

/** native sub-issue APIの利用可否を含む取得結果。 */
export type GitHubNativeHierarchyCollection =
  | Readonly<{
      availability: "available";
      relations: readonly GitHubNativeHierarchy[];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "api_not_supported";
    }>;

/** check runの完了結果。 */
export type GitHubCheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out"
  | "not_completed";

/** head commitへ紐づくcheck runまたはcommit status。 */
export type GitHubCheckContext =
  | Readonly<{
      type: "check_run";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      name: string;
      status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
      conclusion: GitHubCheckRunConclusion;
    }>
  | Readonly<{
      type: "commit_status";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      context: string;
      state: "error" | "expected" | "failure" | "pending" | "success";
      createdAt: UtcIsoDateTime;
    }>;

/** head commitのstatus check rollup取得結果。 */
export type GitHubHeadChecks =
  | Readonly<{
      status: "configured";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      combinedState: "error" | "expected" | "failure" | "pending" | "success";
      contexts: readonly GitHubCheckContext[];
    }>
  | Readonly<{
      status: "not_configured";
    }>;

/** Pull Requestのauto-merge取得結果。 */
export type GitHubAutoMerge =
  | Readonly<{
      status: "enabled";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      enabledAt: UtcIsoDateTime;
      enabledBy: GitHubDetailActor;
      mergeMethod: "merge" | "rebase" | "squash";
    }>
  | Readonly<{
      status: "not_enabled";
    }>;

/** Pull Requestのmerge queue相当の取得結果。 */
export type GitHubMergeQueue =
  | Readonly<{
      status: "queued";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "not_queued";
    }>;

/** Pull Requestのmergeability、merge state、automation、checks取得結果。 */
export type GitHubPullRequestMergeState = Readonly<{
  mergeability: "mergeable" | "conflicting" | "unknown";
  mergeState:
    "behind" | "blocked" | "clean" | "dirty" | "draft" | "has_hooks" | "unknown" | "unstable";
  autoMerge: GitHubAutoMerge;
  mergeQueue: GitHubMergeQueue;
  checks: GitHubHeadChecks;
}>;

/** 現行review requestと追加・解除履歴。 */
export type GitHubPullRequestReviewRequests = Readonly<{
  current: readonly GitHubCurrentReviewRequest[];
  history: readonly Extract<
    GitHubTimelineEvent,
    { kind: "review_requested" | "review_request_removed" }
  >[];
}>;

type GitHubItemDetailFields = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  number: number;
  bodySourceId: SourceId;
  body: string;
  comments: readonly GitHubIssueComment[];
  timeline: readonly GitHubTimelineEvent[];
  inboundCrossReferences: readonly GitHubInboundCrossReferenceCandidate[];
  observedAt: UtcIsoDateTime;
}>;

/** 信頼できないbodyと各コメント本文はCodex入力データだけに利用し、永続化、Pages、Discordへ渡してはならない詳細取得値。 */
export type GitHubItemDetail =
  | (GitHubItemDetailFields &
      Readonly<{
        type: "issue";
        nativeDependencies: GitHubNativeDependencyCollection;
        nativeHierarchy: GitHubNativeHierarchyCollection;
      }>)
  | (GitHubItemDetailFields &
      Readonly<{
        type: "pull_request";
        reviews: readonly GitHubPullRequestReview[];
        reviewThreads: readonly GitHubPullRequestReviewThread[];
        reviewRequests: GitHubPullRequestReviewRequests;
        headSha: string;
        headCommit: GitHubPullRequestCommit;
        mergeState: GitHubPullRequestMergeState;
      }>);

/** GraphQL schemaが提供するnative relation機能。 */
export type GitHubItemDetailCapabilities = Readonly<{
  nativeDependencies: "available" | "unavailable";
  nativeHierarchy: "available" | "unavailable";
}>;

/** 詳細取得結果と取得時に確認したGraphQL機能。 */
export type GitHubItemDetailCollection = Readonly<{
  capabilities: GitHubItemDetailCapabilities;
  items: readonly GitHubItemDetail[];
}>;

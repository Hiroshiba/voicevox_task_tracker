import { z } from "zod";

import type {
  GitHubItemDisplayReference,
  GitHubItemUrl,
  GitHubNodeId,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import { createGitHubNodeId } from "../../../domain/types.js";
import {
  createGitHubBodyFingerprint,
  type EnumeratedGitHubItem,
  type GitHubItemAccount,
  type GitHubItemAuthor,
  type GitHubItemBodyLocator,
} from "../../../github/item-enumeration.js";
import type {
  GitHubDetailAccount,
  GitHubDetailActor,
  GitHubItemDetail,
  GitHubPullRequestCommit,
  GitHubReferencedItem,
} from "../../../github/item-detail-types.js";
import {
  buildProductionSourceId,
  buildPullRequestCommitSourceId,
} from "../../../github/production-source-id.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import { hashCanonicalJson } from "../content-digest.js";

import type { SandboxFixedSourceDataset } from "./schema.js";

type FixedItem = SandboxFixedSourceDataset["items"][number];
type FixedPullRequest = Extract<FixedItem, { type: "pull_request" }>;
type FixedIssue = Extract<FixedItem, { type: "issue" }>;

const botAccount: GitHubItemAccount = Object.freeze({
  nodeId: createGitHubNodeId("U_sandbox_strict_zero_bot"),
  login: "strict-zero-fixture[bot]",
  apiType: "Bot",
});
const humanAccount: GitHubDetailAccount = Object.freeze({
  sourceId: buildProductionSourceId("github_actor", "U_sandbox_strict_zero_human"),
  nodeId: createGitHubNodeId("U_sandbox_strict_zero_human"),
  login: "strict-zero-reviewer",
  apiType: "User",
});
const humanActor = Object.freeze({
  status: "identified",
  account: humanAccount,
} satisfies GitHubDetailActor);

function itemUrl(repository: PublicRepository, item: FixedItem): GitHubItemUrl {
  const kind = item.type === "issue" ? "issues" : "pull";
  return `https://github.com/${repository.owner}/${repository.name}/${kind}/${item.number.toString()}`;
}

function itemReference(repository: PublicRepository, item: FixedItem): GitHubItemDisplayReference {
  const source = `${repository.owner}/${repository.name}#${item.number.toString()}`;
  return z
    .custom<GitHubItemDisplayReference>(
      (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
    )
    .parse(source);
}

/** 合成項目を通常列挙後と同じ型へ変換する。 */
export function createSandboxEnumeratedItem(
  repository: PublicRepository,
  item: FixedItem,
  observedAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  const nodeId = createGitHubNodeId(item.nodeId);
  const bodyLocator: GitHubItemBodyLocator = Object.freeze({
    kind: "github_item_body",
    repositoryId: repository.id,
    itemNodeId: nodeId,
    number: item.number,
  });
  const author: GitHubItemAuthor = Object.freeze({ kind: "account", account: botAccount });
  const bodyFingerprint = createGitHubBodyFingerprint(item.body);
  const fingerprintBase = {
    nodeId,
    repositoryId: repository.id,
    type: item.type,
    title: item.title,
    bodyFingerprint,
    author,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    assignees: [],
    labels: [],
  };
  const itemFingerprint =
    item.type === "issue"
      ? hashCanonicalJson({
          ...fingerprintBase,
          state: "closed",
          stateReason: "completed",
          closedAt: item.closedAt,
          draft: "not_applicable",
        })
      : hashCanonicalJson({
          ...fingerprintBase,
          state: "open",
          stateReason: null,
          closedAt: null,
          draft: false,
          mergeStatus: "not_merged",
        });
  const common = {
    nodeId,
    repositoryId: repository.id,
    displayReference: itemReference(repository, item),
    number: item.number,
    url: itemUrl(repository, item),
    title: item.title,
    bodyFingerprint,
    bodyLocator,
    author,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    assignees: Object.freeze([]),
    labels: Object.freeze([]),
    itemFingerprint,
    observedAt,
  };
  if (item.type === "issue") {
    return Object.freeze({
      ...common,
      type: "issue",
      draft: "not_applicable",
      state: "closed",
      stateReason: "completed",
      closedAt: item.closedAt,
    });
  }
  return Object.freeze({
    ...common,
    type: "pull_request",
    draft: false,
    state: "open",
    stateReason: null,
    closedAt: null,
    mergeStatus: "not_merged",
  });
}

function referencedIssue(repository: PublicRepository, item: FixedIssue): GitHubReferencedItem {
  const nodeId = createGitHubNodeId(item.nodeId);
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item", nodeId),
    nodeId,
    repositoryId: repository.id,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: "issue",
    number: item.number,
    url: itemUrl(repository, item),
    createdAt: item.createdAt,
    state: "closed",
  });
}

function createIssueDetail(
  repository: PublicRepository,
  item: FixedIssue,
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  const nodeId = createGitHubNodeId(item.nodeId);
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item_detail", nodeId),
    nodeId,
    repositoryId: repository.id,
    number: item.number,
    type: "issue",
    bodySourceId: buildProductionSourceId("github_item_body", nodeId),
    body: item.body,
    comments: Object.freeze([]),
    timeline: Object.freeze([
      Object.freeze({
        sourceId: buildProductionSourceId("github_timeline_event", `${nodeId}:closed`),
        nodeId: createGitHubNodeId(`${nodeId}:closed`),
        sequence: 0,
        occurredAt: item.closedAt,
        actor: humanActor,
        kind: "closed",
      }),
    ]),
    inboundCrossReferences: Object.freeze([]),
    nativeDependencies: Object.freeze({ availability: "available", relations: Object.freeze([]) }),
    nativeHierarchy: Object.freeze({ availability: "available", relations: Object.freeze([]) }),
    observedAt,
  });
}

function createPullRequestDetail(
  repository: PublicRepository,
  item: FixedPullRequest,
  targetIssue: FixedIssue,
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  const nodeId = createGitHubNodeId(item.nodeId);
  const headNodeId = createGitHubNodeId(item.headCommitNodeId);
  const headCommit: GitHubPullRequestCommit = Object.freeze({
    sourceId: buildPullRequestCommitSourceId(nodeId, headNodeId),
    nodeId: headNodeId,
    sha: item.headSha,
    committedAt: item.headCommittedAt,
    pushedAt: Object.freeze({ status: "available", value: item.headCommittedAt }),
  });
  const relatedItem = referencedIssue(repository, targetIssue);
  const commentUrl: GitHubItemUrl = `${itemUrl(repository, item)}#issuecomment-${item.commentNodeId}`;
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item_detail", nodeId),
    nodeId,
    repositoryId: repository.id,
    number: item.number,
    type: "pull_request",
    bodySourceId: buildProductionSourceId("github_item_body", nodeId),
    body: item.body,
    comments: Object.freeze([
      Object.freeze({
        sourceId: buildProductionSourceId("github_issue_comment", item.commentNodeId),
        nodeId: createGitHubNodeId(item.commentNodeId),
        sequence: 0,
        author: humanActor,
        body: item.commentBody,
        createdAt: item.commentAt,
        updatedAt: item.commentAt,
        url: commentUrl,
      }),
    ]),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    reviews: Object.freeze([]),
    reviewThreads: Object.freeze([]),
    reviewRequests: Object.freeze({ current: Object.freeze([]), history: Object.freeze([]) }),
    nativeClosingIssues: Object.freeze([
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_closing_issue",
          `${nodeId}:${relatedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relatedItem,
      }),
    ]),
    headSha: item.headSha,
    headCommit,
    commitMembership: Object.freeze({
      headSha: item.headSha,
      totalCount: 1,
      commits: Object.freeze([headCommit]),
    }),
    mergeState: Object.freeze({
      mergeability: "mergeable",
      mergeState: "blocked",
      autoMerge: Object.freeze({ status: "not_enabled" }),
      mergeQueue: Object.freeze({ status: "not_queued" }),
      checks: Object.freeze({
        status: "configured",
        sourceId: buildProductionSourceId(
          "github_status_check_rollup",
          `${nodeId}:${item.headSha}`,
        ),
        nodeId: createGitHubNodeId(`${nodeId}:checks`),
        combinedState: "pending",
        contexts: Object.freeze([]),
      }),
    }),
    observedAt,
  });
}

/** 合成項目の詳細を既存正規化へ渡す型で生成する。 */
export function createSandboxItemDetail(
  repository: PublicRepository,
  item: FixedItem,
  targetIssue: FixedIssue,
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  return item.type === "issue"
    ? createIssueDetail(repository, item, observedAt)
    : createPullRequestDetail(repository, item, targetIssue, observedAt);
}

/** 合成項目のnode IDを型付きで返す。 */
export function sandboxItemNodeId(item: FixedItem): GitHubNodeId {
  return createGitHubNodeId(item.nodeId);
}

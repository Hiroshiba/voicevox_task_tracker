import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createGitHubNodeId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type GitHubApiAccountType } from "./account-types.js";
import { type GitHubRestRequest } from "./client.js";
import { GitHubResponseValidationError } from "./errors.js";
import {
  type PublicRepository,
  type PublicRepositoryAllowlist,
  type PublicRepositoryId,
} from "./public-repository-allowlist.js";
import { deduplicateByStableId } from "./stable-id.js";

const ITEMS_PER_PAGE = 100;
const GITHUB_API_VERSION = "2022-11-28";

const nodeIdSchema = z.string().min(1).regex(/^\S+$/u);
const githubItemUrlSchema = z.custom<GitHubItemUrl>(
  (value) => {
    if (typeof value !== "string") {
      return false;
    }
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.port.length === 0 &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      return false;
    }
  },
  {
    error: "GitHub項目URLが不正です",
  },
);
const githubItemDisplayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
  {
    error: "owner/repository#number形式の表示用別名が不正です",
  },
);
const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
  })
  .transform((value) => createUtcIsoDateTime(value));
const accountSchema = z
  .object({
    node_id: nodeIdSchema,
    login: z.string().min(1),
    type: z.enum(["Bot", "EnterpriseUserAccount", "Mannequin", "Organization", "User"]),
  })
  .loose();
const labelSchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
    })
    .loose(),
]);
const milestoneSchema = z
  .object({
    node_id: nodeIdSchema,
    number: z.number().int().positive(),
    title: z.string().min(1),
    state: z.enum(["open", "closed"]),
  })
  .loose();
const itemMetadataSchema = z
  .object({
    node_id: nodeIdSchema,
    html_url: githubItemUrlSchema,
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    state_reason: z.enum(["completed", "not_planned", "duplicate", "reopened"]).nullable(),
    title: z.string().min(1),
    body: z.string().nullable(),
    user: accountSchema.nullable(),
    labels: z.array(labelSchema),
    assignees: z.array(accountSchema),
    milestone: milestoneSchema.nullable(),
    pull_request: z.object({}).loose().optional(),
    closed_at: utcIsoDateTimeSchema.nullable(),
    created_at: utcIsoDateTimeSchema,
    updated_at: utcIsoDateTimeSchema,
    draft: z.boolean().optional(),
  })
  .loose()
  .superRefine((item, context) => {
    if (
      Object.hasOwn(item, "discussion") ||
      Object.hasOwn(item, "category") ||
      Object.hasOwn(item, "answer_chosen_at")
    ) {
      context.addIssue({
        code: "custom",
        message: "Discussionは項目列挙へ含められません",
      });
    }
    if (item.pull_request != null && item.draft == null) {
      context.addIssue({
        code: "custom",
        path: ["draft"],
        message: "Pull Requestのdraft状態がありません",
      });
    }
    if (item.state === "open" && item.closed_at != null) {
      context.addIssue({
        code: "custom",
        path: ["closed_at"],
        message: "open項目にはclosed_atを指定できません",
      });
    }
    if (item.state === "closed" && item.closed_at == null) {
      context.addIssue({
        code: "custom",
        path: ["closed_at"],
        message: "closed項目にはclosed_atが必要です",
      });
    }
    if (item.state === "open" && item.state_reason != null && item.state_reason !== "reopened") {
      context.addIssue({
        code: "custom",
        path: ["state_reason"],
        message: "open項目のstate_reasonが不正です",
      });
    }
    if (item.state === "closed" && item.state_reason === "reopened") {
      context.addIssue({
        code: "custom",
        path: ["state_reason"],
        message: "closed項目にreopenedは指定できません",
      });
    }
  });
const itemPageSchema = z.array(itemMetadataSchema).max(ITEMS_PER_PAGE);

/** SHA-256で生成した内容fingerprint。 */
export type Sha256Fingerprint = `sha256:${string}`;

/** GitHub項目に紐づくアカウントの最小メタデータ。 */
export type GitHubItemAccount = Readonly<{
  nodeId: GitHubNodeId;
  login: string;
  apiType: GitHubApiAccountType;
}>;

/** GitHub項目の作成者。 */
export type GitHubItemAuthor =
  | Readonly<{
      kind: "account";
      account: GitHubItemAccount;
    }>
  | Readonly<{
      kind: "deleted_account";
    }>;

/** GitHub項目に設定されたmilestone。 */
export type GitHubItemMilestone = Readonly<{
  nodeId: GitHubNodeId;
  number: number;
  title: string;
  state: "open" | "closed";
}>;

/** 本文を必要時に再取得するための公開リポジトリ内locator。 */
export type GitHubItemBodyLocator = Readonly<{
  kind: "github_item_body";
  repositoryId: PublicRepositoryId;
  itemNodeId: GitHubNodeId;
  number: number;
}>;

type GitHubItemState =
  | Readonly<{
      state: "open";
      stateReason: "reopened" | null;
      closedAt: null;
    }>
  | Readonly<{
      state: "closed";
      stateReason: "completed" | "not_planned" | "duplicate" | null;
      closedAt: UtcIsoDateTime;
    }>;

type EnumeratedGitHubItemFields = Readonly<{
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  displayReference: GitHubItemDisplayReference;
  number: number;
  url: GitHubItemUrl;
  title: string;
  bodyFingerprint: Sha256Fingerprint;
  bodyLocator: GitHubItemBodyLocator;
  author: GitHubItemAuthor;
  createdAt: UtcIsoDateTime;
  updatedAt: UtcIsoDateTime;
  assignees: readonly GitHubItemAccount[];
  labels: readonly string[];
  milestone: GitHubItemMilestone | null;
  itemFingerprint: Sha256Fingerprint;
  observedAt: UtcIsoDateTime;
}>;

/** REST issues endpointから正規化した本文を含まないIssueまたはPull Request。 */
export type EnumeratedGitHubItem = EnumeratedGitHubItemFields &
  GitHubItemState &
  (
    | Readonly<{
        type: "issue";
        draft: "not_applicable";
      }>
    | Readonly<{
        type: "pull_request";
        draft: boolean;
      }>
  );

export type EnumerateOpenGitHubItemsOptions = Readonly<{
  allowlist: PublicRepositoryAllowlist;
  observedAt: UtcIsoDateTime;
  request: GitHubRestRequest;
}>;

type ParsedItemMetadata = z.output<typeof itemMetadataSchema>;

function createSha256Fingerprint(value: string): Sha256Fingerprint {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** GitHub本文の有無と内容を区別するSHA-256 fingerprintを生成する。 */
export function createGitHubBodyFingerprint(body: string | null): Sha256Fingerprint {
  return createSha256Fingerprint(JSON.stringify({ body }));
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeAccount(account: z.output<typeof accountSchema>): GitHubItemAccount {
  return Object.freeze({
    nodeId: createGitHubNodeId(account.node_id),
    login: account.login,
    apiType: account.type,
  });
}

function normalizeAuthor(account: z.output<typeof accountSchema> | null): GitHubItemAuthor {
  if (account == null) {
    return Object.freeze({
      kind: "deleted_account",
    });
  }
  return Object.freeze({
    kind: "account",
    account: normalizeAccount(account),
  });
}

function normalizeLabels(labels: readonly z.output<typeof labelSchema>[]): readonly string[] {
  const names = labels.map((label) => (typeof label === "string" ? label : label.name));
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    throw new GitHubResponseValidationError("IssueまたはPull Requestのlabels", {
      cause: new TypeError("同じlabelが重複しています"),
    });
  }
  return Object.freeze([...names].sort(compareText));
}

function normalizeAssignees(
  assignees: readonly z.output<typeof accountSchema>[],
): readonly GitHubItemAccount[] {
  const normalized = assignees.map(normalizeAccount);
  const nodeIds = new Set(normalized.map((assignee) => assignee.nodeId));
  if (nodeIds.size !== normalized.length) {
    throw new GitHubResponseValidationError("IssueまたはPull Requestのassignees", {
      cause: new TypeError("同じassigneeが重複しています"),
    });
  }
  return Object.freeze(
    [...normalized].sort((left, right) => compareText(left.nodeId, right.nodeId)),
  );
}

function normalizeMilestone(
  milestone: z.output<typeof milestoneSchema> | null,
): GitHubItemMilestone | null {
  if (milestone == null) {
    return null;
  }
  return Object.freeze({
    nodeId: createGitHubNodeId(milestone.node_id),
    number: milestone.number,
    title: milestone.title,
    state: milestone.state,
  });
}

function normalizeState(item: ParsedItemMetadata): GitHubItemState {
  if (item.state === "open") {
    if (item.state_reason != null && item.state_reason !== "reopened") {
      throw new GitHubResponseValidationError("IssueまたはPull Requestのstate", {
        cause: new TypeError("open項目のstate reasonが不正です"),
      });
    }
    return Object.freeze({
      state: "open",
      stateReason: item.state_reason,
      closedAt: null,
    });
  }
  if (item.closed_at == null || item.state_reason === "reopened") {
    throw new GitHubResponseValidationError("IssueまたはPull Requestのstate", {
      cause: new TypeError("closed項目のstate情報が不正です"),
    });
  }
  return Object.freeze({
    state: "closed",
    stateReason: item.state_reason,
    closedAt: item.closed_at,
  });
}

function createDisplayReference(
  repository: PublicRepository,
  number: number,
): GitHubItemDisplayReference {
  const displayReference = `${repository.owner}/${repository.name}#${number.toString()}`;
  const result = githubItemDisplayReferenceSchema.safeParse(displayReference);
  if (!result.success) {
    throw new GitHubResponseValidationError("IssueまたはPull Requestの表示用別名", {
      cause: new TypeError("owner/repository#number形式へ変換できません"),
    });
  }
  return result.data;
}

function assertItemUrlMatchesRepository(
  url: GitHubItemUrl,
  repository: PublicRepository,
  number: number,
  type: "issue" | "pull_request",
): void {
  const parsedUrl = new URL(url);
  const expectedKind = type === "issue" ? "issues" : "pull";
  const actualPath = parsedUrl.pathname.toLowerCase();
  const expectedPath =
    `/${repository.owner}/${repository.name}/${expectedKind}/${number.toString()}`.toLowerCase();
  if (actualPath !== expectedPath || parsedUrl.search.length !== 0 || parsedUrl.hash.length !== 0) {
    throw new GitHubResponseValidationError("IssueまたはPull RequestのURL", {
      cause: new TypeError("URLが公開allowlist内の項目を指していません"),
    });
  }
}

function createItemFingerprint(
  value: Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: PublicRepositoryId;
    type: "issue" | "pull_request";
    title: string;
    bodyFingerprint: Sha256Fingerprint;
    author: GitHubItemAuthor;
    createdAt: UtcIsoDateTime;
    updatedAt: UtcIsoDateTime;
    state: GitHubItemState;
    draft: boolean | "not_applicable";
    assignees: readonly GitHubItemAccount[];
    labels: readonly string[];
    milestone: GitHubItemMilestone | null;
  }>,
): Sha256Fingerprint {
  return createSha256Fingerprint(
    JSON.stringify({
      nodeId: value.nodeId,
      repositoryId: value.repositoryId,
      type: value.type,
      title: value.title,
      bodyFingerprint: value.bodyFingerprint,
      author: value.author,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      state: value.state.state,
      stateReason: value.state.stateReason,
      closedAt: value.state.closedAt,
      draft: value.draft,
      assignees: value.assignees,
      labels: value.labels,
      milestone: value.milestone,
    }),
  );
}

function normalizeItem(
  item: ParsedItemMetadata,
  repository: PublicRepository,
  observedAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  const nodeId = createGitHubNodeId(item.node_id);
  const type = item.pull_request == null ? "issue" : "pull_request";
  assertItemUrlMatchesRepository(item.html_url, repository, item.number, type);

  const state = normalizeState(item);
  const bodyFingerprint = createGitHubBodyFingerprint(item.body);
  const author = normalizeAuthor(item.user);
  const assignees = normalizeAssignees(item.assignees);
  const labels = normalizeLabels(item.labels);
  const milestone = normalizeMilestone(item.milestone);
  const bodyLocator = Object.freeze({
    kind: "github_item_body",
    repositoryId: repository.id,
    itemNodeId: nodeId,
    number: item.number,
  } satisfies GitHubItemBodyLocator);
  const commonFields = {
    nodeId,
    repositoryId: repository.id,
    displayReference: createDisplayReference(repository, item.number),
    number: item.number,
    url: item.html_url,
    title: item.title,
    bodyFingerprint,
    bodyLocator,
    author,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    assignees,
    labels,
    milestone,
    observedAt,
  };

  if (type === "issue") {
    const draft = "not_applicable";
    const itemFingerprint = createItemFingerprint({
      nodeId,
      repositoryId: repository.id,
      type,
      title: item.title,
      bodyFingerprint,
      author,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      state,
      draft,
      assignees,
      labels,
      milestone,
    });
    return Object.freeze({
      ...commonFields,
      ...state,
      type,
      draft,
      itemFingerprint,
    });
  }
  const draft = item.draft;
  if (draft == null) {
    throw new GitHubResponseValidationError("Pull Requestのdraft状態", {
      cause: new TypeError("draft状態がありません"),
    });
  }
  const itemFingerprint = createItemFingerprint({
    nodeId,
    repositoryId: repository.id,
    type,
    title: item.title,
    bodyFingerprint,
    author,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    state,
    draft,
    assignees,
    labels,
    milestone,
  });
  return Object.freeze({
    ...commonFields,
    ...state,
    type,
    draft,
    itemFingerprint,
  });
}

function getLinkHeader(
  headers: Readonly<Record<string, string | number | undefined>>,
  context: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "link") {
      continue;
    }
    if (value == null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new GitHubResponseValidationError(context, {
        cause: new TypeError("Link headerが文字列ではありません"),
      });
    }
    return value;
  }
  return undefined;
}

function hasNextPage(linkHeader: string): boolean {
  return linkHeader.split(",").some((link) => /;\s*rel="next"(?:\s*;|$)/u.test(link.trim()));
}

function shouldRequestNextPage(pageLength: number, linkHeader: string | undefined): boolean {
  if (linkHeader != null) {
    return hasNextPage(linkHeader);
  }
  return pageLength === ITEMS_PER_PAGE;
}

async function enumerateRepositoryOpenItems(
  repository: PublicRepository,
  observedAt: UtcIsoDateTime,
  request: GitHubRestRequest,
): Promise<readonly EnumeratedGitHubItem[]> {
  const items: EnumeratedGitHubItem[] = [];

  for (let page = 1; ; page += 1) {
    const context = `${repository.owner}/${repository.name} open IssueまたはPull Request page ${page.toString()}`;
    const response = await request("GET /repos/{owner}/{repo}/issues", {
      owner: repository.owner,
      repo: repository.name,
      state: "open",
      sort: "created",
      direction: "asc",
      per_page: ITEMS_PER_PAGE,
      page,
      headers: {
        accept: "application/vnd.github.raw+json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
    });
    if (response.status !== 200) {
      throw new GitHubResponseValidationError(context, {
        cause: new TypeError("成功以外のHTTP statusを受け取りました"),
      });
    }

    const parsedPage = itemPageSchema.safeParse(response.data);
    if (!parsedPage.success) {
      throw new GitHubResponseValidationError(context, {
        cause: new TypeError("IssueまたはPull Requestのmetadata形式が不正です"),
      });
    }
    const normalizedPage = parsedPage.data.map((item) =>
      normalizeItem(item, repository, observedAt),
    );
    if (normalizedPage.some((item) => item.state !== "open")) {
      throw new GitHubResponseValidationError(context, {
        cause: new TypeError("open以外の項目が含まれています"),
      });
    }
    items.push(...normalizedPage);

    const linkHeader = getLinkHeader(response.headers, `${context} Link header`);
    if (!shouldRequestNextPage(normalizedPage.length, linkHeader)) {
      break;
    }
    if (normalizedPage.length === 0) {
      throw new GitHubResponseValidationError(context, {
        cause: new TypeError("空のページに次ページへのLinkが指定されています"),
      });
    }
    if (page === Number.MAX_SAFE_INTEGER) {
      throw new GitHubResponseValidationError(context, {
        cause: new RangeError("ページ番号が安全な整数の上限へ到達しました"),
      });
    }
  }

  return deduplicateByStableId(items, (item) => item.nodeId);
}

/** 公開allowlist内の全リポジトリからopen IssueとPull Requestを全ページ列挙する。 */
export async function enumerateOpenGitHubItems(
  options: EnumerateOpenGitHubItemsOptions,
): Promise<readonly EnumeratedGitHubItem[]> {
  const items: EnumeratedGitHubItem[] = [];

  for (const repository of options.allowlist.repositories) {
    const repositoryItems = await enumerateRepositoryOpenItems(
      repository,
      options.observedAt,
      options.request,
    );
    items.push(...repositoryItems);
  }

  return deduplicateByStableId(items, (item) => item.nodeId);
}

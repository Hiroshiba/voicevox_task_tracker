import { z } from "zod";

import { ConfigError } from "../config/index.js";
import {
  createGitHubNodeId,
  listConfiguredTeamReferences,
  type GitHubTeamDirectory,
  type GitHubTeamMember,
  type ResolvedGitHubTeam,
  type TeamReference,
  type TeamResolutionSettings,
} from "../domain/index.js";
import { type GitHubRestRequest, type GitHubRestResponse } from "./client.js";
import { GitHubRequestError, GitHubResponseValidationError } from "./errors.js";

const TEAM_MEMBERS_PER_PAGE = 100;

const teamSchema = z
  .object({
    node_id: z.string().min(1).regex(/^\S+$/u),
    slug: z.string().min(1),
    organization: z
      .object({
        login: z.string().min(1),
      })
      .loose(),
  })
  .loose();

const teamMemberSchema = z
  .object({
    node_id: z.string().min(1).regex(/^\S+$/u),
    login: z.string().min(1),
  })
  .loose();

const teamMemberPageSchema = z.array(teamMemberSchema).max(TEAM_MEMBERS_PER_PAGE);

export type CollectGitHubTeamDirectoryOptions = Readonly<{
  teams: TeamResolutionSettings;
  request: GitHubRestRequest;
}>;

function createMissingTeamError(team: TeamReference, cause: unknown): ConfigError {
  return new ConfigError(
    [
      {
        path: "teams",
        message: `${team.org}/${team.slug}をGitHub上で確認できません`,
      },
    ],
    { cause },
  );
}

async function requestTeamResource(
  request: GitHubRestRequest,
  route: string,
  parameters: Readonly<Record<string, unknown>>,
  team: TeamReference,
): Promise<GitHubRestResponse> {
  let response: GitHubRestResponse;
  try {
    response = await request(route, parameters);
  } catch (error: unknown) {
    if (error instanceof GitHubRequestError && error.status === 404) {
      throw createMissingTeamError(team, error);
    }
    throw error;
  }

  if (response.status === 404) {
    throw createMissingTeamError(team, new TypeError("GitHub APIがteamを返しませんでした"));
  }
  return response;
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
  return pageLength === TEAM_MEMBERS_PER_PAGE;
}

async function fetchTeam(
  request: GitHubRestRequest,
  reference: TeamReference,
): Promise<Omit<ResolvedGitHubTeam, "members">> {
  const response = await requestTeamResource(
    request,
    "GET /orgs/{org}/teams/{team_slug}",
    {
      org: reference.org,
      team_slug: reference.slug,
    },
    reference,
  );
  if (response.status !== 200) {
    throw new GitHubResponseValidationError(`GitHub team ${reference.org}/${reference.slug}`, {
      cause: new TypeError("成功以外のHTTP statusを受け取りました"),
    });
  }

  const result = teamSchema.safeParse(response.data);
  if (!result.success) {
    throw new GitHubResponseValidationError(`GitHub team ${reference.org}/${reference.slug}`, {
      cause: new TypeError("team情報の形式が不正です"),
    });
  }
  if (
    result.data.organization.login.toLowerCase() !== reference.org.toLowerCase() ||
    result.data.slug.toLowerCase() !== reference.slug.toLowerCase()
  ) {
    throw new GitHubResponseValidationError(`GitHub team ${reference.org}/${reference.slug}`, {
      cause: new TypeError("取得したteamが設定したOrganizationまたはslugと一致しません"),
    });
  }

  return Object.freeze({
    nodeId: createGitHubNodeId(result.data.node_id),
    org: result.data.organization.login,
    slug: result.data.slug,
  });
}

function parseTeamMemberPage(
  data: unknown,
  team: TeamReference,
  page: number,
): readonly GitHubTeamMember[] {
  const result = teamMemberPageSchema.safeParse(data);
  if (!result.success) {
    throw new GitHubResponseValidationError(
      `GitHub team members ${team.org}/${team.slug} page ${page.toString()}`,
      {
        cause: new TypeError("team member一覧の形式が不正です"),
      },
    );
  }

  return result.data.map((member) =>
    Object.freeze({
      nodeId: createGitHubNodeId(member.node_id),
      login: member.login,
    }),
  );
}

function assertUniqueTeamMembers(members: readonly GitHubTeamMember[], team: TeamReference): void {
  const nodeIds = new Set<string>();
  const logins = new Set<string>();
  for (const member of members) {
    const normalizedLogin = member.login.toLowerCase();
    if (nodeIds.has(member.nodeId) || logins.has(normalizedLogin)) {
      throw new GitHubResponseValidationError(`GitHub team members ${team.org}/${team.slug}`, {
        cause: new TypeError("team memberが重複しています"),
      });
    }
    nodeIds.add(member.nodeId);
    logins.add(normalizedLogin);
  }
}

async function fetchTeamMembers(
  request: GitHubRestRequest,
  team: TeamReference,
): Promise<readonly GitHubTeamMember[]> {
  const members: GitHubTeamMember[] = [];

  for (let page = 1; ; page += 1) {
    const response = await requestTeamResource(
      request,
      "GET /orgs/{org}/teams/{team_slug}/members",
      {
        org: team.org,
        team_slug: team.slug,
        role: "all",
        per_page: TEAM_MEMBERS_PER_PAGE,
        page,
      },
      team,
    );
    if (response.status !== 200) {
      throw new GitHubResponseValidationError(
        `GitHub team members ${team.org}/${team.slug} page ${page.toString()}`,
        {
          cause: new TypeError("成功以外のHTTP statusを受け取りました"),
        },
      );
    }

    const pageMembers = parseTeamMemberPage(response.data, team, page);
    members.push(...pageMembers);

    const linkHeader = getLinkHeader(
      response.headers,
      `GitHub team members ${team.org}/${team.slug} page ${page.toString()} Link header`,
    );
    if (!shouldRequestNextPage(pageMembers.length, linkHeader)) {
      break;
    }
    if (pageMembers.length === 0) {
      throw new GitHubResponseValidationError(
        `GitHub team members ${team.org}/${team.slug} page ${page.toString()}`,
        {
          cause: new TypeError("空のページに次ページへのLinkが指定されています"),
        },
      );
    }
    if (page === Number.MAX_SAFE_INTEGER) {
      throw new GitHubResponseValidationError(`GitHub team members ${team.org}/${team.slug}`, {
        cause: new RangeError("ページ番号が安全な整数の上限へ到達しました"),
      });
    }
  }

  assertUniqueTeamMembers(members, team);
  return Object.freeze(members);
}

/** 設定された全teamの存在とmembershipをGitHub APIで解決する。 */
export async function collectGitHubTeamDirectory(
  options: CollectGitHubTeamDirectoryOptions,
): Promise<GitHubTeamDirectory> {
  const directory: ResolvedGitHubTeam[] = [];

  for (const reference of listConfiguredTeamReferences(options.teams)) {
    const team = await fetchTeam(options.request, reference);
    const members = await fetchTeamMembers(options.request, reference);
    directory.push(
      Object.freeze({
        ...team,
        members,
      }),
    );
  }

  return Object.freeze(directory);
}

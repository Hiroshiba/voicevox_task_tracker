import { z } from "zod";

import { GitHubGraphQLDocumentError, GitHubReadOnlyViolationError } from "./errors.js";
import { assertReadOnlyGraphQL } from "./graphql.js";

type GuardedRequestOptions = Readonly<{
  method: string;
  url: string;
  baseUrl: string;
  query?: unknown;
  installation_id?: unknown;
}>;

const installationIdSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number),
]);

function resolveRequestUrl(url: string, trustedBaseUrl: string): URL {
  const baseUrl = new URL(trustedBaseUrl);
  const resolvedUrl = new URL(url, baseUrl);
  if (resolvedUrl.origin !== baseUrl.origin) {
    throw new GitHubReadOnlyViolationError("EXTERNAL");
  }
  return resolvedUrl;
}

function getRelativeApiPath(url: URL, trustedBaseUrl: string): string {
  const basePath = new URL(trustedBaseUrl).pathname.replace(/\/$/u, "");
  if (basePath.length > 0 && url.pathname.startsWith(`${basePath}/`)) {
    return url.pathname.slice(basePath.length);
  }
  return url.pathname;
}

function isGraphQLPath(url: URL, trustedBaseUrl: string): boolean {
  const basePath = new URL(trustedBaseUrl).pathname.replace(/\/$/u, "");
  const expectedPath = basePath.endsWith("/api/v3")
    ? `${basePath.slice(0, -"/api/v3".length)}/api/graphql`
    : `${basePath}/graphql`;
  return url.pathname === expectedPath.replace(/^\/\//u, "/");
}

/** リクエスト先がGitHub GraphQL endpointかを判定する。 */
export function isGitHubGraphQLRequest(url: string, trustedBaseUrl: string): boolean {
  return isGraphQLPath(resolveRequestUrl(url, trustedBaseUrl), trustedBaseUrl);
}

function isInstallationTokenRequest(
  options: GuardedRequestOptions,
  relativePath: string,
  allowedInstallationId: number | undefined,
): boolean {
  if (allowedInstallationId == null) {
    return false;
  }

  const literalPath = `/app/installations/${allowedInstallationId.toString()}/access_tokens`;
  if (relativePath === literalPath) {
    return true;
  }
  const templatePath = "/app/installations/{installation_id}/access_tokens";
  if (decodeURIComponent(relativePath) !== templatePath) {
    return false;
  }

  const result = installationIdSchema.safeParse(options.installation_id);
  return result.success && result.data === allowedInstallationId;
}

/** HTTP methodとGraphQL操作を読み取り専用APIへ制限する。 */
export function assertReadOnlyGitHubRequest(
  options: GuardedRequestOptions,
  trustedBaseUrl: string,
  allowedInstallationId: number | undefined,
): void {
  const method = options.method.toUpperCase();
  const url = resolveRequestUrl(options.url, trustedBaseUrl);
  const relativePath = getRelativeApiPath(url, trustedBaseUrl);

  if (isGraphQLPath(url, trustedBaseUrl)) {
    if (method !== "POST") {
      throw new GitHubReadOnlyViolationError(method);
    }
    if (typeof options.query !== "string") {
      throw new GitHubGraphQLDocumentError({
        cause: new TypeError("GraphQL queryが指定されていません"),
      });
    }
    assertReadOnlyGraphQL(options.query);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    return;
  }
  if (
    method === "POST" &&
    isInstallationTokenRequest(options, relativePath, allowedInstallationId)
  ) {
    return;
  }
  throw new GitHubReadOnlyViolationError(method);
}

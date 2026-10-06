import type { Repository } from "../domain/index.js";
import { isGitHubHost, mayHaveGitHubAuthority, scanUrlLikeText } from "../domain/url-like-text.js";
import {
  verifiedExternalUrls,
  type VerifiedExternalReference,
} from "../domain/verified-external-reference.js";

import { assertNonNullable } from "../util/index.js";

type RepositoryReference = Pick<Repository, "id" | "owner" | "name" | "visibility">;
type InvalidUrlLikeTextScan = Extract<ReturnType<typeof scanUrlLikeText>, { status: "invalid" }>;
type RepositoryTextReferenceFinding =
  | Readonly<{
      reason:
        | "private_repository_url"
        | "private_repository_name"
        | `scanner_${Exclude<InvalidUrlLikeTextScan["reason"], "invalid_encoding">}`;
    }>
  | Readonly<{
      reason: "scanner_invalid_encoding";
      scanFailure: Extract<InvalidUrlLikeTextScan, { reason: "invalid_encoding" }>["failure"];
    }>;

const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

function escapePattern(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsRepositoryName(value: string, repository: RepositoryReference): boolean {
  const fullName = `${escapePattern(repository.owner)}/${escapePattern(repository.name)}`;
  return new RegExp(
    `(?<![A-Za-z0-9_.%/?=&-])${fullName}(?:\\.git)?(?![A-Za-z0-9_./%-]|\\.[A-Za-z0-9_-])`,
    "iu",
  ).test(value);
}

function containsRepositoryNameInUrl(value: string, repository: RepositoryReference): boolean {
  const fullName = `${escapePattern(repository.owner)}/${escapePattern(repository.name)}`;
  return new RegExp(`(?<![A-Za-z0-9_.%-])${fullName}(?:\\.git)?(?![A-Za-z0-9_.%-])`, "iu").test(
    value,
  );
}

function absoluteUrl(candidate: string): string {
  if (candidate.startsWith("//")) {
    return `https:${candidate}`;
  }
  if (URL_SCHEME_PATTERN.test(candidate)) {
    return candidate;
  }
  return `https://${candidate}`;
}

function decodedPathComponent(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") || decoded.includes("\\") ? undefined : decoded;
  } catch (error: unknown) {
    if (error instanceof URIError) {
      return undefined;
    }
    throw error;
  }
}

function repositoryTextReferenceFinding(
  value: string,
  repository: RepositoryReference,
): RepositoryTextReferenceFinding | undefined {
  const scan = scanUrlLikeText(value);
  if (scan.status === "invalid") {
    return scan.reason === "invalid_encoding"
      ? { reason: "scanner_invalid_encoding", scanFailure: scan.failure }
      : { reason: `scanner_${scan.reason}` };
  }
  const urls = scan.candidates;
  if (
    urls.some((url) => {
      const referenced = githubRepositoryFromUrl(url);
      return (
        (referenced != null &&
          referenced !== "invalid" &&
          referenced.owner === repository.owner.toLowerCase() &&
          referenced.name === repository.name.toLowerCase()) ||
        containsRepositoryNameInUrl(url, repository)
      );
    })
  ) {
    return { reason: "private_repository_url" };
  }
  let remaining = value;
  for (const url of urls) {
    remaining = remaining.replaceAll(url, " ");
  }
  return containsRepositoryName(remaining, repository) ||
    scan.decodedTexts.some(
      (text) =>
        containsRepositoryName(text, repository) || containsRepositoryNameInUrl(text, repository),
    )
    ? { reason: "private_repository_name" }
    : undefined;
}

function githubRepositoryFromUrl(
  candidate: string,
): Readonly<{ owner: string; name: string }> | "invalid" | undefined {
  const value = absoluteUrl(candidate);
  if (!URL.canParse(value)) {
    return mayHaveGitHubAuthority(candidate) ? "invalid" : undefined;
  }
  const url = new URL(value);
  if (!isGitHubHost(url.hostname)) {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return "invalid";
  }
  const [, rawOwner, rawName, ...remaining] = url.pathname.split("/");
  if (rawOwner == null) {
    return undefined;
  }
  const owner = decodedPathComponent(rawOwner);
  if (owner == null) {
    return "invalid";
  }
  if (rawName == null) {
    return undefined;
  }
  if (rawOwner.length === 0 || rawName.length === 0) {
    return rawName.length > 0 || remaining.some((segment) => segment.length > 0)
      ? "invalid"
      : undefined;
  }
  const decodedName = decodedPathComponent(rawName);
  if (decodedName == null) {
    return "invalid";
  }
  const name = decodedName.toLowerCase();
  return Object.freeze({
    owner: owner.toLowerCase(),
    name: name.endsWith(".git") ? name.slice(0, -4) : name,
  });
}

function isVerifiedExternalUrl(candidate: string, allowed: ReadonlySet<string>): boolean {
  const url = new URL(absoluteUrl(candidate));
  if (url.search !== "" || url.hash !== "") {
    return false;
  }
  if (isGitHubHost(url.hostname)) {
    url.hostname = "github.com";
  }
  const normalized = url.toString().replace(/\/$/u, "").toLowerCase();
  return allowed.has(normalized);
}

/** AI由来の自然文に許可されないURL形式があるか判定する。 */
export function containsDisallowedAiTextUrl(
  value: string,
  allowlist: readonly Pick<RepositoryReference, "owner" | "name">[],
  externalReferences: readonly VerifiedExternalReference[],
): boolean {
  const scan = scanUrlLikeText(value);
  if (scan.status === "invalid") return true;
  const candidates = scan.candidates;
  if (candidates.length === 0) {
    return false;
  }
  const externalUrls = verifiedExternalUrls(externalReferences);
  if (externalUrls == null) {
    return true;
  }
  const allowed = new Set(
    allowlist.map(
      (repository) => `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
    ),
  );
  return candidates.some((candidate) => {
    if (!candidate.startsWith("https://") || !URL.canParse(candidate)) {
      return true;
    }
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !isGitHubHost(url.hostname) ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return true;
    }
    const repository = githubRepositoryFromUrl(candidate);
    if (repository == null || repository === "invalid") {
      return true;
    }
    if (repository.owner === "voicevox") {
      return !allowed.has(`${repository.owner}/${repository.name}`);
    }
    url.hostname = "github.com";
    return !externalUrls.has(url.toString().replace(/\/$/u, "").toLowerCase());
  });
}

/** AI由来の値に許可されないURL形式があるか判定する。 */
export function containsDisallowedAiTextUrlInValues(
  values: readonly unknown[],
  allowlist: readonly Pick<RepositoryReference, "owner" | "name">[],
  externalReferences: readonly VerifiedExternalReference[],
): boolean {
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (containsDisallowedAiTextUrl(value, allowlist, externalReferences)) {
        return true;
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      for (const element of value) {
        pending.push(element);
      }
    } else {
      for (const propertyValue of Object.values(value)) {
        pending.push(propertyValue);
      }
    }
  }
  return false;
}

/** 公開値に含まれるGitHubリポジトリURLが公開集合に属するか判定する。 */
export function containsUnallowlistedGitHubRepositoryUrl(
  values: readonly unknown[],
  allowlist: readonly Pick<RepositoryReference, "owner" | "name">[],
  externalReferences: readonly VerifiedExternalReference[],
): boolean {
  const allowed = new Set(
    allowlist.map(
      (repository) => `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
    ),
  );
  const externalUrls = verifiedExternalUrls(externalReferences);
  if (externalUrls == null) {
    return true;
  }
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();
  const visitedStrings = new Set<string>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (visitedStrings.has(value)) {
        continue;
      }
      visitedStrings.add(value);
      const scan = scanUrlLikeText(value);
      if (scan.status === "invalid") return true;
      for (const candidate of scan.candidates) {
        const repository = githubRepositoryFromUrl(candidate);
        if (
          repository === "invalid" ||
          (repository != null &&
            !allowed.has(`${repository.owner}/${repository.name}`) &&
            !isVerifiedExternalUrl(candidate, externalUrls))
        ) {
          return true;
        }
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      for (const element of value) {
        pending.push(element);
      }
    } else {
      for (const propertyValue of Object.values(value)) {
        pending.push(propertyValue);
      }
    }
  }
  return false;
}

function isRepositoryIdField(key: string, parent: object): boolean {
  return (
    key === "repositoryId" ||
    (key === "id" &&
      "owner" in parent &&
      typeof parent.owner === "string" &&
      "name" in parent &&
      typeof parent.name === "string")
  );
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export type PrivateRepositoryReferenceFinding = Readonly<{
  path: readonly (string | number)[];
  value: string;
}> &
  (Readonly<{ reason: "private_repository_id" }> | RepositoryTextReferenceFinding);

/** 既知の非公開repository参照または検査不能な値の最初の位置を返す。 */
export function findPrivateRepositoryReference(
  values: readonly unknown[],
  inventory: readonly RepositoryReference[],
): PrivateRepositoryReferenceFinding | undefined {
  const privateRepositories = inventory.filter((repository) => repository.visibility !== "public");
  if (privateRepositories.length === 0) {
    return undefined;
  }
  const pending: { value: unknown; path: readonly (string | number)[] }[] = values.map(
    (value, index) => ({ value, path: [index] }),
  );
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    assertNonNullable(entry, "非公開repository参照の検査対象がありません");
    const { value, path } = entry;
    if (typeof value === "string") {
      for (const repository of privateRepositories) {
        const finding = repositoryTextReferenceFinding(value, repository);
        if (finding != null) {
          return Object.freeze({ ...finding, path, value });
        }
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      pending.push(...value.map((item, index) => ({ value: item, path: [...path, index] })));
      continue;
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      const propertyPath = [...path, key];
      if (
        isRepositoryIdField(key, value) &&
        typeof propertyValue === "string" &&
        privateRepositories.some((repository) => propertyValue === repository.id)
      ) {
        return Object.freeze({
          reason: "private_repository_id",
          path: propertyPath,
          value: propertyValue,
        });
      }
      pending.push({ value: propertyValue, path: propertyPath });
    }
  }
  return undefined;
}

/** 既知の非公開repositoryへの構造化IDまたは境界付きの名前参照を検出する。 */
export function containsPrivateRepositoryReference(
  values: readonly unknown[],
  inventory: readonly RepositoryReference[],
): boolean {
  return findPrivateRepositoryReference(values, inventory) != null;
}

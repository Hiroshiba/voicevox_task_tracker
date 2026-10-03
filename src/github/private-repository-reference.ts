import type { Repository } from "../domain/index.js";
import {
  verifiedExternalUrls,
  type VerifiedExternalReference,
} from "../domain/verified-external-reference.js";

type RepositoryReference = Pick<Repository, "id" | "owner" | "name" | "visibility">;

const URL_PATTERN =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?=[/?#]))[^\s<>"'`]+/gu;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const TRAILING_URL_PUNCTUATION = /[.,;:!?、。！？)\]}）］｝」』]+$/u;

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
  const decoded = value.replaceAll(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) =>
    new TextDecoder("utf-8").decode(
      Uint8Array.from(encoded.slice(1).split("%"), (hex) => Number.parseInt(hex, 16)),
    ),
  );
  return new RegExp(`(?<![A-Za-z0-9_.%-])${fullName}(?:\\.git)?(?![A-Za-z0-9_.%-])`, "iu").test(
    decoded,
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

function isRepositoryUrl(candidate: string, repository: RepositoryReference): boolean {
  const source = candidate.replace(TRAILING_URL_PUNCTUATION, "");
  const value = absoluteUrl(source);
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return false;
  }
  const [, rawOwner, rawName] = url.pathname.split("/");
  if (rawOwner == null || rawName == null) {
    return false;
  }
  const owner = decodedPathComponent(rawOwner);
  const name = decodedPathComponent(rawName);
  if (owner == null || name == null) {
    return false;
  }
  return (
    owner.toLowerCase() === repository.owner.toLowerCase() &&
    (name.toLowerCase() === repository.name.toLowerCase() ||
      name.toLowerCase() === `${repository.name.toLowerCase()}.git`)
  );
}

function containsRepositoryReference(value: string, repository: RepositoryReference): boolean {
  const urls = [...value.matchAll(URL_PATTERN)];
  if (
    urls.some(
      ([url]) => isRepositoryUrl(url, repository) || containsRepositoryNameInUrl(url, repository),
    )
  ) {
    return true;
  }
  return containsRepositoryName(value.replaceAll(URL_PATTERN, " "), repository);
}

function githubRepositoryFromUrl(
  candidate: string,
): Readonly<{ owner: string; name: string }> | "invalid" | undefined {
  const value = absoluteUrl(candidate.replace(TRAILING_URL_PUNCTUATION, ""));
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  if (url.hostname !== "github.com") {
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
  const [, rawOwner, rawName] = url.pathname.split("/");
  if (rawOwner == null || rawName == null || rawOwner.length === 0 || rawName.length === 0) {
    return undefined;
  }
  const owner = decodedPathComponent(rawOwner);
  const decodedName = decodedPathComponent(rawName);
  if (owner == null || decodedName == null) {
    return "invalid";
  }
  const name = decodedName.endsWith(".git") ? decodedName.slice(0, -4) : decodedName;
  return Object.freeze({ owner: owner.toLowerCase(), name: name.toLowerCase() });
}

function isVerifiedExternalUrl(candidate: string, allowed: ReadonlySet<string>): boolean {
  const url = new URL(absoluteUrl(candidate.replace(TRAILING_URL_PUNCTUATION, "")));
  if (url.search !== "" || url.hash !== "") {
    return false;
  }
  const normalized = url.toString().replace(/\/$/u, "").toLowerCase();
  return allowed.has(normalized);
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
      for (const [candidate] of value.matchAll(URL_PATTERN)) {
        const repository = githubRepositoryFromUrl(candidate);
        if (
          repository === "invalid" ||
          (repository != null &&
            !allowed.has(`${repository.owner}/${repository.name}`) &&
            !isVerifiedExternalUrl(candidate, externalUrls))
        ) {
          return true;
        }
        const urlValue = absoluteUrl(candidate.replace(TRAILING_URL_PUNCTUATION, ""));
        if (URL.canParse(urlValue)) {
          const url = new URL(urlValue);
          pending.push(...url.searchParams.values());
          if (url.hash.length > 1) {
            pending.push(url.hash.slice(1));
          }
        }
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      pending.push(...value);
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

/** 既知の非公開repositoryへの構造化IDまたは境界付きの名前参照を検出する。 */
export function containsPrivateRepositoryReference(
  values: readonly unknown[],
  inventory: readonly RepositoryReference[],
): boolean {
  const privateRepositories = inventory.filter((repository) => repository.visibility !== "public");
  if (privateRepositories.length === 0) {
    return false;
  }
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (
        privateRepositories.some((repository) => containsRepositoryReference(value, repository))
      ) {
        return true;
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      if (
        isRepositoryIdField(key, value) &&
        typeof propertyValue === "string" &&
        privateRepositories.some((repository) => propertyValue === repository.id)
      ) {
        return true;
      }
      pending.push(propertyValue);
    }
  }
  return false;
}

import type { Repository } from "../domain/index.js";

function escapePattern(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/gu;

function containsRepositoryName(value: string, repository: Repository): boolean {
  const fullName = `${escapePattern(repository.owner)}/${escapePattern(repository.name)}`;
  return new RegExp(
    `(?<![A-Za-z0-9_.-])${fullName}(?:\\.git)?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
    "iu",
  ).test(value);
}

function isRepositoryUrl(value: string, repository: Repository): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname !== "github.com") {
    return false;
  }
  const [, owner, rawName, ...remainingPath] = url.pathname.split("/");
  if (owner == null || rawName == null) {
    return false;
  }
  const name = remainingPath.length === 0 ? rawName.replace(/[.,;:!?)\]}]+$/u, "") : rawName;
  return (
    owner.toLowerCase() === repository.owner.toLowerCase() &&
    (name.toLowerCase() === repository.name.toLowerCase() ||
      name.toLowerCase() === `${repository.name.toLowerCase()}.git`)
  );
}

function containsRepositoryReference(value: string, repository: Repository): boolean {
  const urls = [...value.matchAll(URL_PATTERN)];
  if (urls.some(([url]) => isRepositoryUrl(url, repository))) {
    return true;
  }
  const textWithoutUrls = value.replaceAll(URL_PATTERN, " ");
  return containsRepositoryName(textWithoutUrls, repository);
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
  inventory: readonly Repository[],
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

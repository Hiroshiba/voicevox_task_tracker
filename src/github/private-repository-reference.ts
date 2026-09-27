import type { Repository } from "../domain/index.js";

function escapePattern(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsRepositoryName(value: string, repository: Repository): boolean {
  const fullName = `${escapePattern(repository.owner)}/${escapePattern(repository.name)}`;
  return new RegExp(`(?<![A-Za-z0-9_.-])${fullName}(?![A-Za-z0-9_.-])`, "iu").test(value);
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
      if (privateRepositories.some((repository) => containsRepositoryName(value, repository))) {
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

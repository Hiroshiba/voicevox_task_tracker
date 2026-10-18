import type { SourceId } from "../../../domain/source-id.js";
import {
  createGitHubRepositoryId,
  type Repository,
  type UtcIsoDateTime,
} from "../../../domain/types.js";
import type { GitHubRateLimitSnapshot } from "../../../github/errors.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type {
  GitHubItemDetail,
  LegacyReviewRequestInspection,
} from "../../../github/item-detail-types.js";
import type {
  PublicRepository,
  PublicRepositoryAllowlist,
} from "../../../github/public-repository-allowlist.js";

import { SANDBOX_FIXED_SOURCE_DATASET } from "./dataset.js";
import {
  parseSandboxFixedSourceDescriptor,
  type SandboxFixedSourceDescriptor,
} from "./descriptor.js";
import { createSandboxEnumeratedItem, createSandboxItemDetail } from "./items.js";

type DetailTarget = Readonly<{ item: EnumeratedGitHubItem }>;
type FixedItem = (typeof SANDBOX_FIXED_SOURCE_DATASET.items)[number];

/** 固定された公開合成GitHub読取値を返す境界。 */
export type SandboxFixedSource = Readonly<{
  descriptor: SandboxFixedSourceDescriptor;
  installationId: number;
  discoverInventory: (organization: string, observedAt: UtcIsoDateTime) => readonly Repository[];
  enumerateOpen: (
    allowlist: PublicRepositoryAllowlist,
    repositories: readonly PublicRepository[],
    observedAt: UtcIsoDateTime,
  ) => readonly EnumeratedGitHubItem[];
  enumerateByIdentifiers: (
    allowlist: PublicRepositoryAllowlist,
    identifiers: readonly string[],
    observedAt: UtcIsoDateTime,
  ) => readonly EnumeratedGitHubItem[];
  collectDetails: (
    allowlist: PublicRepositoryAllowlist,
    targets: readonly DetailTarget[],
    observedAt: UtcIsoDateTime,
  ) => readonly GitHubItemDetail[];
  collectRepositoryMetadata: (
    allowlist: PublicRepositoryAllowlist,
    repositoryFullNames: readonly string[],
    observedAt: UtcIsoDateTime,
  ) => readonly Repository[];
  inspectLegacyReviewRequests: (
    sourceIds: readonly SourceId[],
  ) => readonly LegacyReviewRequestInspection[];
  rateLimitSnapshot: () => GitHubRateLimitSnapshot;
}>;

const dataset = SANDBOX_FIXED_SOURCE_DATASET;
const repositoryId = createGitHubRepositoryId(dataset.repository.nodeId);
const repositoryFullName = `${dataset.organization}/${dataset.repository.name}`;
const itemByNodeId = new Map(dataset.items.map((item) => [item.nodeId, item]));
const itemByUrl = new Map(
  dataset.items.map((item) => [
    `https://github.com/${repositoryFullName}/${item.type === "issue" ? "issues" : "pull"}/${item.number.toString()}`,
    item,
  ]),
);

function assertObservedAt(
  descriptor: SandboxFixedSourceDescriptor,
  observedAt: UtcIsoDateTime,
): void {
  const times = dataset.clock[descriptor.runSlot];
  if (observedAt !== times.startedAt && observedAt !== times.evaluatedAt) {
    throw new TypeError("固定sourceの観測時刻が記述子のrun時計と一致しません");
  }
}

function requireRepository(allowlist: PublicRepositoryAllowlist): PublicRepository {
  const repository = allowlist.require(repositoryId);
  if (`${repository.owner}/${repository.name}` !== repositoryFullName) {
    throw new TypeError("固定sourceのrepositoryと公開allowlistが一致しません");
  }
  return repository;
}

function createRepository(observedAt: UtcIsoDateTime): Repository {
  return Object.freeze({
    id: repositoryId,
    owner: dataset.organization,
    name: dataset.repository.name,
    visibility: dataset.repository.visibility,
    archived: dataset.repository.archived,
    disabled: dataset.repository.disabled,
    observedAt,
  });
}

function requireItem(identifier: string): FixedItem {
  const item = itemByNodeId.get(identifier) ?? itemByUrl.get(identifier);
  if (item == null) {
    throw new TypeError("固定sourceの閉集合にないGitHub項目が指定されました");
  }
  return item;
}

function requireNativeTargetIssue(
  item: Extract<FixedItem, { type: "pull_request" }>,
): Extract<FixedItem, { type: "issue" }> {
  const target = dataset.items.find(
    (candidate) => candidate.key === item.nativeClosingIssueKeys[0],
  );
  if (target?.type !== "issue") {
    throw new TypeError("固定sourceのnative対象が閉集合にありません");
  }
  return target;
}

/** 検証済み記述子へ結び付けた合成GitHub読取源を生成する。 */
export function createSandboxFixedSource(
  descriptor: SandboxFixedSourceDescriptor,
): SandboxFixedSource {
  const validated = parseSandboxFixedSourceDescriptor(descriptor);
  return Object.freeze({
    descriptor: validated,
    installationId: dataset.installationId,
    discoverInventory(organization, observedAt) {
      assertObservedAt(validated, observedAt);
      if (organization !== dataset.organization) {
        throw new TypeError("固定sourceのorganizationが要求と一致しません");
      }
      return Object.freeze([createRepository(observedAt)]);
    },
    enumerateOpen(allowlist, repositories, observedAt) {
      assertObservedAt(validated, observedAt);
      const repository = requireRepository(allowlist);
      for (const requested of repositories) {
        if (
          requested.id !== repository.id ||
          requested.owner !== repository.owner ||
          requested.name !== repository.name
        ) {
          throw new TypeError("固定sourceの閉集合にないrepositoryが指定されました");
        }
      }
      if (repositories.length > 1) {
        throw new TypeError("固定sourceのrepositoryが重複しています");
      }
      return Object.freeze(
        repositories.length === 0
          ? []
          : dataset.items
              .filter((item) => item.type === "pull_request")
              .map((item) => createSandboxEnumeratedItem(repository, item, observedAt)),
      );
    },
    enumerateByIdentifiers(allowlist, identifiers, observedAt) {
      assertObservedAt(validated, observedAt);
      const repository = requireRepository(allowlist);
      const result = new Map<string, EnumeratedGitHubItem>();
      for (const identifier of identifiers) {
        const item = requireItem(identifier);
        result.set(item.nodeId, createSandboxEnumeratedItem(repository, item, observedAt));
      }
      return Object.freeze([...result.values()]);
    },
    collectDetails(allowlist, targets, observedAt) {
      assertObservedAt(validated, observedAt);
      const repository = requireRepository(allowlist);
      const seen = new Set<string>();
      return Object.freeze(
        targets.map(({ item }) => {
          const fixedItem = requireItem(item.nodeId);
          const canonical = createSandboxEnumeratedItem(repository, fixedItem, item.observedAt);
          if (
            seen.has(item.nodeId) ||
            item.repositoryId !== repository.id ||
            item.number !== canonical.number ||
            item.type !== canonical.type ||
            item.url !== canonical.url ||
            item.itemFingerprint !== canonical.itemFingerprint
          ) {
            throw new TypeError("固定sourceの詳細取得対象が合成列挙結果と一致しません");
          }
          seen.add(item.nodeId);
          const targetIssue =
            fixedItem.type === "issue" ? fixedItem : requireNativeTargetIssue(fixedItem);
          return createSandboxItemDetail(repository, fixedItem, targetIssue, observedAt);
        }),
      );
    },
    collectRepositoryMetadata(allowlist, repositoryFullNames, observedAt) {
      assertObservedAt(validated, observedAt);
      requireRepository(allowlist);
      if (
        repositoryFullNames.some((name) => name !== repositoryFullName) ||
        repositoryFullNames.length > 1
      ) {
        throw new TypeError("固定sourceの閉集合にないrepository metadataが指定されました");
      }
      return Object.freeze(repositoryFullNames.map(() => createRepository(observedAt)));
    },
    inspectLegacyReviewRequests(sourceIds) {
      if (sourceIds.length !== 0) {
        throw new TypeError("固定sourceの閉集合にない旧review requestが指定されました");
      }
      return Object.freeze([]);
    },
    rateLimitSnapshot() {
      const times = dataset.clock[validated.runSlot];
      return Object.freeze({
        source: "graphql",
        limit: dataset.rateLimit.limit,
        remaining: dataset.rateLimit.remaining,
        resetAt: times.evaluatedAt,
        observedAt: times.startedAt,
        cost: 0,
      });
    },
  });
}

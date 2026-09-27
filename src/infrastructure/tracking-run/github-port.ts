import type { RepositoryInventoryPort } from "../../application/tracking-run/stages/inventory.js";
import type { InventoryCollectedRun } from "../../application/tracking-run/stages/inventory.js";
import type { GitHubReadPort } from "../../application/tracking-run/ports.js";
import type { GitHubClient, CreateGitHubClientOptions } from "../../github/client.js";
import type { GitHubAppCredentials } from "../../github/credentials.js";
import type { GitHubRateLimitSnapshot } from "../../github/errors.js";
import {
  PublicRepositoryAllowlist,
  createPublicRepositoryAllowlist,
} from "../../github/public-repository-allowlist.js";
import {
  type enumerateGitHubItemsByIdentifiers,
  type enumerateOpenGitHubItems,
  type EnumeratedGitHubItem,
} from "../../github/item-enumeration.js";
import type { collectGitHubItemDetails } from "../../github/item-detail-collection.js";
import type { GitHubItemDetail } from "../../github/item-detail-types.js";
import {
  normalizeObservedGitHubItems,
  type FreshObservedGitHubItem,
} from "../../github/item-normalization.js";
import type { discoverRepositoryInventory } from "../../github/repository-inventory.js";

type GitHubInventoryDependencies = Readonly<{
  credentials: GitHubAppCredentials;
  createClient: (options: CreateGitHubClientOptions) => Promise<GitHubClient>;
  discoverInventory: typeof discoverRepositoryInventory;
  sessions: GitHubRunSessions;
}>;

type GitHubReadDependencies = Readonly<{
  enumerateOpen: typeof enumerateOpenGitHubItems;
  enumerateByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  collectDetails: typeof collectGitHubItemDetails;
}>;

/** runごとのGitHub clientをstage成果物の外で保持する。 */
export class GitHubRunSessions {
  readonly #clients = new Map<string, GitHubClient>();

  /** 認証済みclientをrunへ結び付ける。 */
  public register(runId: string, client: GitHubClient): void {
    if (this.#clients.has(runId)) {
      throw new TypeError("同じrunのGitHub sessionが既にあります");
    }
    this.#clients.set(runId, client);
  }

  /** 収集段階で認証済みclientを使う。 */
  public require(runId: string): GitHubClient {
    const client = this.#clients.get(runId);
    if (client == null) {
      throw new TypeError("runのGitHub sessionがありません");
    }
    return client;
  }

  /** 収集後のclient参照を破棄する。 */
  public release(runId: string): void {
    this.#clients.delete(runId);
  }
}

/** GitHub認証とinventory取得を一つのportへ接続する。 */
export function createGitHubRepositoryInventoryPort(
  dependencies: GitHubInventoryDependencies,
): RepositoryInventoryPort {
  return Object.freeze({
    async collect(prepared) {
      const client = await dependencies.createClient({
        organization: prepared.core.config.organization,
        credentials: dependencies.credentials,
        operations: prepared.core.config.operations,
      });
      const inventory = await dependencies.discoverInventory({
        organization: prepared.core.config.organization,
        observedAt: prepared.core.identity.startedAt,
        request: client.request,
      });
      const allowlist = createPublicRepositoryAllowlist(inventory);
      dependencies.sessions.register(prepared.core.identity.runId, client);
      return Object.freeze({
        approvedRepositories: allowlist.repositories,
        installationId: client.installationId,
        githubApiRemaining: client.getRateLimitSnapshot()?.remaining ?? 0,
        diagnostics: Object.freeze([]),
      });
    },
  });
}

/** 選定済み公開repository集合へ全GitHub読取を閉じる。 */
export function createGitHubReadPort(
  run: InventoryCollectedRun,
  sessions: GitHubRunSessions,
  dependencies: GitHubReadDependencies,
): GitHubReadPort<
  EnumeratedGitHubItem,
  GitHubItemDetail,
  FreshObservedGitHubItem,
  GitHubRateLimitSnapshot
> {
  const allowlist = PublicRepositoryAllowlist.fromApprovedRepositories(
    run.data.approvedRepositories,
  );
  const client = sessions.require(run.core.identity.runId);
  return Object.freeze({
    async enumerateOpen(repositories, observedAt) {
      const repositoryIds = new Set(repositories.map((repository) => repository.id));
      for (const repository of repositories) {
        allowlist.require(repository.id);
      }
      const items = await dependencies.enumerateOpen({
        allowlist,
        repositories,
        observedAt,
        request: client.request,
      });
      for (const item of items) {
        if (!repositoryIds.has(item.repositoryId)) {
          throw new TypeError("open列挙結果のrepositoryが要求した集合にありません");
        }
      }
      return items;
    },
    async enumerateByIdentifiers(identifiers, observedAt) {
      const items = await dependencies.enumerateByIdentifiers({
        allowlist,
        identifiers,
        observedAt,
        request: client.request,
        graphql: client.graphql,
      });
      for (const item of items) {
        allowlist.require(item.repositoryId);
      }
      return items;
    },
    async collectDetails(targets, observedAt, isBot) {
      for (const target of targets) {
        allowlist.require(target.item.repositoryId);
      }
      const details = (
        await dependencies.collectDetails({
          allowlist,
          targets,
          observedAt,
          graphql: client.graphql,
        })
      ).items;
      const targetsByNodeId = new Map(targets.map((target) => [target.item.nodeId, target.item]));
      for (const detail of details) {
        const target = targetsByNodeId.get(detail.nodeId);
        if (target?.repositoryId !== detail.repositoryId) {
          throw new TypeError("詳細取得結果が要求した項目と一致しません");
        }
      }
      return Object.freeze({
        details,
        observedItems: normalizeObservedGitHubItems({
          items: targets.map((target) => target.item),
          details,
          isBot,
        }),
      });
    },
    rateLimitSnapshot() {
      return client.getRateLimitSnapshot();
    },
  });
}

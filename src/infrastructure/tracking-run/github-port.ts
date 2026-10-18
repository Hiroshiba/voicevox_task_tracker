import type { CollectionGitHubReadPort } from "../../application/tracking-run/ports.js";
import type {
  InventoryCollectedRun,
  RepositoryInventoryPort,
} from "../../application/tracking-run/stages/inventory.js";
import type { Repository } from "../../domain/index.js";
import type { CreateGitHubClientOptions, GitHubClient } from "../../github/client.js";
import type { GitHubAppCredentials } from "../../github/credentials.js";
import type { collectGitHubItemDetails } from "../../github/item-detail-collection.js";
import { inspectLegacyReviewRequests } from "../../github/legacy-review-request.js";
import {
  type enumerateGitHubItemsByIdentifiers,
  type enumerateOpenGitHubItems,
} from "../../github/item-enumeration.js";
import { normalizeObservedGitHubItems } from "../../github/item-normalization.js";
import { findPrivateRepositoryReference } from "../../github/private-repository-reference.js";
import { createPublicRepositoryAllowlist } from "../../github/public-repository-allowlist.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import type { StateSnapshotReadResult } from "../../persistence/state-persistence-session.js";
import {
  collectRepositoryMetadata,
  type discoverRepositoryInventory,
} from "../../github/repository-inventory.js";

import { createPublicBoundaryDiagnosticError } from "./public-boundary-diagnostic.js";
import { assertSandboxFixedSourceBinding } from "./sandbox-fixed-source/descriptor.js";
import type { SandboxFixedSource } from "./sandbox-fixed-source/source.js";
import type { SandboxRunContext } from "./sandbox-context.js";

type GitHubInventoryDependencies = Readonly<{
  credentials: GitHubAppCredentials;
  createClient: (options: CreateGitHubClientOptions) => Promise<GitHubClient>;
  discoverInventory: typeof discoverRepositoryInventory;
  sessions: GitHubRunSessions;
  rawSnapshot: StateSnapshotReadResult;
  knownSecrets: readonly string[];
  fixedSource?: SandboxFixedSource;
  sandboxContext?: SandboxRunContext;
}>;

type GitHubReadDependencies = Readonly<{
  enumerateOpen: typeof enumerateOpenGitHubItems;
  enumerateByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  collectDetails: typeof collectGitHubItemDetails;
}>;

type PrivateRepositoryReference = Pick<Repository, "id" | "owner" | "name" | "visibility">;
type GitHubRunSession =
  | Readonly<{ kind: "live"; client: GitHubClient }>
  | Readonly<{ kind: "fixed"; source: SandboxFixedSource }>;
type GitHubInventorySource =
  | Readonly<{ kind: "live"; client: GitHubClient; inventory: readonly Repository[] }>
  | Readonly<{ kind: "fixed"; source: SandboxFixedSource; inventory: readonly Repository[] }>;

/** runごとのGitHub読取源と非公開repository参照をstage成果物の外で保持する。 */
export class GitHubRunSessions {
  readonly #sessions = new Map<string, GitHubRunSession>();
  readonly #privateRepositories = new Map<string, readonly PrivateRepositoryReference[]>();

  /** 認証済みclientと非公開repository参照をrunへ結び付ける。 */
  public register(runId: string, client: GitHubClient, inventory: readonly Repository[]): void {
    if (this.#privateRepositories.has(runId)) {
      throw new TypeError("同じrunのGitHub sessionが既にあります");
    }
    this.#sessions.set(runId, Object.freeze({ kind: "live", client }));
    this.#privateRepositories.set(
      runId,
      Object.freeze(
        inventory
          .filter((repository) => repository.visibility !== "public")
          .map((repository) =>
            Object.freeze({
              id: repository.id,
              owner: repository.owner,
              name: repository.name,
              visibility: repository.visibility,
            }),
          ),
      ),
    );
  }

  /** 合成sourceと公開repository inventoryをrunへ結び付ける。 */
  public registerFixed(
    runId: string,
    source: SandboxFixedSource,
    inventory: readonly Repository[],
  ): void {
    if (this.#privateRepositories.has(runId)) {
      throw new TypeError("同じrunのGitHub sessionが既にあります");
    }
    this.#sessions.set(runId, Object.freeze({ kind: "fixed", source }));
    this.#privateRepositories.set(
      runId,
      Object.freeze(
        inventory
          .filter((repository) => repository.visibility !== "public")
          .map((repository) =>
            Object.freeze({
              id: repository.id,
              owner: repository.owner,
              name: repository.name,
              visibility: repository.visibility,
            }),
          ),
      ),
    );
  }

  /** 収集段階でrunに固定したGitHub読取源を使う。 */
  public require(runId: string): GitHubRunSession {
    const session = this.#sessions.get(runId);
    if (session == null) {
      throw new TypeError("runのGitHub sessionがありません");
    }
    return session;
  }

  /** runの値が既知の非公開repositoryを参照しないことを確認する。 */
  public assertPublicBoundary(runId: string, values: readonly unknown[]): void {
    const privateRepositories = this.#privateRepositories.get(runId);
    if (privateRepositories == null) {
      throw new TypeError("runのGitHub sessionがありません");
    }
    const finding = findPrivateRepositoryReference(values, privateRepositories);
    if (finding != null) {
      throw createPublicBoundaryDiagnosticError(finding);
    }
  }

  /** 収集後にGitHub読取源への参照を破棄する。 */
  public releaseReadSource(runId: string): void {
    this.#sessions.delete(runId);
  }

  /** 検査完了後にrunの参照を破棄する。 */
  public release(runId: string): void {
    this.#sessions.delete(runId);
    this.#privateRepositories.delete(runId);
  }
}

function assertStoredPrivateRepositoryBoundary(
  inventory: Awaited<ReturnType<typeof discoverRepositoryInventory>>,
  prepared: Parameters<RepositoryInventoryPort["collect"]>[0],
  rawSnapshot: StateSnapshotReadResult,
): void {
  const storedValues: unknown[] = [
    rawSnapshot,
    prepared.core.baseState.history,
    prepared.core.baseState.aiCache,
    prepared.core.baseState.personalReminderAiCache,
    prepared.core.baseState.notificationLedger,
  ];
  const finding = findPrivateRepositoryReference(storedValues, inventory);
  if (finding != null) {
    throw createPublicBoundaryDiagnosticError(finding);
  }
}

/** GitHub認証とinventory取得を一つのportへ接続する。 */
export function createGitHubRepositoryInventoryPort(
  dependencies: GitHubInventoryDependencies,
): RepositoryInventoryPort {
  return Object.freeze({
    async collect(prepared) {
      const fixedSource = dependencies.fixedSource;
      let source: GitHubInventorySource;
      if (fixedSource != null) {
        assertSandboxFixedSourceBinding(
          fixedSource.descriptor,
          dependencies.sandboxContext,
          prepared,
        );
        source = Object.freeze({
          kind: "fixed",
          source: fixedSource,
          inventory: fixedSource.discoverInventory(
            prepared.core.config.organization,
            prepared.core.identity.startedAt,
          ),
        });
      } else {
        const client = await dependencies.createClient({
          organization: prepared.core.config.organization,
          credentials: dependencies.credentials,
          operations: prepared.core.config.operations,
        });
        source = Object.freeze({
          kind: "live",
          client,
          inventory: await dependencies.discoverInventory({
            organization: prepared.core.config.organization,
            observedAt: prepared.core.identity.startedAt,
            request: client.request,
          }),
        });
      }
      const inventory = source.inventory;
      const allowlist = createPublicRepositoryAllowlist(inventory);
      assertStoredPrivateRepositoryBoundary(inventory, prepared, dependencies.rawSnapshot);
      if (dependencies.rawSnapshot.status === "available") {
        assertStatePublicSafety({
          snapshot: dependencies.rawSnapshot.snapshot,
          repositoryInventory: inventory,
          repositoryAllowlist: allowlist.repositories,
          additionalValues: [],
          knownSecrets: dependencies.knownSecrets,
        });
      }
      if (source.kind === "live") {
        dependencies.sessions.register(prepared.core.identity.runId, source.client, inventory);
      } else {
        dependencies.sessions.registerFixed(prepared.core.identity.runId, source.source, inventory);
      }
      return Object.freeze({
        allowlist,
        installationId:
          source.kind === "live" ? source.client.installationId : source.source.installationId,
        githubApiRemaining:
          source.kind === "live"
            ? (source.client.getRateLimitSnapshot()?.remaining ?? 0)
            : source.source.rateLimitSnapshot().remaining,
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
): CollectionGitHubReadPort {
  const allowlist = run.data.allowlist;
  const session = sessions.require(run.core.identity.runId);
  if (session.kind === "fixed" && run.core.executionPolicy.effectTarget !== "sandbox") {
    throw new TypeError("固定sourceはsandbox実行だけに指定できます");
  }
  return Object.freeze({
    async enumerateOpen(repositories, observedAt) {
      const repositoryIds = new Set(repositories.map((repository) => repository.id));
      for (const repository of repositories) {
        allowlist.require(repository.id);
      }
      const items =
        session.kind === "fixed"
          ? session.source.enumerateOpen(allowlist, repositories, observedAt)
          : await dependencies.enumerateOpen({
              allowlist,
              repositories,
              observedAt,
              request: session.client.request,
            });
      for (const item of items) {
        if (!repositoryIds.has(item.repositoryId)) {
          throw new TypeError("open列挙結果のrepositoryが要求した集合にありません");
        }
      }
      return items;
    },
    async enumerateByIdentifiers(identifiers, observedAt) {
      const items =
        session.kind === "fixed"
          ? session.source.enumerateByIdentifiers(allowlist, identifiers, observedAt)
          : await dependencies.enumerateByIdentifiers({
              allowlist,
              identifiers,
              observedAt,
              request: session.client.request,
              graphql: session.client.graphql,
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
      const details =
        session.kind === "fixed"
          ? session.source.collectDetails(allowlist, targets, observedAt)
          : (
              await dependencies.collectDetails({
                allowlist,
                targets,
                observedAt,
                graphql: session.client.graphql,
                request: session.client.request,
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
    async collectRepositoryMetadata(repositoryFullNames, observedAt) {
      return session.kind === "fixed"
        ? session.source.collectRepositoryMetadata(allowlist, repositoryFullNames, observedAt)
        : collectRepositoryMetadata(repositoryFullNames, observedAt, session.client.request);
    },
    async inspectLegacyReviewRequests(sourceIds) {
      return session.kind === "fixed"
        ? session.source.inspectLegacyReviewRequests(sourceIds)
        : inspectLegacyReviewRequests(sourceIds, allowlist, session.client.graphql);
    },
    rateLimitSnapshot() {
      return session.kind === "fixed"
        ? session.source.rateLimitSnapshot()
        : session.client.getRateLimitSnapshot();
    },
  });
}

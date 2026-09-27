import type { RepositoryInventoryPort } from "../../application/tracking-run/stages/inventory.js";
import type { PreparedBaseStateShape } from "../../application/tracking-run/prepare-run.js";
import type { GitHubClient, CreateGitHubClientOptions } from "../../github/client.js";
import type { GitHubAppCredentials } from "../../github/credentials.js";
import { createPublicRepositoryAllowlist } from "../../github/public-repository-allowlist.js";
import type { discoverRepositoryInventory } from "../../github/repository-inventory.js";

type GitHubInventoryDependencies = Readonly<{
  credentials: GitHubAppCredentials;
  createClient: (options: CreateGitHubClientOptions) => Promise<GitHubClient>;
  discoverInventory: typeof discoverRepositoryInventory;
  sessions: GitHubRunSessions;
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
export function createGitHubRepositoryInventoryPort<BaseState extends PreparedBaseStateShape>(
  dependencies: GitHubInventoryDependencies,
): RepositoryInventoryPort<BaseState> {
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
        inventory,
        approvedRepositories: allowlist.repositories,
        installationId: client.installationId,
        githubApiRemaining: client.getRateLimitSnapshot()?.remaining ?? 0,
        diagnostics: Object.freeze([]),
      });
    },
  });
}

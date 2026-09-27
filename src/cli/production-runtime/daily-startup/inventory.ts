import { collectRepositoryInventory } from "../../../application/tracking-run/stages/inventory.js";
import {
  createGitHubRepositoryInventoryPort,
  type GitHubRunSessions,
} from "../../../infrastructure/tracking-run/github-port.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

/** GitHub portを用いてcanonical inventory stageを実行する。 */
export function createCollectInventoryStage(
  adapters: ProductionRuntimeAdapters,
  sessions: GitHubRunSessions,
): DailyTransactionDependencies<ProductionTypes>["collectInventory"] {
  return ({ prepared, configuration }) =>
    collectRepositoryInventory(
      prepared,
      createGitHubRepositoryInventoryPort({
        credentials: configuration.credentials.github,
        createClient: adapters.createGitHubClient,
        discoverInventory: adapters.discoverRepositoryInventory,
        sessions,
      }),
      nodeContentDigestPort,
    );
}

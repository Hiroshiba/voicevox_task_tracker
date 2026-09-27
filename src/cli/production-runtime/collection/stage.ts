import { collectRunItems } from "../../../application/tracking-run/stages/collection.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import {
  createGitHubReadPort,
  type GitHubRunSessions,
} from "../../../infrastructure/tracking-run/github-port.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { CollectionRuntimeAdapters } from "../adapters.js";
import { currentRuntimeTime } from "../clock.js";
import type { ProductionTypes } from "../contracts.js";

/** 増分収集段階を既存adapterへ接続する。 */
export function createCollectItemsStage(
  adapters: CollectionRuntimeAdapters,
  sessions: GitHubRunSessions,
): DailyTransactionDependencies<ProductionTypes>["collectIncrementalItems"] {
  return async ({ invocation, inventoryCollected }) => {
    try {
      const read = createGitHubReadPort(inventoryCollected, sessions, {
        enumerateOpen: adapters.enumerateOpenGitHubItems,
        enumerateByIdentifiers: adapters.enumerateGitHubItemsByIdentifiers,
        collectDetails: adapters.collectGitHubItemDetails,
      });
      return await collectRunItems(
        inventoryCollected,
        { read, delay: { sleep: adapters.sleep } },
        { now: () => currentRuntimeTime(adapters) },
        nodeContentDigestPort,
      );
    } finally {
      sessions.release(invocation.runId);
    }
  };
}

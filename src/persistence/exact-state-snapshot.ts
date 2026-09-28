import {
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchHead,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";
import { readAiCacheMigrationPlan } from "./state-ai-cache-migration-plan.js";
import { decodeStateFile } from "./state-file-codec.js";
import { migrateStateSnapshot } from "./snapshot-v21-migration.js";
import { parseStateNotificationLedger } from "./state-documents.js";
import type { StateSnapshotReadResult } from "./state-persistence-session.js";

/** 指定したGit revisionのsnapshotと移行依存をそのtreeだけから読む。 */
export async function readExactStateSnapshot(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  timezone: string,
  revision: StateBranchHead,
): Promise<StateSnapshotReadResult> {
  validateStatePersistenceConfiguration(configuration);
  if (revision.status === "missing") {
    return Object.freeze({ status: "missing_branch" });
  }
  const migration = await readAiCacheMigrationPlan(adapter, configuration, revision);
  const source = decodeStateFile(
    await adapter.readFile(revision.revision, configuration.snapshotPath),
    "snapshot",
  );
  if (source == null) {
    const ledgerSource = decodeStateFile(
      await adapter.readFile(revision.revision, configuration.notificationLedgerPath),
      "notification ledger",
    );
    if (ledgerSource == null) {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("既存state branchにnotification ledgerがありません"),
      });
    }
    const ledger = parseStateNotificationLedger(ledgerSource);
    const paths = await adapter.listFiles(revision.revision, "state");
    if (
      ledger.entries.length === 0 &&
      ledger.operationsAlerts.length > 0 &&
      paths.length === 1 &&
      paths[0] === configuration.notificationLedgerPath
    ) {
      return Object.freeze({ status: "operations_only" });
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("既存state branchにsnapshotがありません"),
    });
  }
  return Object.freeze({
    status: "available",
    snapshot: migrateStateSnapshot(source, migration.legacyEntriesByCacheKey, timezone),
  });
}

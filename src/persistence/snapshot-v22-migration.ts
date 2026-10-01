import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../domain/personal-reminder-causes.js";
import { parseSourceId } from "../domain/source-id.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateStateSnapshot as migrateVersion21Snapshot } from "./snapshot-v21-migration.js";
import { createStateSnapshot, parseStateSnapshot, type StateSnapshot } from "./snapshot-v22.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });
const clockEventSourceKinds = new Set([
  "github_issue_comment",
  "github_pull_request_review_comment",
  "github_pull_request_review",
  "github_timeline_event",
  "github_review_request",
]);

function legacyBasisForReconfirmation(basis: PersonalReminderTimeBasis): PersonalReminderTimeBasis {
  if (
    basis.source !== "event" ||
    basis.sourceIds.every((sourceId) => clockEventSourceKinds.has(parseSourceId(sourceId).kind))
  ) {
    return basis;
  }
  return Object.freeze({
    source: "reconfirmation_pending",
    at: basis.at,
    sourceIds: basis.sourceIds,
  });
}

function legacyCauseForReconfirmation(cause: PersonalReminderCause): PersonalReminderCause {
  return Object.freeze({
    ...cause,
    obligationSince: legacyBasisForReconfirmation(cause.obligationSince),
    actionableClock:
      cause.actionableClock.status === "not_observed"
        ? cause.actionableClock
        : Object.freeze({
            ...cause.actionableClock,
            actionableSince: legacyBasisForReconfirmation(cause.actionableClock.actionableSince),
            stallSince: legacyBasisForReconfirmation(cause.actionableClock.stallSince),
          }),
  });
}

/** 旧世代snapshotの時計出典を再確認対象へ移す。 */
export function migrateStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  timezone: string,
): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  const version = snapshotVersionSchema.safeParse(value);
  if (!version.success) {
    throw StateFormatError.fromZodError("snapshot", version.error);
  }
  if (version.data.schemaVersion === "22") return parseStateSnapshot(source);
  const previous = migrateVersion21Snapshot(source, legacyEntriesByCacheKey, timezone);
  return createStateSnapshot({
    ...previous,
    schemaVersion: "22",
    items: previous.items.map((item) => ({
      ...item,
      personalReminderCauses: item.personalReminderCauses.map(legacyCauseForReconfirmation),
    })),
  });
}

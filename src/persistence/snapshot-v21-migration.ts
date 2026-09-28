import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import { AI_ANALYSIS_ELEMENTS } from "../domain/ai-analysis-elements.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateStateSnapshot as migrateVersion20Snapshot } from "./snapshot-v20-migration.js";
import type { StateSnapshot as StateSnapshotVersion20 } from "./snapshot-v20.js";
import { createStateSnapshot, parseStateSnapshot, type StateSnapshot } from "./snapshot-v21.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });

function currentAiAnalysis(
  analysis: StateSnapshotVersion20["items"][number]["aiAnalysis"],
): unknown {
  const current: Record<string, unknown> = {};
  const retained: Record<string, unknown> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = analysis.adoptedElements[element];
    if (adopted == null) {
      continue;
    }
    if (analysis.applications[element].status === "current_ai") {
      current[element] = adopted;
    } else {
      retained[element] = adopted;
    }
  }
  return {
    ...analysis,
    adoptedElements: current,
    retainedElements: retained,
  };
}

/** 旧世代snapshotのAI採用値を現在値と履歴へ分離する。 */
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
  if (version.data.schemaVersion === "21") {
    return parseStateSnapshot(source);
  }
  const previous = migrateVersion20Snapshot(source, legacyEntriesByCacheKey, timezone);
  return createStateSnapshot({
    ...previous,
    schemaVersion: "21",
    items: previous.items.map((item) => ({
      ...item,
      aiAnalysis: currentAiAnalysis(item.aiAnalysis),
    })),
    collection: {
      repositories: previous.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => ({
          ...item,
          aiAnalysis: currentAiAnalysis(item.aiAnalysis),
        })),
      })),
    },
  });
}

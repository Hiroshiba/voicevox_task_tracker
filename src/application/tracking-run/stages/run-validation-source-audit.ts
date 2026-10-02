import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { parseSourceId } from "../../../domain/source-id.js";
import type { OwnedHistoricalEvidence } from "../contracts/evidence-closure.js";
import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
} from "./run-validation-artifact-witness.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type SourcePath = Readonly<{ sourceId: string; path: readonly (string | number)[] }>;

function collectEvidenceSourceIds(value: unknown, sourceIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectEvidenceSourceIds(entry, sourceIds);
    return;
  }
  if (typeof value !== "object" || value == null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "evidence" && Array.isArray(entry)) {
      const records: readonly unknown[] = entry;
      for (const evidence of records) {
        if (typeof evidence === "object" && evidence != null && "sourceId" in evidence) {
          const sourceId = evidence.sourceId;
          if (typeof sourceId === "string") sourceIds.add(sourceId);
        }
      }
    }
    collectEvidenceSourceIds(entry, sourceIds);
  }
}

/** 失効した旧review request時計だけを前回pendingの監査参照へ移す。 */
export function retiredPreviousPendingClockPaths(
  values: MaterializedReferenceValues,
  historicalEvidence: readonly OwnedHistoricalEvidence[],
): ReadonlySet<string> {
  const currentByKey = new Map(
    values.notificationLedger.pendingNotifications.map((pending) => [
      pending.notificationKey,
      pending,
    ]),
  );
  const candidates: SourcePath[] = [];
  for (const [index, pending] of values.previousNotificationLedger.pendingNotifications.entries()) {
    if (
      pending.target.kind !== "personal_reminder" ||
      pending.reason.reasonCode !== "review_overdue"
    ) {
      continue;
    }
    const current = currentByKey.get(pending.notificationKey);
    if (
      current != null &&
      serializeCanonicalJson(current.target) === serializeCanonicalJson(pending.target)
    ) {
      continue;
    }
    for (const clock of ["actionableSince", "stallSince"] as const) {
      const basis = pending.target[clock];
      if (basis.source !== "event") continue;
      for (const [sourceIndex, sourceId] of basis.sourceIds.entries()) {
        if (parseSourceId(sourceId).kind === "github_review_request") {
          candidates.push({
            sourceId,
            path: [
              "previousNotificationLedger",
              "pendingNotifications",
              index,
              "target",
              clock,
              "sourceIds",
              sourceIndex,
            ],
          });
        }
      }
    }
  }
  if (candidates.length === 0) return new Set();
  const evidenceSourceIds = new Set<string>(
    historicalEvidence.map((record) => record.record.evidence.sourceId),
  );
  collectEvidenceSourceIds(values.snapshot, evidenceSourceIds);
  return new Set(
    candidates
      .filter((candidate) => !evidenceSourceIds.has(candidate.sourceId))
      .map((candidate) => serializeCanonicalJson(candidate.path)),
  );
}

function walkSourcePaths(
  value: unknown,
  path: readonly (string | number)[],
  paths: SourcePath[],
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) walkSourcePaths(entry, [...path, index], paths);
    return;
  }
  if (typeof value !== "object" || value == null) return;
  for (const [key, entry] of Object.entries(value)) {
    const fieldPath = [...path, key];
    if (key === "sourceId" || key === "latestMeaningfulSourceId") {
      if (key === "latestMeaningfulSourceId" && entry == null) continue;
      if (typeof entry !== "string") {
        throw new RunCompletenessError("invalid_reference", key, fieldPath, undefined);
      }
      paths.push({ sourceId: entry, path: fieldPath });
    } else if (key === "sourceIds" || key === "evidenceSourceIds") {
      if (!Array.isArray(entry)) {
        throw new RunCompletenessError("invalid_reference", key, fieldPath, undefined);
      }
      const auditOnly =
        key === "sourceIds" && "source" in value && value.source === "reconfirmed_observation";
      for (const [index, sourceId] of entry.entries()) {
        if (typeof sourceId !== "string") {
          throw new RunCompletenessError(
            "invalid_reference",
            key,
            [...fieldPath, index],
            undefined,
          );
        }
        if (!auditOnly) paths.push({ sourceId, path: [...fieldPath, index] });
      }
    } else if (/sourceids?$/iu.test(key)) {
      throw new RunCompletenessError("invalid_reference", key, fieldPath, undefined);
    } else {
      walkSourcePaths(entry, fieldPath, paths);
    }
  }
}

/** 公開値のsource名を走査し、型付き目録に未収録の参照を拒否する。 */
export function assertSourceReferenceCoverage(
  values: MaterializedReferenceValues,
  references: readonly MaterializedEvidenceReference[],
  retiredPaths: ReadonlySet<string>,
): void {
  const found: SourcePath[] = [];
  walkSourcePaths(
    {
      snapshot: values.snapshot,
      historyInputEvents: values.historyInputEvents,
      aiCacheAdditions: values.aiCacheAdditions,
      personalReminderAiCacheAdditions: values.personalReminderAiCacheAdditions,
      previousNotificationLedger: values.previousNotificationLedger,
      notificationLedger: values.notificationLedger,
      notificationSelection: values.notificationSelection,
    },
    [],
    found,
  );
  const sort = (entries: readonly SourcePath[]): readonly string[] =>
    entries.map(serializeCanonicalJson).sort();
  const catalogPaths = references.map(({ sourceId, path }) => ({ sourceId, path }));
  const active = found.filter((entry) => !retiredPaths.has(serializeCanonicalJson(entry.path)));
  if (serializeCanonicalJson(sort(active)) !== serializeCanonicalJson(sort(catalogPaths))) {
    const indexed = new Set(
      references.map((reference) =>
        serializeCanonicalJson({ sourceId: reference.sourceId, path: reference.path }),
      ),
    );
    const missing = active.find((entry) => !indexed.has(serializeCanonicalJson(entry)));
    throw new RunCompletenessError(
      "invalid_reference",
      missing?.sourceId ?? "source_reference",
      missing?.path ?? ["materializedReferences"],
      undefined,
    );
  }
}

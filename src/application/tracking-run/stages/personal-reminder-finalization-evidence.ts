import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseId,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence } from "../../../domain/types.js";
import { indexPersonalReminderEvidence } from "./personal-reminder-evidence-index.js";

function evidenceIdentity(evidence: Evidence): string {
  return serializeCanonicalJson(evidence);
}

function sourceIdsForCause(cause: PersonalReminderCause): readonly SourceId[] {
  const sourceIds = new Set(cause.evidenceSourceIds);
  if (cause.adoptedAssessment.status === "available") {
    for (const id of cause.adoptedAssessment.result.references.sourceIds) sourceIds.add(id);
  }
  if (cause.obligationSince.source === "event") {
    for (const id of cause.obligationSince.sourceIds) sourceIds.add(id);
  }
  if (cause.actionableClock.status === "observed") {
    for (const basis of [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]) {
      if (basis.source === "event") for (const id of basis.sourceIds) sourceIds.add(id);
    }
  }
  return Object.freeze([...sourceIds].sort());
}

/** 原因が参照する検証済み根拠recordを所有項目へ保持する。 */
export function finalizePersonalReminderEvidence(
  itemNodeId: string,
  causes: readonly PersonalReminderCause[],
  localEvidence: readonly Evidence[],
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  currentCauseIds: ReadonlySet<PersonalReminderCauseId>,
): readonly Evidence[] {
  const records = new Map(localEvidence.map((evidence) => [evidenceIdentity(evidence), evidence]));
  for (const cause of causes) {
    for (const sourceId of sourceIdsForCause(cause)) {
      const previous = previousEvidenceBySourceId.get(sourceId) ?? [];
      const current = currentCauseIds.has(cause.causeId)
        ? (currentEvidenceBySourceId.get(sourceId) ?? [])
        : [];
      if (
        previous.length === 0 &&
        current.length === 0 &&
        !localEvidence.some((evidence) => evidence.sourceId === sourceId)
      ) {
        throw new TypeError(
          `個人催促原因のsource recordがありません。item: ${itemNodeId} cause: ${cause.causeId} source: ${sourceId}`,
        );
      }
      for (const evidence of [...previous, ...current]) {
        records.set(evidenceIdentity(evidence), evidence);
      }
    }
  }
  return Object.freeze(
    [...records.values()].sort((left, right) =>
      evidenceIdentity(left).localeCompare(evidenceIdentity(right)),
    ),
  );
}

/** 現在と前回のsource record索引をそれぞれ作る。 */
export function personalReminderEvidenceIndexes(
  currentGroups: readonly (readonly Evidence[])[],
  previousGroups: readonly (readonly Evidence[])[],
): Readonly<{
  current: ReadonlyMap<SourceId, readonly Evidence[]>;
  previous: ReadonlyMap<SourceId, readonly Evidence[]>;
}> {
  return Object.freeze({
    current: indexPersonalReminderEvidence(currentGroups),
    previous: indexPersonalReminderEvidence(previousGroups),
  });
}

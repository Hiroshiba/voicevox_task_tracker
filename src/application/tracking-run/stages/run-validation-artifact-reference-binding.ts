import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { EvidenceUse, ResolvedEvidenceUse } from "../contracts/evidence-closure.js";
import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
} from "./run-validation-artifact-witness.js";
import { RunCompletenessError } from "./run-completeness-error.js";

function samePath(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value != null;
}

function materializedUse(use: EvidenceUse): boolean {
  const path = use.path;
  if (path[0] === "items") {
    if (path[2] === "causeResults") return path[4] === "cause";
    return path[2] === "item" || path[2] === "evidence";
  }
  if (path[0] === "relations") return path[2] === "evidence";
  return (
    path[0] === "historyInputEvents" ||
    path[0] === "aiCacheAdditions" ||
    path[0] === "personalReminderAiCacheAdditions" ||
    path[0] === "pendingNotifications" ||
    path[0] === "previousNotificationLedger"
  );
}

function unmaterializedUse(use: EvidenceUse): boolean {
  const path = use.path;
  if (path[0] === "aiItems" || path[0] === "notificationCauses") return true;
  if (path[0] === "items") {
    return path[2] === "causeResults" && path[4] === "staleness";
  }
  return path[0] === "relations" && path[2] === "contradictions";
}

function matchingPath(use: EvidenceUse, reference: MaterializedEvidenceReference): boolean {
  const path = use.path;
  const saved = reference.path;
  if (saved[0] === "snapshot" && saved[1] === "items") {
    if (path[0] !== "items") return false;
    const suffix = saved.slice(3);
    if (suffix[0] === "evidence") {
      return (
        (path[2] === "item" && path[3] === "evidence" && path[5] === "sourceId") ||
        (path[2] === "evidence" && path[4] === "sourceId")
      );
    }
    if (suffix[0] === "personalReminderCauses") {
      const causeIndex = suffix[1];
      return (
        typeof causeIndex === "number" &&
        samePath(path.slice(2), ["causeResults", causeIndex, "cause", ...suffix.slice(2)])
      );
    }
    return samePath(path.slice(2), ["item", ...suffix]);
  }
  if (saved[0] === "snapshot" && saved[1] === "relations") {
    return path[0] === "relations" && samePath(path.slice(2), saved.slice(3));
  }
  if (saved[0] === "notificationLedger" || saved[0] === "notificationSelection") {
    return (
      path[0] === "pendingNotifications" &&
      saved[1] === "pendingNotifications" &&
      samePath(path.slice(2), saved.slice(3))
    );
  }
  if (
    saved[0] === "historyInputEvents" ||
    saved[0] === "aiCacheAdditions" ||
    saved[0] === "personalReminderAiCacheAdditions"
  ) {
    return path[0] === saved[0] && samePath(path.slice(2), saved.slice(2));
  }
  return samePath(path, saved);
}

function aiPurpose(path: readonly (string | number)[], element: string): string | undefined {
  if (path.includes("evidence")) return `ai_${element}_evidence`;
  if (element === "waitingOn" && path.includes("sourceIds")) return "ai_waiting_on_candidate";
  if (element === "relations" && path.includes("sourceIds")) return "ai_relation_candidate";
  if (element === "progress" && path.includes("latestMeaningfulSourceId")) return "ai_progress";
  if (element === "selfCommitment" && path.includes("sourceId")) return "ai_self_commitment";
  return undefined;
}

function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[String(part)];
  }
  return current;
}

function evidencePurpose(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): string {
  const evidence = valueAtPath(values, reference.path.slice(0, -1));
  if (!isRecord(evidence)) {
    throw new RunCompletenessError("missing_value", reference.sourceId, reference.path, undefined);
  }
  const supports = evidence["supports"];
  if (typeof supports !== "string") {
    throw new RunCompletenessError(
      "invalid_reference",
      reference.sourceId,
      reference.path,
      undefined,
    );
  }
  return `evidence_${supports}`;
}

function referencePurpose(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): Readonly<{ purpose: string; currentness: EvidenceUse["requiredCurrentness"] }> {
  const path = reference.path;
  if (path[0] === "previousNotificationLedger") {
    return { purpose: "previous_notification_pending", currentness: "historical_allowed" };
  }
  if (path[0] === "snapshot" && path[1] === "items") {
    if (path[3] === "evidence") {
      return { purpose: evidencePurpose(reference, values), currentness: "historical_allowed" };
    }
    if (path[3] === "waitingOn") {
      return { purpose: "waiting_on", currentness: "historical_allowed" };
    }
    if (path[3] === "inputEvents") {
      return { purpose: "item_input_event", currentness: "historical_allowed" };
    }
    if (path[3] === "aiAnalysis") {
      const element = path[5];
      const purpose = typeof element === "string" ? aiPurpose(path.slice(6), element) : undefined;
      if (purpose != null) return { purpose, currentness: "historical_allowed" };
    }
    if (path[3] === "personalReminderCauses") {
      if (path[5] === "evidenceSourceIds") {
        return { purpose: "personal_reminder_cause", currentness: "historical_allowed" };
      }
      if (path[5] === "adoptedAssessment") {
        return { purpose: "personal_reminder_assessment", currentness: "historical_allowed" };
      }
      if (path.includes("sourceIds")) {
        return { purpose: "personal_reminder_event_basis", currentness: "historical_allowed" };
      }
    }
  }
  if (path[0] === "snapshot" && path[1] === "relations" && path[3] === "evidence") {
    return { purpose: evidencePurpose(reference, values), currentness: "historical_allowed" };
  }
  if (path[0] === "historyInputEvents") {
    const event = valueAtPath(values, path.slice(0, 2));
    if (!isRecord(event)) {
      throw new RunCompletenessError("missing_value", reference.sourceId, path, undefined);
    }
    const kind = event["kind"];
    if (typeof kind !== "string") {
      throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
    }
    return { purpose: `history_${kind}`, currentness: "current" };
  }
  if (path[0] === "aiCacheAdditions") {
    const entry = valueAtPath(values, path.slice(0, 2));
    const element = isRecord(entry) ? entry["element"] : undefined;
    const purpose = typeof element === "string" ? aiPurpose(path.slice(3), element) : undefined;
    if (purpose != null) return { purpose, currentness: "current" };
  }
  if (path[0] === "personalReminderAiCacheAdditions") {
    return { purpose: "personal_reminder_cache", currentness: "current" };
  }
  if (
    (path[0] === "notificationLedger" || path[0] === "notificationSelection") &&
    path[1] === "pendingNotifications"
  ) {
    return { purpose: "personal_reminder_event_basis", currentness: "historical_allowed" };
  }
  throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
}

function matchesUse(
  resolved: ResolvedEvidenceUse,
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): boolean {
  const use = resolved.use;
  if (use.sourceId !== reference.sourceId || !matchingPath(use, reference)) return false;
  if (reference.owner.kind === "item") {
    if (
      use.destination.kind !== "item" ||
      use.destination.itemNodeId !== reference.owner.id ||
      !use.allowedOwnerNodeIds.includes(reference.owner.id)
    )
      return false;
  } else if (
    use.destination.kind !== "relation" ||
    use.destination.relationId !== reference.owner.id ||
    !use.allowedRelationIds.includes(reference.owner.id)
  ) {
    return false;
  }
  const expected = referencePurpose(reference, values);
  return use.purpose === expected.purpose && use.requiredCurrentness === expected.currentness;
}

/** 保存参照と閉包useをパス、所有先、用途、現在性で双方向に照合する。 */
export function assertMaterializedReferenceBindings(
  references: readonly MaterializedEvidenceReference[],
  resolvedUses: readonly ResolvedEvidenceUse[],
  values: MaterializedReferenceValues,
): void {
  for (const reference of references) {
    if (!resolvedUses.some((resolved) => matchesUse(resolved, reference, values))) {
      throw new RunCompletenessError(
        "invalid_reference",
        reference.sourceId,
        reference.path,
        undefined,
      );
    }
  }
  for (const resolved of resolvedUses) {
    if (!materializedUse(resolved.use)) {
      if (!unmaterializedUse(resolved.use)) {
        throw new RunCompletenessError(
          "invalid_reference",
          resolved.use.sourceId,
          resolved.use.path,
          resolved.use,
        );
      }
      continue;
    }
    if (!references.some((reference) => matchesUse(resolved, reference, values))) {
      throw new RunCompletenessError(
        "missing_value",
        resolved.use.sourceId,
        resolved.use.path,
        resolved.use,
      );
    }
  }
}

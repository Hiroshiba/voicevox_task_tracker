import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PendingPersonalReminderTarget,
  TrackedItemAiAnalysis,
} from "../../../domain/types.js";
import type { UtcIsoDateTime } from "../../../domain/index.js";
import { buildSourceId, parseSourceId, type SourceId } from "../../../domain/source-id.js";
import { isProductionSourceIdKind } from "../../../github/production-source-id.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import type {
  EvidenceClosureResult,
  OwnedHistoricalEvidence,
  ResolvedEvidenceUse,
} from "../contracts/evidence-closure.js";
import type { ContentDigestPort } from "../ports.js";
import { EvidenceCatalog } from "./evidence-catalog.js";
import { resolveEvidenceUse } from "./evidence-closure-resolve.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertMaterializedReferenceBindings } from "./run-validation-artifact-reference-binding.js";
import { assertRunValueMatches } from "./run-validation-compare.js";
import {
  assertCacheOwnerWitness,
  createCacheOwnerWitness,
  type CacheOwnerWitness,
  type RunAiCacheAddition,
  type RunPersonalCacheAddition,
} from "./run-validation-cache-witness.js";
import type { EvidenceClosureAdditions } from "./evidence-closure.js";
import type {
  RunNotificationSelection,
  RunValidationLedger,
} from "./run-validation-final-checks.js";

/** 分割workflowでsourceと所有範囲を再照合する公開可能な記録。 */
export type EvidenceClosureWitness = Readonly<{
  currentSources: readonly CurrentSourceFact[];
  historicalEvidence: readonly OwnedHistoricalEvidence[];
  resolvedUses: readonly ResolvedEvidenceUse[];
  materializedReferences: readonly MaterializedEvidenceReference[];
  cacheOwners: CacheOwnerWitness;
}>;

type ReferenceOwner =
  Readonly<{ kind: "item"; id: string }> | Readonly<{ kind: "relation"; id: string }>;

export type MaterializedEvidenceReference = Readonly<{
  sourceId: string;
  path: readonly (string | number)[];
  owner: ReferenceOwner;
}>;

export type MaterializedReferenceValues = Readonly<{
  snapshot: Readonly<{
    items: readonly Readonly<{
      nodeId: string;
      aiAnalysis: TrackedItemAiAnalysis;
      personalReminderCauses: readonly Readonly<{ causeId: string }>[];
    }>[];
    relations: readonly Readonly<{ id: string }>[];
  }>;
  historyInputEvents: readonly Readonly<{ itemNodeId: string }>[];
  aiCacheAdditions: readonly RunAiCacheAddition[];
  personalReminderAiCacheAdditions: readonly RunPersonalCacheAddition[];
  previousNotificationLedger: RunValidationLedger;
  notificationLedger: RunValidationLedger;
  notificationSelection: RunNotificationSelection;
}>;

function canonicalSort<Value>(values: readonly Value[]): readonly Value[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      const first = serializeCanonicalJson(left);
      const second = serializeCanonicalJson(right);
      return first < second ? -1 : first > second ? 1 : 0;
    }),
  );
}

/** 完全性検証済み閉包から利用されたsourceの事実だけを取り出す。 */
export function createEvidenceClosureWitness(
  closure: EvidenceClosureResult,
  historicalEvidence: readonly OwnedHistoricalEvidence[],
  evaluatedAt: UtcIsoDateTime,
  approvedRepositories: readonly PublicRepository[],
  values: MaterializedReferenceValues,
  outward: Pick<EvidenceClosureAdditions, "aiCacheAdditions" | "personalReminderAiCacheAdditions">,
  digest: ContentDigestPort,
): EvidenceClosureWitness {
  const usedIds = new Set(closure.uses.map((use) => use.sourceId));
  const currentSources = canonicalSort(
    closure.catalog.currentSources.filter((fact) => usedIds.has(fact.sourceId)),
  );
  const fullContext = Object.freeze({
    evaluatedAt,
    approvedRepositories,
    historicalEvidence,
  });
  const currentById = indexedValues(currentSources);
  const fullHistoricalById = indexedHistorical(historicalEvidence);
  const selectedHistorical = new Map<string, OwnedHistoricalEvidence>();
  for (const resolved of closure.resolvedUses) {
    if (resolved.resolution !== "historical") continue;
    const actual = resolveEvidenceUse(resolved.use, currentById, fullHistoricalById, fullContext);
    assertRunValueMatches(actual.resolved, resolved, resolved.use.path, resolved.use.sourceId);
    for (const value of actual.historical) {
      selectedHistorical.set(serializeCanonicalJson(value), value);
    }
  }
  const usedHistoricalEvidence = canonicalSort([...selectedHistorical.values()]);
  const historicalById = indexedHistorical(usedHistoricalEvidence);
  const context = Object.freeze({
    evaluatedAt,
    approvedRepositories,
    historicalEvidence: usedHistoricalEvidence,
  });
  const cacheOwners = createCacheOwnerWitness(outward, values, digest);
  const materializedReferences = collectMaterializedReferences(values, cacheOwners);
  const resolvedUses = canonicalSort([
    ...closure.resolvedUses.map((resolved) => {
      const canonical = resolveEvidenceUse(resolved.use, currentById, historicalById, context);
      assertRunValueMatches(canonical.resolved, resolved, resolved.use.path, resolved.use.sourceId);
      return canonical.resolved;
    }),
    ...historicalLedgerUses(materializedReferences, values, evaluatedAt),
  ]);
  assertMaterializedReferenceBindings(materializedReferences, resolvedUses, values);
  return Object.freeze({
    currentSources,
    historicalEvidence: usedHistoricalEvidence,
    resolvedUses,
    materializedReferences,
    cacheOwners,
  });
}

function canonicalSourceId(value: string): SourceId {
  const source = parseSourceId(value);
  return buildSourceId(source.kind, source.originalId);
}

function walkReferences(
  value: unknown,
  path: readonly (string | number)[],
  owner: ReferenceOwner,
  references: MaterializedEvidenceReference[],
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      walkReferences(entry, [...path, index], owner, references);
    }
    return;
  }
  if (typeof value !== "object" || value == null) return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "sourceId" || key === "latestMeaningfulSourceId") && typeof entry === "string") {
      references.push(
        Object.freeze({ sourceId: canonicalSourceId(entry), path: [...path, key], owner }),
      );
    } else if ((key === "sourceIds" || key === "evidenceSourceIds") && Array.isArray(entry)) {
      for (const [index, sourceId] of entry.entries()) {
        if (typeof sourceId !== "string") {
          throw new RunCompletenessError(
            "invalid_reference",
            "sourceIds",
            [...path, key, index],
            undefined,
          );
        }
        references.push(
          Object.freeze({
            sourceId: canonicalSourceId(sourceId),
            path: [...path, key, index],
            owner,
          }),
        );
      }
    } else {
      walkReferences(entry, [...path, key], owner, references);
    }
  }
}

/** 保存値と通知値に実在するsource参照を所有位置付きで列挙する。 */
export function collectMaterializedReferences(
  values: MaterializedReferenceValues,
  cacheOwners: CacheOwnerWitness,
): readonly MaterializedEvidenceReference[] {
  const references: MaterializedEvidenceReference[] = [];
  for (const [index, item] of values.snapshot.items.entries()) {
    walkReferences(
      item,
      ["snapshot", "items", index],
      Object.freeze({ kind: "item", id: item.nodeId }),
      references,
    );
  }
  for (const [index, relation] of values.snapshot.relations.entries()) {
    walkReferences(
      relation,
      ["snapshot", "relations", index],
      Object.freeze({ kind: "relation", id: relation.id }),
      references,
    );
  }
  for (const [index, event] of values.historyInputEvents.entries()) {
    walkReferences(
      event,
      ["historyInputEvents", index],
      Object.freeze({ kind: "item", id: event.itemNodeId }),
      references,
    );
  }
  for (const [index, entry] of values.aiCacheAdditions.entries()) {
    const owner = cacheOwners.generic[index];
    if (owner == null) {
      throw new RunCompletenessError(
        "missing_value",
        entry.cacheKey,
        ["cacheOwners", "generic", index],
        undefined,
      );
    }
    walkReferences(
      entry.generation.result,
      ["aiCacheAdditions", index, "result"],
      Object.freeze({ kind: "item", id: owner.itemNodeId }),
      references,
    );
  }
  for (const [index, entry] of values.personalReminderAiCacheAdditions.entries()) {
    const owner = cacheOwners.personalReminder[index];
    if (owner == null) {
      throw new RunCompletenessError(
        "missing_value",
        entry.cacheKey,
        ["cacheOwners", "personalReminder", index],
        undefined,
      );
    }
    walkReferences(
      entry.generation.result,
      ["personalReminderAiCacheAdditions", index, "result"],
      Object.freeze({ kind: "item", id: owner.itemNodeId }),
      references,
    );
  }
  for (const [index, pending] of values.previousNotificationLedger.pendingNotifications.entries()) {
    walkReferences(
      pending,
      ["previousNotificationLedger", "pendingNotifications", index],
      Object.freeze({ kind: "item", id: pending.itemNodeId }),
      references,
    );
  }
  for (const [index, pending] of values.notificationLedger.pendingNotifications.entries()) {
    walkReferences(
      pending,
      ["notificationLedger", "pendingNotifications", index],
      Object.freeze({ kind: "item", id: pending.itemNodeId }),
      references,
    );
  }
  for (const [index, candidate] of values.notificationSelection.candidates.entries()) {
    walkReferences(
      candidate,
      ["notificationSelection", "candidates", index],
      Object.freeze({ kind: "item", id: candidate.itemNodeId }),
      references,
    );
  }
  for (const [index, pending] of values.notificationSelection.pendingNotifications.entries()) {
    walkReferences(
      pending,
      ["notificationSelection", "pendingNotifications", index],
      Object.freeze({ kind: "item", id: pending.itemNodeId }),
      references,
    );
  }
  return canonicalSort(references);
}

function indexedValues<Value extends Readonly<{ sourceId: string }>>(
  values: readonly Value[],
): ReadonlyMap<string, readonly Value[]> {
  const groups = new Map<string, Value[]>();
  for (const value of values) {
    const entries = groups.get(value.sourceId) ?? [];
    entries.push(value);
    groups.set(value.sourceId, entries);
  }
  return groups;
}

function indexedHistorical(
  values: readonly OwnedHistoricalEvidence[],
): ReadonlyMap<string, readonly OwnedHistoricalEvidence[]> {
  const groups = new Map<string, OwnedHistoricalEvidence[]>();
  for (const value of values) {
    const sourceId = value.record.evidence.sourceId;
    const entries = groups.get(sourceId) ?? [];
    entries.push(value);
    groups.set(sourceId, entries);
  }
  return groups;
}

function historicalLedgerUses(
  references: readonly MaterializedEvidenceReference[],
  values: MaterializedReferenceValues,
  evaluatedAt: UtcIsoDateTime,
): readonly ResolvedEvidenceUse[] {
  const uses: ResolvedEvidenceUse[] = [];
  const evaluatedTime = Date.parse(evaluatedAt);
  for (const reference of references) {
    if (reference.path[0] !== "previousNotificationLedger") continue;
    const pendingIndex = reference.path[2];
    const pending =
      typeof pendingIndex === "number"
        ? values.previousNotificationLedger.pendingNotifications[pendingIndex]
        : undefined;
    const basisName = reference.path[4];
    let basis: PendingPersonalReminderTarget["actionableSince"] | undefined;
    if (pending?.target.kind === "personal_reminder") {
      if (basisName === "actionableSince") basis = pending.target.actionableSince;
      if (basisName === "stallSince") basis = pending.target.stallSince;
    }
    const sourceIndex = reference.path[6];
    if (
      pending == null ||
      reference.path[1] !== "pendingNotifications" ||
      reference.path.length !== 7 ||
      reference.path[3] !== "target" ||
      reference.path[5] !== "sourceIds" ||
      basis?.source !== "event" ||
      typeof sourceIndex !== "number" ||
      basis.sourceIds[sourceIndex] !== reference.sourceId ||
      Date.parse(basis.at) > evaluatedTime ||
      Date.parse(pending.detectedAt) > evaluatedTime ||
      reference.owner.kind !== "item" ||
      reference.owner.id !== pending.itemNodeId ||
      !isProductionSourceIdKind(parseSourceId(reference.sourceId).kind)
    ) {
      throw new RunCompletenessError(
        "invalid_reference",
        reference.sourceId,
        reference.path,
        undefined,
      );
    }
    uses.push(
      Object.freeze({
        use: Object.freeze({
          sourceId: canonicalSourceId(reference.sourceId),
          path: reference.path,
          destination: Object.freeze({ kind: "item", itemNodeId: pending.itemNodeId }),
          purpose: "previous_notification_pending",
          requiredCurrentness: "historical_allowed",
          allowedOwnerNodeIds: Object.freeze([pending.itemNodeId]),
          allowedRelationIds: Object.freeze([]),
        }),
        resolution: "historical",
        recordIdentity: serializeCanonicalJson(pending),
      }),
    );
  }
  return canonicalSort(uses);
}

/** 公開witnessの各参照をsource事実と所有位置から再解決する。 */
export function assertEvidenceClosureWitness(
  witness: EvidenceClosureWitness,
  summary: Readonly<{ referenceCount: number; sourceIds: readonly string[] }>,
  evaluatedAt: UtcIsoDateTime,
  approvedRepositories: readonly PublicRepository[],
  values: MaterializedReferenceValues,
  digest: ContentDigestPort,
): void {
  assertCacheOwnerWitness(witness.cacheOwners, values, digest);
  assertRunValueMatches(
    canonicalSort(witness.currentSources),
    witness.currentSources,
    ["evidenceClosureWitness", "currentSources"],
    "closure",
  );
  assertRunValueMatches(
    canonicalSort(witness.historicalEvidence),
    witness.historicalEvidence,
    ["evidenceClosureWitness", "historicalEvidence"],
    "closure",
  );
  assertRunValueMatches(
    canonicalSort(witness.resolvedUses),
    witness.resolvedUses,
    ["evidenceClosureWitness", "resolvedUses"],
    "closure",
  );
  assertRunValueMatches(
    collectMaterializedReferences(values, witness.cacheOwners),
    witness.materializedReferences,
    ["evidenceClosureWitness", "materializedReferences"],
    "closure",
  );
  const identities = witness.resolvedUses.map((value) => serializeCanonicalJson(value.use));
  if (new Set(identities).size !== identities.length) {
    throw new RunCompletenessError(
      "duplicate_id",
      "closure",
      ["evidenceClosureWitness"],
      undefined,
    );
  }
  const sourceIds = Object.freeze(
    [...new Set(witness.resolvedUses.map((resolved) => resolved.use.sourceId))].sort(),
  );
  const currentIds = new Set(
    witness.resolvedUses
      .filter((resolved) => resolved.resolution === "current")
      .map((resolved) => resolved.use.sourceId),
  );
  assertRunValueMatches(
    { referenceCount: witness.resolvedUses.length, sourceIds },
    summary,
    ["evidenceClosureSummary"],
    "closure",
  );
  const catalog = new EvidenceCatalog();
  for (const fact of witness.currentSources) catalog.registerCurrentSource(fact);
  assertRunValueMatches(
    witness.currentSources,
    catalog.snapshot().currentSources,
    ["evidenceClosureWitness", "currentSources"],
    "closure",
  );
  const currentById = indexedValues(witness.currentSources);
  const historicalById = indexedHistorical(witness.historicalEvidence);
  const context = Object.freeze({
    evaluatedAt,
    approvedRepositories,
    historicalEvidence: witness.historicalEvidence,
  });
  const selectedHistorical = new Map<string, OwnedHistoricalEvidence>();
  for (const resolved of witness.resolvedUses) {
    assertRunValueMatches(
      [...new Set(resolved.use.allowedOwnerNodeIds)].sort(),
      resolved.use.allowedOwnerNodeIds,
      ["evidenceClosureWitness", "resolvedUses", resolved.use.sourceId, "allowedOwnerNodeIds"],
      resolved.use.sourceId,
    );
    assertRunValueMatches(
      [...new Set(resolved.use.allowedRelationIds)].sort(),
      resolved.use.allowedRelationIds,
      ["evidenceClosureWitness", "resolvedUses", resolved.use.sourceId, "allowedRelationIds"],
      resolved.use.sourceId,
    );
    if (resolved.use.path[0] === "previousNotificationLedger") continue;
    const actual = resolveEvidenceUse(resolved.use, currentById, historicalById, context);
    assertRunValueMatches(
      actual.resolved,
      resolved,
      ["evidenceClosureWitness", "resolvedUses", resolved.use.sourceId],
      resolved.use.sourceId,
    );
    for (const value of actual.historical) {
      selectedHistorical.set(serializeCanonicalJson(value), value);
    }
  }
  for (const fact of witness.currentSources) {
    if (!currentIds.has(fact.sourceId)) {
      throw new RunCompletenessError(
        "invalid_reference",
        fact.sourceId,
        ["evidenceClosureWitness", "currentSources"],
        undefined,
      );
    }
  }
  assertRunValueMatches(
    canonicalSort([...selectedHistorical.values()]),
    witness.historicalEvidence,
    ["evidenceClosureWitness", "historicalEvidence"],
    "closure",
  );
  assertRunValueMatches(
    historicalLedgerUses(witness.materializedReferences, values, evaluatedAt),
    witness.resolvedUses.filter(
      (resolved) => resolved.use.path[0] === "previousNotificationLedger",
    ),
    ["evidenceClosureWitness", "resolvedUses"],
    "closure",
  );
  assertMaterializedReferenceBindings(witness.materializedReferences, witness.resolvedUses, values);
}

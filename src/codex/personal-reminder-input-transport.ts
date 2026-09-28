import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { ContentDigestPort } from "../application/tracking-run/ports.js";
import type { AiAnalysisElementInputFingerprint } from "../domain/ai-analysis-elements.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseAssessment,
  PersonalReminderCauseId,
  PersonalReminderInputCompleteness,
} from "../domain/personal-reminder-causes.js";
import {
  PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
} from "../domain/personal-reminder-causes.js";
import type { SourceId } from "../domain/source-id.js";
import type { GitHubNodeId, GraphNodeId } from "../domain/types.js";
import { assertNonNullable } from "../util/index.js";
import type {
  PersonalReminderAiBatchPreparation,
  PersonalReminderAiInput,
  PersonalReminderAiItemContext,
  PersonalReminderAiRelationContext,
  PersonalReminderAiSourceContext,
  PersonalReminderCanonicalRefs,
  PersonalReminderCauseSemanticInput,
  PersonalReminderItemRef,
  PersonalReminderRelationRef,
  PersonalReminderSourceRef,
  PersonalReminderTargetScope,
  PersonalReminderTargetScopeTransport,
  PreparedPersonalReminderCauseInput,
} from "./personal-reminder-input-contracts.js";
import {
  PERSONAL_REMINDER_AI_TRANSPORT_LIMITS,
  githubNodeIdSchema,
  personalReminderAiCauseTransportInputSchema,
  personalReminderAiInputSchema,
  personalReminderAiRelationContextSchema,
  personalReminderItemRefSchema,
  personalReminderRelationRefSchema,
  personalReminderSourceRefSchema,
} from "./personal-reminder-input-contracts.js";
import {
  canonicalResponsible,
  canonicalSemanticInput,
  compareStrings,
  countUnicodeCharacters,
  createMapEntry,
  createNonEmptyArray,
  createPersonalReminderCauseSemanticInput,
  responsibleKey,
  uniqueSorted,
  validateOptionRelationIntegrity,
  validateOptionTargetScope,
  validateUniqueStrings,
} from "./personal-reminder-input-core.js";
import { z } from "zod";

/** 個人催促原因の意味入力fingerprintを作成する。 */
export function createPersonalReminderCauseInputFingerprint(
  input: PersonalReminderCauseSemanticInput,
  digest: ContentDigestPort,
): AiAnalysisElementInputFingerprint {
  const parsed = createPersonalReminderCauseSemanticInput(input);
  return digest.sha256Utf8(serializeCanonicalJson(canonicalSemanticInput(parsed)));
}

function toItemRef(index: number): PersonalReminderItemRef {
  return personalReminderItemRefSchema.parse(`item:${index.toString()}`);
}

function toRelationRef(index: number): PersonalReminderRelationRef {
  return personalReminderRelationRefSchema.parse(`relation:${index.toString()}`);
}

function toSourceRef(index: number): PersonalReminderSourceRef {
  return personalReminderSourceRefSchema.parse(`source:${index.toString()}`);
}

function cloneSemanticInput(
  input: PersonalReminderCauseSemanticInput,
): PersonalReminderCauseSemanticInput {
  return createPersonalReminderCauseSemanticInput(input);
}

function createTransportTargetScope(
  scope: PersonalReminderTargetScope,
  itemRefById: ReadonlyMap<GraphNodeId, PersonalReminderItemRef>,
  label: string,
): PersonalReminderTargetScopeTransport {
  if (scope.kind === "item") {
    return { kind: "item" };
  }
  const surfaces = uniqueSorted(
    scope.surfaces,
    (value) => `${value.kind}\u0000${value.nodeId}`,
  ).map((surface) => {
    const itemRef = itemRefById.get(surface.nodeId);
    assertNonNullable(
      itemRef,
      `${label}のexecution surface item refがありません。対象: ${surface.nodeId}`,
    );
    return { kind: surface.kind, itemRef };
  });
  if (scope.kind === "execution_surfaces") {
    return { kind: "execution_surfaces", surfaces };
  }
  return { kind: "item_and_execution_surfaces", surfaces };
}

function resolveTransportTargetScope(
  scope: PersonalReminderTargetScopeTransport,
  itemByRef: ReadonlyMap<PersonalReminderItemRef, PersonalReminderAiItemContext>,
  causeItemRefs: ReadonlySet<PersonalReminderItemRef>,
  label: string,
): PersonalReminderTargetScope {
  if (scope.kind === "item") {
    return { kind: "item" };
  }
  const surfaces = scope.surfaces.map((surface) => {
    if (!causeItemRefs.has(surface.itemRef)) {
      throw new TypeError(
        `${label}のexecution surface item refがcause allowlistにありません。対象: ${surface.itemRef}`,
      );
    }
    const item = itemByRef.get(surface.itemRef);
    assertNonNullable(item, `${label}のexecution surface item refがありません`);
    if (
      (surface.kind === "issue" && item.type !== "issue") ||
      (surface.kind === "pull_request" && item.type !== "pull_request")
    ) {
      throw new TypeError(`${label}のexecution surface種別がitem contextと一致しません`);
    }
    return { kind: surface.kind, nodeId: githubNodeIdSchema.parse(item.nodeId) };
  });
  if (scope.kind === "execution_surfaces") {
    return { kind: "execution_surfaces", surfaces };
  }
  return { kind: "item_and_execution_surfaces", surfaces };
}

function canonicalRelationContext(
  relation: PersonalReminderAiRelationContext,
): PersonalReminderAiRelationContext {
  return personalReminderAiRelationContextSchema.parse({
    ...relation,
    evidenceSourceIds: uniqueSorted(relation.evidenceSourceIds, (sourceId) => sourceId),
  });
}

function exceedsPersonalReminderAiTransportCapacity(
  causes: readonly z.input<typeof personalReminderAiCauseTransportInputSchema>[],
  relations: readonly PersonalReminderAiRelationContext[],
  itemCount: number,
  sourceCount: number,
): boolean {
  if (
    causes.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.causes ||
    itemCount > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items ||
    relations.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations ||
    sourceCount > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources
  ) {
    return true;
  }
  for (const relation of relations) {
    if (
      relation.evidenceSourceIds.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds
    ) {
      return true;
    }
  }
  for (const cause of causes) {
    if (
      cause.itemRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items ||
      cause.relationRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations ||
      cause.sourceRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources ||
      cause.evidenceScopes.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources ||
      cause.waitingOptions.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.waitingOptions ||
      cause.duplicateOptions.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.duplicateOptions
    ) {
      return true;
    }
    for (const option of [...cause.waitingOptions, ...cause.duplicateOptions]) {
      if (
        option.relationRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds ||
        option.sourceRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds ||
        (option.targetScope.kind !== "item" &&
          option.targetScope.surfaces.length >
            PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds)
      ) {
        return true;
      }
    }
  }
  return false;
}

type PersonalReminderTransportInputPreparation =
  | Readonly<{
      status: "prepared";
      input: PersonalReminderAiInput;
      refs: PersonalReminderCanonicalRefs;
      causeInputs: ReadonlyMap<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>;
      itemNodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "over_capacity";
    }>;

function createTransportInput(
  inputs: readonly PersonalReminderCauseSemanticInput[],
  digest: ContentDigestPort,
): PersonalReminderTransportInputPreparation {
  const itemById = new Map<GraphNodeId, PersonalReminderAiItemContext>();
  const relationById = new Map<string, PersonalReminderAiRelationContext>();
  const sourceById = new Map<SourceId, PersonalReminderAiSourceContext>();
  const rootItemNodeId = inputs[0]?.cause.itemNodeId;
  assertNonNullable(rootItemNodeId, "個人催促AIの原因がありません");
  for (const input of inputs) {
    if (input.completeness.status !== "complete" || input.pendingRelations.length !== 0) {
      throw new TypeError("不完全または未確定relationを含む入力はAI batchへ送れません");
    }
    if (input.cause.itemNodeId !== rootItemNodeId) {
      throw new TypeError("同じitemの原因だけを個人催促AI batchへまとめてください");
    }
    for (const item of input.items) {
      const previous = itemById.get(item.nodeId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(item)) {
        throw new TypeError(`同じitem node IDに異なるcontextがあります。対象: ${item.nodeId}`);
      }
      itemById.set(item.nodeId, item);
    }
    for (const relation of input.relations) {
      const canonicalRelation = canonicalRelationContext(relation);
      const previous = relationById.get(canonicalRelation.id);
      if (
        previous != null &&
        serializeCanonicalJson(previous) !== serializeCanonicalJson(canonicalRelation)
      ) {
        throw new TypeError(
          `同じrelation IDに異なるcontextがあります。対象: ${canonicalRelation.id}`,
        );
      }
      relationById.set(canonicalRelation.id, canonicalRelation);
    }
    for (const source of input.sources) {
      const previous = sourceById.get(source.sourceId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(source)) {
        throw new TypeError(`同じsource IDに異なるcontextがあります。対象: ${source.sourceId}`);
      }
      sourceById.set(source.sourceId, source);
    }
  }
  const items = [...itemById.values()].sort((left, right) =>
    compareStrings(left.nodeId, right.nodeId),
  );
  const relations = [...relationById.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const sources = [...sourceById.values()].sort((left, right) =>
    compareStrings(left.sourceId, right.sourceId),
  );
  const itemRefById = new Map<GraphNodeId, PersonalReminderItemRef>();
  const relationRefById = new Map<string, PersonalReminderRelationRef>();
  const sourceRefById = new Map<SourceId, PersonalReminderSourceRef>();
  for (const [index, item] of items.entries()) {
    itemRefById.set(item.nodeId, toItemRef(index));
  }
  for (const [index, relation] of relations.entries()) {
    relationRefById.set(relation.id, toRelationRef(index));
  }
  for (const [index, source] of sources.entries()) {
    sourceRefById.set(source.sourceId, toSourceRef(index));
  }
  const rootItem = itemById.get(rootItemNodeId);
  assertNonNullable(rootItem, "原因のitem contextがありません");

  const transportCauses: z.input<typeof personalReminderAiCauseTransportInputSchema>[] = [];
  const causeInputs = new Map<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>();
  const seenCauseIds = new Set<PersonalReminderCauseId>();
  for (const sourceInput of inputs) {
    const input = cloneSemanticInput(sourceInput);
    const causeId = input.cause.causeId;
    if (seenCauseIds.has(causeId)) {
      throw new TypeError(`個人催促原因IDが重複しています。対象: ${causeId}`);
    }
    seenCauseIds.add(causeId);
    const itemRefs = uniqueSorted(input.items, (item) => item.nodeId).map((item) => {
      const ref = itemRefById.get(item.nodeId);
      assertNonNullable(ref, `item refがありません。対象: ${item.nodeId}`);
      return ref;
    });
    const relationRefs = uniqueSorted(input.relations, (relation) => relation.id).map(
      (relation) => {
        const ref = relationRefById.get(relation.id);
        assertNonNullable(ref, `relation refがありません。対象: ${relation.id}`);
        return ref;
      },
    );
    const sourceRefs = uniqueSorted(input.sources, (source) => source.sourceId).map((source) => {
      const ref = sourceRefById.get(source.sourceId);
      assertNonNullable(ref, `source refがありません。対象: ${source.sourceId}`);
      return ref;
    });
    const evidenceScopes = uniqueSorted(input.evidenceScopes, (scope) => scope.sourceId).map(
      (scope) => {
        const sourceRef = sourceRefById.get(scope.sourceId);
        assertNonNullable(
          sourceRef,
          `evidence scopeのsource refがありません。対象: ${scope.sourceId}`,
        );
        const [firstRole, ...restRoles] = createNonEmptyArray(
          uniqueSorted(scope.roles, (role) => role),
          "evidence scopeのroleがありません",
        );
        return {
          sourceRef,
          roles: [firstRole, ...restRoles],
        };
      },
    );
    const waitingOptions = uniqueSorted(input.waitingOptions, (option) => option.optionId).map(
      (option) => {
        const itemRef = itemRefById.get(option.itemNodeId);
        assertNonNullable(
          itemRef,
          `waiting optionのitem refがありません。対象: ${option.itemNodeId}`,
        );
        const relationRefsForOption = uniqueSorted(
          option.relationIds,
          (relationId) => relationId,
        ).map((relationId) => {
          const relationRef = relationRefById.get(relationId);
          assertNonNullable(
            relationRef,
            `waiting optionのrelation refがありません。対象: ${relationId}`,
          );
          return relationRef;
        });
        const sourceRefsForOption = uniqueSorted(
          option.evidenceSourceIds,
          (sourceId) => sourceId,
        ).map((sourceId) => {
          const sourceRef = sourceRefById.get(sourceId);
          assertNonNullable(sourceRef, `waiting optionのsource refがありません。対象: ${sourceId}`);
          return sourceRef;
        });
        const [firstSource, ...restSources] = createNonEmptyArray(
          sourceRefsForOption,
          "waiting optionのsourceがありません",
        );
        return {
          optionId: option.optionId,
          itemRef,
          targetScope: createTransportTargetScope(
            option.targetScope,
            itemRefById,
            `waiting option ${option.optionId}`,
          ),
          action: option.action,
          relationRefs: relationRefsForOption,
          sourceRefs: [firstSource, ...restSources],
        };
      },
    );
    const duplicateOptions = uniqueSorted(
      input.duplicateOptions,
      (option) => option.canonicalCauseId,
    ).map((option) => {
      const itemRef = itemRefById.get(option.itemNodeId);
      assertNonNullable(
        itemRef,
        `duplicate optionのitem refがありません。対象: ${option.itemNodeId}`,
      );
      const relationRefsForOption = uniqueSorted(
        option.relationIds,
        (relationId) => relationId,
      ).map((relationId) => {
        const relationRef = relationRefById.get(relationId);
        assertNonNullable(
          relationRef,
          `duplicate optionのrelation refがありません。対象: ${relationId}`,
        );
        return relationRef;
      });
      const sourceRefsForOption = uniqueSorted(
        option.evidenceSourceIds,
        (sourceId) => sourceId,
      ).map((sourceId) => {
        const sourceRef = sourceRefById.get(sourceId);
        assertNonNullable(sourceRef, `duplicate optionのsource refがありません。対象: ${sourceId}`);
        return sourceRef;
      });
      const [firstRelation, ...restRelations] = createNonEmptyArray(
        relationRefsForOption,
        "duplicate optionのrelationがありません",
      );
      const [firstSource, ...restSources] = createNonEmptyArray(
        sourceRefsForOption,
        "duplicate optionのsourceがありません",
      );
      const [firstResponsible, ...restResponsible] = createNonEmptyArray(
        canonicalResponsible(option.responsible),
        "duplicate optionの責任主体がありません",
      );
      return {
        canonicalCauseId: option.canonicalCauseId,
        itemRef,
        targetScope: createTransportTargetScope(
          option.targetScope,
          itemRefById,
          `duplicate option ${option.canonicalCauseId}`,
        ),
        responsible: [firstResponsible, ...restResponsible],
        action: option.action,
        relationRefs: [firstRelation, ...restRelations],
        sourceRefs: [firstSource, ...restSources],
      };
    });
    const [firstItemRef, ...restItemRefs] = createNonEmptyArray(
      itemRefs,
      "原因のitem refがありません",
    );
    const [firstSourceRef, ...restSourceRefs] = createNonEmptyArray(
      sourceRefs,
      "原因のsource refがありません",
    );
    transportCauses.push({
      causeId,
      cause: input.cause,
      completeness: input.completeness,
      itemRefs: [firstItemRef, ...restItemRefs],
      relationRefs,
      sourceRefs: [firstSourceRef, ...restSourceRefs],
      evidenceScopes,
      waitingOptions,
      duplicateOptions,
    });
    causeInputs.set(
      causeId,
      Object.freeze({
        input,
        inputFingerprint: createPersonalReminderCauseInputFingerprint(input, digest),
      }),
    );
  }

  if (
    exceedsPersonalReminderAiTransportCapacity(
      transportCauses,
      relations,
      items.length,
      sources.length,
    )
  ) {
    return Object.freeze({
      status: "over_capacity",
    });
  }

  const transportInput = personalReminderAiInputSchema.parse({
    schemaVersion: PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
    item: {
      nodeId: rootItem.nodeId,
      url: rootItem.url,
    },
    causes: transportCauses,
    items: items.map((item, index) => ({
      ref: toItemRef(index),
      item,
    })),
    relations: relations.map((relation, index) => ({
      ref: toRelationRef(index),
      relation,
    })),
    sources: sources.map((source, index) => ({
      ref: toSourceRef(index),
      source,
    })),
  });
  const refs: PersonalReminderCanonicalRefs = Object.freeze({
    items: new Map(items.map((item, index) => createMapEntry(toItemRef(index), item.nodeId))),
    relations: new Map(
      relations.map((relation, index) => createMapEntry(toRelationRef(index), relation.id)),
    ),
    sources: new Map(
      sources.map((source, index) => createMapEntry(toSourceRef(index), source.sourceId)),
    ),
  });
  return Object.freeze({
    status: "prepared",
    input: transportInput,
    refs,
    causeInputs,
    itemNodeId: rootItemNodeId,
  });
}

function validateTransportInputIntegrity(input: PersonalReminderAiInput): void {
  const itemRefValues = input.items.map((value) => value.ref);
  const relationRefValues = input.relations.map((value) => value.ref);
  const sourceRefValues = input.sources.map((value) => value.ref);
  validateUniqueStrings(itemRefValues, "transport item ref");
  validateUniqueStrings(relationRefValues, "transport relation ref");
  validateUniqueStrings(sourceRefValues, "transport source ref");
  const itemRefs = new Set(itemRefValues);
  const relationRefs = new Set(relationRefValues);
  const sourceRefs = new Set(sourceRefValues);
  const itemByRef = new Map(input.items.map((value) => [value.ref, value.item]));
  const itemByNodeId = new Map(input.items.map((value) => [value.item.nodeId, value.item]));
  const relationByRef = new Map(input.relations.map((value) => [value.ref, value.relation]));
  const sourceByRef = new Map(input.sources.map((value) => [value.ref, value.source]));
  const itemNodeIdValues = input.items.map((value) => value.item.nodeId);
  validateUniqueStrings(itemNodeIdValues, "transport item node ID");
  const itemNodeIds = new Set(itemNodeIdValues);
  const rootItem = input.items.find((value) => value.item.nodeId === input.item.nodeId);
  assertNonNullable(rootItem, "transport inputのitem identityがitemsにありません");
  if (rootItem.item.url !== input.item.url) {
    throw new TypeError("transport inputのitem URLがitemsのcontextと一致しません");
  }
  const relationIdValues = input.relations.map((value) => value.relation.id);
  const sourceIdValues = input.sources.map((value) => value.source.sourceId);
  validateUniqueStrings(relationIdValues, "transport relation ID");
  validateUniqueStrings(sourceIdValues, "transport source ID");
  const relationIds = new Set(relationIdValues);
  const sourceIds = new Set(sourceIdValues);
  for (const relation of input.relations) {
    if (
      !itemNodeIds.has(relation.relation.fromNodeId) ||
      !itemNodeIds.has(relation.relation.toNodeId)
    ) {
      throw new TypeError(`transport relation ${relation.relation.id}の端点がありません`);
    }
    validateUniqueStrings(
      relation.relation.evidenceSourceIds,
      `transport relation ${relation.relation.id}のsource ID`,
    );
    for (const sourceId of relation.relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new TypeError(`transport relationのsourceがありません。対象: ${sourceId}`);
      }
    }
  }
  for (const source of input.sources) {
    if (!itemNodeIds.has(source.source.itemNodeId)) {
      throw new TypeError(`transport sourceのitemがありません。対象: ${source.source.sourceId}`);
    }
  }
  const causeIds = new Set<string>();
  for (const cause of input.causes) {
    if (cause.completeness.status !== "complete") {
      throw new TypeError(`不完全なcauseをtransportへ含められません。対象: ${cause.causeId}`);
    }
    if (causeIds.has(cause.causeId)) {
      throw new TypeError(`transport inputのcause IDが重複しています。対象: ${cause.causeId}`);
    }
    causeIds.add(cause.causeId);
    if (cause.causeId !== cause.cause.causeId) {
      throw new TypeError(`causeの外側と内側のIDが一致しません。対象: ${cause.causeId}`);
    }
    if (cause.cause.itemNodeId !== input.item.nodeId) {
      throw new TypeError(
        `causeのitem node IDがtransport itemと一致しません。対象: ${cause.causeId}`,
      );
    }
    const causeItemRefValues = [...cause.itemRefs];
    const causeRelationRefValues = [...cause.relationRefs];
    const causeSourceRefValues = [...cause.sourceRefs];
    validateUniqueStrings(causeItemRefValues, `cause ${cause.causeId}のitem ref`);
    validateUniqueStrings(causeRelationRefValues, `cause ${cause.causeId}のrelation ref`);
    validateUniqueStrings(causeSourceRefValues, `cause ${cause.causeId}のsource ref`);
    const causeItemRefs = new Set(causeItemRefValues);
    const causeRelationRefs = new Set(causeRelationRefValues);
    const causeSourceRefs = new Set(causeSourceRefValues);
    validateUniqueStrings(
      cause.cause.responsible.map((value) => responsibleKey(value)),
      `cause ${cause.causeId}の責任主体`,
    );
    if (cause.cause.responsibility.scope.kind !== "item") {
      validateUniqueStrings(
        cause.cause.responsibility.scope.surfaces.map(
          (value) => `${value.kind}\u0000${value.nodeId}`,
        ),
        `cause ${cause.causeId}のexecution surface`,
      );
    }
    validateUniqueStrings(
      cause.evidenceScopes.map((value) => value.sourceRef),
      `cause ${cause.causeId}のevidence source ref`,
    );
    validateUniqueStrings(
      cause.waitingOptions.map((value) => value.optionId),
      `cause ${cause.causeId}のwaiting option ID`,
    );
    validateUniqueStrings(
      cause.duplicateOptions.map((value) => value.canonicalCauseId),
      `cause ${cause.causeId}のduplicate option ID`,
    );
    for (const ref of causeItemRefValues) {
      if (!itemRefs.has(ref)) {
        throw new TypeError(`causeのitem refがありません。対象: ${ref}`);
      }
    }
    for (const ref of causeRelationRefValues) {
      if (!relationRefs.has(ref)) {
        throw new TypeError(`causeのrelation refがありません。対象: ${ref}`);
      }
    }
    for (const ref of causeSourceRefValues) {
      if (!sourceRefs.has(ref)) {
        throw new TypeError(`causeのsource refがありません。対象: ${ref}`);
      }
    }
    if (!causeItemRefValues.some((ref) => itemByRef.get(ref)?.nodeId === cause.cause.itemNodeId)) {
      throw new TypeError(
        `causeのitem allowlistにsubject itemがありません。対象: ${cause.causeId}`,
      );
    }
    for (const scope of cause.evidenceScopes) {
      if (!causeSourceRefs.has(scope.sourceRef)) {
        throw new TypeError(
          `causeのevidence source refがallowlistにありません。対象: ${scope.sourceRef}`,
        );
      }
      validateUniqueStrings(scope.roles, `cause ${cause.causeId}のevidence role`);
    }
    const validateOption = (
      option: Readonly<{
        itemRef: PersonalReminderItemRef;
        targetScope: PersonalReminderTargetScope;
        relationRefs: readonly PersonalReminderRelationRef[];
        sourceRefs: readonly PersonalReminderSourceRef[];
      }>,
      label: string,
    ): void => {
      if (!causeItemRefs.has(option.itemRef)) {
        throw new TypeError(
          `${label}のitem refがcause allowlistにありません。対象: ${option.itemRef}`,
        );
      }
      validateUniqueStrings(option.relationRefs, `${label}のrelation ref`);
      validateUniqueStrings(option.sourceRefs, `${label}のsource ref`);
      for (const ref of option.relationRefs) {
        if (!causeRelationRefs.has(ref)) {
          throw new TypeError(`${label}のrelation refがcause allowlistにありません。対象: ${ref}`);
        }
      }
      for (const ref of option.sourceRefs) {
        if (!causeSourceRefs.has(ref)) {
          throw new TypeError(`${label}のsource refがcause allowlistにありません。対象: ${ref}`);
        }
      }
      const targetItem = itemByRef.get(option.itemRef);
      assertNonNullable(targetItem, `${label}のitem refがありません。対象: ${option.itemRef}`);
      validateOptionTargetScope(
        {
          itemNodeId: targetItem.nodeId,
          targetScope: option.targetScope,
        },
        itemByNodeId,
        label,
      );
      validateOptionRelationIntegrity(
        {
          itemNodeId: targetItem.nodeId,
          targetScope: option.targetScope,
          relationIds: option.relationRefs,
        },
        cause.cause,
        relationByRef,
        label,
      );
    };
    for (const option of cause.waitingOptions) {
      validateOption(
        {
          ...option,
          targetScope: resolveTransportTargetScope(
            option.targetScope,
            itemByRef,
            causeItemRefs,
            `waiting option ${option.optionId} of cause ${cause.causeId}`,
          ),
        },
        `waiting option ${option.optionId} of cause ${cause.causeId}`,
      );
    }
    for (const option of cause.duplicateOptions) {
      validateUniqueStrings(
        option.responsible.map((value) => responsibleKey(value)),
        `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}の責任主体`,
      );
      validateOption(
        {
          ...option,
          targetScope: resolveTransportTargetScope(
            option.targetScope,
            itemByRef,
            causeItemRefs,
            `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}`,
          ),
        },
        `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}`,
      );
    }
    for (const ref of causeRelationRefValues) {
      const relation = relationByRef.get(ref);
      assertNonNullable(relation, `causeのrelation refがありません。対象: ${ref}`);
      if (!relationIds.has(relation.id)) {
        throw new TypeError(`causeのrelation IDがtransportにありません。対象: ${relation.id}`);
      }
      if (relation.type === "related_to") {
        throw new TypeError(`causeにrelated_to relationは指定できません。対象: ${relation.id}`);
      }
    }
    for (const ref of causeSourceRefValues) {
      const source = sourceByRef.get(ref);
      assertNonNullable(source, `causeのsource refがありません。対象: ${ref}`);
      if (!sourceIds.has(source.sourceId)) {
        throw new TypeError(`causeのsource IDがtransportにありません。対象: ${source.sourceId}`);
      }
    }
  }
}

/** 未検証値から個人催促AI入力を作成する。 */
export function createPersonalReminderAiInput(value: unknown): PersonalReminderAiInput {
  const parsed = personalReminderAiInputSchema.parse(value);
  validateTransportInputIntegrity(parsed);
  return parsed;
}

/** 個人催促AI入力をcanonical JSONへ直列化する。 */
export function serializePersonalReminderAiInput(input: PersonalReminderAiInput): string {
  return `${serializeCanonicalJson(createPersonalReminderAiInput(input))}\n`;
}

/** 採用済みassessmentを再利用するか、causeをAI評価へ送るか決める。 */
export function planPersonalReminderCauseEvaluation(
  input: Readonly<{
    cause: PersonalReminderCause;
    currentInput: Readonly<{
      fingerprint: AiAnalysisElementInputFingerprint;
      rulesVersion: typeof PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION;
      completeness: PersonalReminderInputCompleteness;
    }>;
    semanticInput: PersonalReminderCauseSemanticInput;
  }>,
  digest: ContentDigestPort,
):
  | Readonly<{ status: "reuse"; assessment: PersonalReminderCauseAssessment }>
  | Readonly<{ status: "evaluate"; input: PersonalReminderCauseSemanticInput }> {
  const semanticInput = createPersonalReminderCauseSemanticInput(input.semanticInput);
  const fingerprint = createPersonalReminderCauseInputFingerprint(semanticInput, digest);
  const adopted = input.cause.adoptedAssessment;
  if (
    input.currentInput.fingerprint === fingerprint &&
    adopted.status === "available" &&
    adopted.inputFingerprint === fingerprint &&
    adopted.rulesVersion === input.currentInput.rulesVersion
  ) {
    return Object.freeze({
      status: "reuse",
      assessment: adopted.result,
    });
  }
  return Object.freeze({
    status: "evaluate",
    input: semanticInput,
  });
}

/** 同じitemの原因入力を一つの専用AI batchへまとめる。 */
export function preparePersonalReminderAiBatch(
  inputs: readonly [PersonalReminderCauseSemanticInput, ...PersonalReminderCauseSemanticInput[]],
  digest: ContentDigestPort,
): PersonalReminderAiBatchPreparation {
  if (inputs.length === 0) {
    throw new TypeError("個人催促AI batchの原因がありません");
  }
  const normalizedInputs = inputs
    .map((value) => createPersonalReminderCauseSemanticInput(value))
    .sort((left, right) => compareStrings(left.cause.causeId, right.cause.causeId));
  const transport = createTransportInput(normalizedInputs, digest);
  if (transport.status === "over_capacity") {
    return transport;
  }
  const normalizedInput = serializePersonalReminderAiInput(transport.input);
  const batchInputFingerprint = digest.sha256Utf8(serializeCanonicalJson(transport.input));
  return Object.freeze({
    status: "prepared",
    batch: Object.freeze({
      id: `personal-reminder-batch:${batchInputFingerprint}`,
      itemNodeId: transport.itemNodeId,
      input: transport.input,
      normalizedInput,
      inputCharacters: countUnicodeCharacters(normalizedInput),
      batchInputFingerprint,
      refs: transport.refs,
      causeInputs: transport.causeInputs,
    }),
  });
}

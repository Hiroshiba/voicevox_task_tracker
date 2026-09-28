import {
  currentPersonalReminderAssessment,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  type AiAnalysisDependency,
  type CurrentPersonalReminderAssessment,
  type Evidence,
  type PersonalReminderCause,
  type SourceId,
  type TrackedItem,
} from "../domain/index.js";
import type { StateSnapshot } from "../persistence/index.js";
import { UnreachableError } from "../util/index.js";
import {
  resolveEvidenceSourceUrlForItem,
  type EvidenceSourceUrlMap,
} from "./evidence-source-url.js";
import { PublicDtoSemanticError } from "./errors.js";
import type {
  PublicCurrentResponseSubjectChangesDto,
  PublicCurrentResponseSubjectDto,
  PublicDetailsDto,
  PublicItemSummaryDto,
  PublicPersonalReminderResponseDto,
  PublicPersonalReminderUnknownReason,
} from "./public-dto.js";

type PublicPersonalReminderResponse = PublicPersonalReminderResponseDto;
type PublicPersonalReminderUnverifiedValue =
  PublicPersonalReminderResponse["unverifiedValues"][number];
export type PublicPersonalReminderResponses = Readonly<{
  responses: readonly PublicPersonalReminderResponse[];
  currentResponsesUnverified: boolean;
  currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto;
}>;
type EvidenceSourceItem = Readonly<Pick<TrackedItem, "nodeId" | "url">>;
type EvidenceBySourceId = ReadonlyMap<SourceId, readonly Evidence[]>;
type PublicAiAnalysis = PublicItemSummaryDto["aiAnalysis"];
type PublicUnverifiedValue = PublicAiAnalysis["unverifiedValues"][number];
type PublicPersonalReminderCausePlanningStatus =
  PublicItemSummaryDto["personalReminderCausePlanningStatus"];

function isUnverifiedAiDependency(dependency: AiAnalysisDependency): boolean {
  switch (dependency.status) {
    case "not_dependent":
    case "current":
      return false;
    case "unverified":
    case "unknown":
      return true;
    default:
      throw new UnreachableError(dependency);
  }
}

function hasUnverifiedAiDependency(dependencies: readonly AiAnalysisDependency[]): boolean {
  let unverified = false;
  for (const dependency of dependencies) {
    if (isUnverifiedAiDependency(dependency)) {
      unverified = true;
    }
  }
  return unverified;
}

function createPersonalReminderUnverifiedValues(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
  hasCurrentAssessmentEvidence: boolean,
): PublicPersonalReminderResponse["unverifiedValues"] {
  const values: PublicPersonalReminderUnverifiedValue[] = [];
  const statusDependencies = [cause.aiDependencies.presence];
  if (assessment.status === "available") {
    statusDependencies.push(cause.currentInput.aiDependency);
  }
  if (hasUnverifiedAiDependency(statusDependencies)) {
    values.push("status");
  }
  if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
    values.push("responsible");
  }
  if (isUnverifiedAiDependency(cause.aiDependencies.action)) {
    values.push("action");
  }
  if (
    isUnverifiedAiDependency(cause.aiDependencies.evidence) ||
    (hasCurrentAssessmentEvidence && isUnverifiedAiDependency(cause.currentInput.aiDependency))
  ) {
    values.push("evidence");
  }
  if (
    assessment.status === "available" &&
    assessment.result.verdict === "waiting" &&
    isUnverifiedAiDependency(cause.currentInput.aiDependency)
  ) {
    values.push("waitingFor");
  }
  return values;
}

function personalReminderMembershipAssessmentUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  switch (cause.responseMembershipAssessmentRequirement.status) {
    case "not_required":
      return false;
    case "required":
      return assessment.status !== "available";
    case "unknown":
      return true;
    default:
      throw new UnreachableError(cause.responseMembershipAssessmentRequirement);
  }
}

function personalReminderResponseMembershipUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  return (
    personalReminderMembershipAssessmentUnverified(cause, assessment) ||
    hasUnverifiedAiDependency([
      cause.aiDependencies.presence,
      cause.aiDependencies.responseMembership,
      cause.aiDependencies.responsible,
    ])
  );
}

function createPersonalReminderSubjectMembershipUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  return (
    cause.responsible.some((responsible) => responsible.kind !== "role") &&
    personalReminderResponseMembershipUnverified(cause, assessment)
  );
}

/** 項目のAI利用状態を公開値へ写す。 */
export function createPublicAiAnalysis(
  item: StateSnapshot["items"][number],
  effectiveBlockerNodeIds: readonly string[],
  retainedOnlyBlockerNodeIds: readonly string[],
): PublicAiAnalysis {
  const applications = [
    item.aiAnalysis.applications.status,
    item.aiAnalysis.applications.waitingOn,
    item.aiAnalysis.applications.nextAction,
    item.aiAnalysis.applications.relations,
    item.aiAnalysis.applications.progress,
    item.aiAnalysis.applications.importance,
    item.aiAnalysis.applications.deadline,
    item.aiAnalysis.applications.notification,
    item.aiAnalysis.applications.selfCommitment,
  ];
  const notRequiredApplicationCount = applications.filter(
    (application) => application.status === "not_required",
  ).length;
  let omission: PublicAiAnalysis["omission"];
  if (notRequiredApplicationCount === 0) {
    omission = "none";
  } else if (notRequiredApplicationCount === applications.length) {
    omission = "all";
  } else {
    omission = "partial";
  }

  const unverifiedValues: PublicUnverifiedValue[] = [];
  const dependencies = item.aiDependencies;
  const primaryWaitingOn = item.waitingOn[0];
  const primaryBlockerRetainedOnly =
    item.status === "waiting_for_unblock" &&
    primaryWaitingOn?.kind === "item" &&
    primaryWaitingOn.role === "dependency" &&
    retainedOnlyBlockerNodeIds.includes(primaryWaitingOn.candidateId);
  if (
    hasUnverifiedAiDependency([dependencies.status]) ||
    (retainedOnlyBlockerNodeIds.length > 0 && effectiveBlockerNodeIds.length === 0)
  ) {
    unverifiedValues.push("status");
  }
  if (
    hasUnverifiedAiDependency([dependencies.waitingOn]) ||
    retainedOnlyBlockerNodeIds.length > 0
  ) {
    unverifiedValues.push("waitingOn");
  }
  if (hasUnverifiedAiDependency([dependencies.primaryWaitingOn]) || primaryBlockerRetainedOnly) {
    unverifiedValues.push("primaryWaitingOn");
  }
  if (hasUnverifiedAiDependency([dependencies.nextAction]) || primaryBlockerRetainedOnly) {
    unverifiedValues.push("nextAction");
  }
  if (hasUnverifiedAiDependency([dependencies.confidence])) {
    unverifiedValues.push("confidence");
  }
  if (hasUnverifiedAiDependency([dependencies.evidence])) {
    unverifiedValues.push("evidence");
  }
  if (hasUnverifiedAiDependency([dependencies.uncertainties])) {
    unverifiedValues.push("uncertainties");
  }
  if (hasUnverifiedAiDependency([dependencies.deadline, dependencies.deadlineLevel])) {
    unverifiedValues.push("deadline");
  }
  if (hasUnverifiedAiDependency([dependencies.stallSince])) {
    unverifiedValues.push("staleness");
  }
  if (hasUnverifiedAiDependency([dependencies.downstreamImpact])) {
    unverifiedValues.push("downstreamImpact");
  }
  if (hasUnverifiedAiDependency([dependencies.importance])) {
    unverifiedValues.push("importance");
  }
  if (hasUnverifiedAiDependency([dependencies.attention])) {
    unverifiedValues.push("attention");
  }
  if (hasUnverifiedAiDependency([dependencies.blockers])) {
    unverifiedValues.push("blockers");
  }
  if (hasUnverifiedAiDependency([dependencies.relationSet])) {
    unverifiedValues.push("relations");
  }
  return {
    runStatus: item.aiAnalysis.status,
    omission,
    unverifiedValues,
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

interface PublicCurrentResponseSubjectChangesAccumulator {
  addableSubjects: Map<string, PublicCurrentResponseSubjectDto>;
  removableSubjects: Map<string, PublicCurrentResponseSubjectDto>;
  unbounded: boolean;
}

function publicCurrentResponseSubjectKey(subject: PublicCurrentResponseSubjectDto): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function addPublicCurrentResponseSubject(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  change: "addable" | "removable",
  subject: PublicCurrentResponseSubjectDto,
): void {
  const subjects =
    change === "addable" ? accumulator.addableSubjects : accumulator.removableSubjects;
  const key = publicCurrentResponseSubjectKey(subject);
  const existing = subjects.get(key);
  if (existing == null || compareStrings(subject.candidateId, existing.candidateId) < 0) {
    subjects.set(key, subject);
  }
}

function createPublicCurrentResponseSubjectChangesAccumulator(
  changes: PublicCurrentResponseSubjectChangesDto,
): PublicCurrentResponseSubjectChangesAccumulator {
  const accumulator: PublicCurrentResponseSubjectChangesAccumulator = {
    addableSubjects: new Map(),
    removableSubjects: new Map(),
    unbounded: changes.scope === "unbounded",
  };
  if (changes.scope === "unbounded") {
    return accumulator;
  }
  for (const subject of changes.addableSubjects) {
    addPublicCurrentResponseSubject(accumulator, "addable", subject);
  }
  for (const subject of changes.removableSubjects) {
    addPublicCurrentResponseSubject(accumulator, "removable", subject);
  }
  return accumulator;
}

function addResponsibleCurrentResponseSubjectChanges(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  change: "addable" | "removable",
  responsibleValues: PersonalReminderCause["responsible"],
): void {
  for (const responsible of responsibleValues) {
    const responsibleKind = responsible.kind;
    switch (responsibleKind) {
      case "user":
      case "team":
        addPublicCurrentResponseSubject(accumulator, change, {
          kind: responsibleKind,
          candidateId: responsible.candidateId,
        });
        break;
      case "role":
        break;
      default:
        throw new UnreachableError(responsibleKind);
    }
  }
}

function finalizePublicCurrentResponseSubjectChanges(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  responses: readonly PublicPersonalReminderResponse[],
): PublicCurrentResponseSubjectChangesDto {
  if (accumulator.unbounded) {
    return {
      scope: "unbounded",
    };
  }
  const verifiedSubjectKeys = new Set<string>();
  for (const response of responses) {
    if (response.subjectMembershipUnverified) {
      continue;
    }
    for (const responsible of response.responsible) {
      if (responsible.kind === "role") {
        continue;
      }
      verifiedSubjectKeys.add(
        publicCurrentResponseSubjectKey({
          kind: responsible.kind,
          candidateId: responsible.candidateId,
        }),
      );
    }
  }
  for (const key of verifiedSubjectKeys) {
    accumulator.removableSubjects.delete(key);
  }
  const compareSubjects = (
    left: PublicCurrentResponseSubjectDto,
    right: PublicCurrentResponseSubjectDto,
  ): number =>
    compareStrings(publicCurrentResponseSubjectKey(left), publicCurrentResponseSubjectKey(right));
  return {
    scope: "bounded",
    addableSubjects: [...accumulator.addableSubjects.values()].sort(compareSubjects),
    removableSubjects: [...accumulator.removableSubjects.values()].sort(compareSubjects),
  };
}

function createPublicEvidenceEntry(
  entry: Evidence,
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"][number] {
  return {
    summary: entry.summary,
    sourceUrl: resolveEvidenceSourceUrlForItem(
      entry.sourceId,
      currentSourceItem,
      allSourceItems,
      sourceOwnersById,
    ),
  };
}

type PublicEvidence = PublicDetailsDto["items"][number]["evidence"][number];

function publicEvidenceIdentity(evidence: PublicEvidence): string {
  return JSON.stringify([evidence.summary, evidence.sourceUrl]);
}

function uniquePublicEvidence(evidence: readonly PublicEvidence[]): PublicEvidence[] {
  const evidenceByIdentity = new Map<string, PublicEvidence>();
  for (const entry of evidence) {
    evidenceByIdentity.set(publicEvidenceIdentity(entry), entry);
  }
  return [...evidenceByIdentity.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, entry]) => entry);
}

/** 根拠を公開URL付きの値へ写す。 */
export function createPublicEvidence(
  evidence: readonly Evidence[],
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"] {
  return uniquePublicEvidence(
    evidence.map((entry) =>
      createPublicEvidenceEntry(entry, currentSourceItem, allSourceItems, sourceOwnersById),
    ),
  );
}

/** snapshotの根拠をsource IDで索引化する。 */
export function createEvidenceBySourceId(snapshot: StateSnapshot): EvidenceBySourceId {
  const evidenceBySourceId = new Map<SourceId, Evidence[]>();
  for (const evidence of [
    ...snapshot.items.flatMap((item) => item.evidence),
    ...snapshot.relations.flatMap((relation) => relation.evidence),
  ]) {
    const existing = evidenceBySourceId.get(evidence.sourceId);
    if (existing == null) {
      evidenceBySourceId.set(evidence.sourceId, [evidence]);
      continue;
    }
    existing.push(evidence);
  }
  return new Map(
    [...evidenceBySourceId.entries()].map(([sourceId, evidence]) => [
      sourceId,
      Object.freeze([...evidence]),
    ]),
  );
}

function createPersonalReminderResponseEvidence(
  sourceIds: readonly SourceId[],
  assessmentReferences:
    | Readonly<{
        sourceIds: readonly SourceId[];
        reasonSummary: string;
      }>
    | undefined,
  currentSourceItem: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
  evidenceBySourceId: EvidenceBySourceId,
): PublicPersonalReminderResponse["evidence"] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareStrings);
  return uniquePublicEvidence(
    uniqueSourceIds.map((sourceId) => {
      if (assessmentReferences?.sourceIds.includes(sourceId) === true) {
        const sourceEvidence = evidenceBySourceId.get(sourceId);
        if (sourceEvidence == null || sourceEvidence.length === 0) {
          throw new PublicDtoSemanticError(
            `personal reminder causeのassessment evidence sourceを公開根拠へ解決できません。対象: ${sourceId}`,
          );
        }
        return createPublicEvidenceEntry(
          {
            sourceId,
            supports: "notification",
            summary: assessmentReferences.reasonSummary,
          },
          currentSourceItem,
          allSourceItems,
          sourceOwnersById,
        );
      }
      const currentEvidence = currentSourceItem.evidence.find(
        (evidence) => evidence.sourceId === sourceId,
      );
      const fallbackEvidence = evidenceBySourceId.get(sourceId)?.[0];
      const evidence = currentEvidence ?? fallbackEvidence;
      if (evidence == null) {
        throw new PublicDtoSemanticError(
          `personal reminder causeのevidence sourceを公開根拠へ解決できません。対象: ${sourceId}`,
        );
      }
      return createPublicEvidenceEntry(
        evidence,
        currentSourceItem,
        allSourceItems,
        sourceOwnersById,
      );
    }),
  );
}

function personalReminderUnknownReason(
  cause: PersonalReminderCause,
): PublicPersonalReminderUnknownReason {
  switch (cause.latestAttempt.status) {
    case "not_evaluated":
      return "not_evaluated";
    case "failed":
      return cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
        cause.latestAttempt.inputFingerprint === cause.currentInput.fingerprint &&
        cause.latestAttempt.rulesVersion === cause.currentInput.rulesVersion
        ? "failed"
        : "input_mismatch";
    case "deferred":
      return cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
        cause.latestAttempt.inputFingerprint === cause.currentInput.fingerprint &&
        cause.latestAttempt.rulesVersion === cause.currentInput.rulesVersion
        ? "deferred"
        : "input_mismatch";
    case "completed":
      return "input_mismatch";
  }
}

function createPersonalReminderResponseBase(
  cause: PersonalReminderCause,
  evidence: PublicPersonalReminderResponse["evidence"],
): Omit<
  PublicPersonalReminderResponse,
  "status" | "waitingFor" | "reason" | "unverifiedValues" | "subjectMembershipUnverified"
> {
  return {
    causeId: cause.causeId,
    responsible: cause.responsible.map((responsible) => ({
      kind: responsible.kind,
      candidateId: responsible.candidateId,
      role: responsible.role,
    })),
    action: {
      kind: cause.action.kind,
      summary: cause.action.summary,
    },
    evidence,
  };
}

function createPersonalReminderResponse(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
  currentSourceItem: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
  evidenceBySourceId: EvidenceBySourceId,
): PublicPersonalReminderResponse | undefined {
  if (assessment.status === "available") {
    if (assessment.result.verdict === "duplicate" || assessment.result.verdict === "not_required") {
      return undefined;
    }
  }
  const assessmentReferences =
    assessment.status === "available" &&
    assessment.result.verdict !== "duplicate" &&
    assessment.result.verdict !== "not_required"
      ? assessment.result.references
      : undefined;
  const evidence = createPersonalReminderResponseEvidence(
    [...cause.evidenceSourceIds, ...(assessmentReferences?.sourceIds ?? [])],
    assessmentReferences,
    currentSourceItem,
    allSourceItems,
    sourceOwnersById,
    evidenceBySourceId,
  );
  const hasCurrentAssessmentEvidence =
    assessmentReferences != null && assessmentReferences.sourceIds.length > 0;
  const unverifiedValues = createPersonalReminderUnverifiedValues(
    cause,
    assessment,
    hasCurrentAssessmentEvidence,
  );
  const subjectMembershipUnverified = createPersonalReminderSubjectMembershipUnverified(
    cause,
    assessment,
  );
  const base = createPersonalReminderResponseBase(cause, evidence);
  if (assessment.status !== "available") {
    return {
      ...base,
      status: "unknown",
      reason: personalReminderUnknownReason(cause),
      unverifiedValues,
      subjectMembershipUnverified,
    };
  }
  switch (assessment.result.verdict) {
    case "actionable":
      return {
        ...base,
        status: "actionable",
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "waiting":
      return {
        ...base,
        status: "waiting",
        waitingFor: {
          itemNodeId: assessment.result.waitingFor.itemNodeId,
          action: assessment.result.waitingFor.action,
        },
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "unknown":
      return {
        ...base,
        status: "unknown",
        reason: assessment.result.reason,
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "duplicate":
    case "not_required":
      return undefined;
  }
}

/** 個人催促の計画状態を公開値へ写す。 */
export function personalReminderCausePlanningStatus(
  item: StateSnapshot["items"][number],
): PublicPersonalReminderCausePlanningStatus {
  if (
    item.personalReminderCausePlanning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    return "pending";
  }
  return item.personalReminderCausePlanning.status;
}

/** 個人催促の現在応答を公開値へ写す。 */
export function createPersonalReminderResponses(
  item: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
  evidenceBySourceId: EvidenceBySourceId,
): PublicPersonalReminderResponses {
  const planning = item.personalReminderCausePlanning;
  if (
    planning.status !== "completed" ||
    planning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    const currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto = {
      scope: "bounded",
      addableSubjects: [],
      removableSubjects: [],
    };
    return Object.freeze({
      responses: Object.freeze([]),
      currentResponsesUnverified: false,
      currentResponseSubjectChanges,
    });
  }
  const responses: PublicPersonalReminderResponse[] = [];
  let currentResponsesUnverified = isUnverifiedAiDependency(planning.causeSetAiDependency);
  const subjectChanges = createPublicCurrentResponseSubjectChangesAccumulator(
    planning.causeSetSubjectChanges,
  );
  for (const cause of item.personalReminderCauses) {
    const assessment = currentPersonalReminderAssessment(cause);
    const responseMembershipUnverified = personalReminderResponseMembershipUnverified(
      cause,
      assessment,
    );
    if (responseMembershipUnverified) {
      currentResponsesUnverified = true;
    }
    const response = createPersonalReminderResponse(
      cause,
      assessment,
      item,
      allSourceItems,
      sourceOwnersById,
      evidenceBySourceId,
    );
    if (response != null) {
      responses.push(response);
      if (response.subjectMembershipUnverified) {
        addResponsibleCurrentResponseSubjectChanges(subjectChanges, "removable", cause.responsible);
      }
      if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
        subjectChanges.unbounded = true;
      }
      continue;
    }
    if (responseMembershipUnverified) {
      addResponsibleCurrentResponseSubjectChanges(subjectChanges, "addable", cause.responsible);
      if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
        subjectChanges.unbounded = true;
      }
    }
  }
  const sortedResponses = responses.sort((left, right) =>
    compareStrings(left.causeId, right.causeId),
  );
  return Object.freeze({
    responses: Object.freeze(sortedResponses),
    currentResponsesUnverified,
    currentResponseSubjectChanges: finalizePublicCurrentResponseSubjectChanges(
      subjectChanges,
      sortedResponses,
    ),
  });
}

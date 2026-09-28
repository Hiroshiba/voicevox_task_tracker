import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PersonalReminderAiSourceContext,
  PersonalReminderEvidenceRole,
} from "../../../codex/personal-reminder-input-contracts.js";
import type {
  AiAnalysisDependency,
  AiAnalysisDependencyInput,
  AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import { combineReconciledAiAnalysisDependencies } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCauseSeed,
  PersonalReminderCauseSetSubjectChanges,
  PersonalReminderSubject,
} from "../../../domain/personal-reminder-causes.js";
import { personalReminderCauseSetSubjectChangesAreUnbounded } from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseDraft,
  PersonalReminderItem,
  PersonalReminderLocalDecision,
  PreviousPersonalReminderCauses,
} from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type {
  Evidence,
  GitHubNodeId,
  NormalizedEvent,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import type { GitHubDetailActor, GitHubItemDetail } from "../../../github/item-detail-types.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  PersonalReminderRuntimeCauseSetSubjectChangeInput,
  PersonalReminderRuntimeCollectedItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeItem,
  PersonalReminderRuntimeLocalDecision,
  PersonalReminderRuntimeSource,
  PersonalReminderRuntimeState,
} from "./personal-reminder-runtime-contracts.js";

/** 文字列を安定した順序で比較する。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 根拠記録の同一性を比較するための値を作る。 */
export function evidenceIdentity(evidence: Evidence): string {
  return serializeCanonicalJson(evidence);
}

/** source IDを安定した順序で比較する。 */
export function compareSourceIds(left: SourceId, right: SourceId): number {
  return compareStrings(left, right);
}

/** 原因候補の責務同一性を表す値を作る。 */
export function personalReminderDraftIdentity(draft: PersonalReminderCauseDraft): string {
  return serializeCanonicalJson([draft.itemNodeId, draft.action.kind, draft.responsible]);
}

/** 原因seedが今回の候補と同じ責務か判定する。 */
export function seedMatchesDraft(
  seed: PersonalReminderCauseSeed,
  draft: PersonalReminderCauseDraft,
): boolean {
  return (
    seed.itemNodeId === draft.itemNodeId &&
    seed.reasonCode === draft.reasonCode &&
    seed.action.kind === draft.action.kind &&
    seed.action.summary === draft.action.summary &&
    serializeCanonicalJson(seed.responsible) === serializeCanonicalJson(draft.responsible) &&
    serializeCanonicalJson(seed.responsibility) === serializeCanonicalJson(draft.responsibility)
  );
}

/** AI依存が未検証の値を含むか判定する。 */
export function aiAnalysisDependencyIsUnverified(dependency: AiAnalysisDependency): boolean {
  return dependency.status === "unverified" || dependency.status === "unknown";
}

/** 今回のAI依存を統合入力へ変換する。 */
export function currentAiDependencyInput(
  dependency: AiAnalysisDependency,
): AiAnalysisDependencyInput {
  return Object.freeze({ origin: "current", dependency, relationCandidateAssessment: "graph" });
}

/** 前回のAI依存を統合入力へ変換する。 */
export function retainedAiDependencyInput(
  dependency: AiAnalysisDependency,
): AiAnalysisDependencyInput {
  return Object.freeze({ origin: "retained", dependency });
}

/** 原因seedの由来に応じてAI依存を統合入力へ変換する。 */
export function seedAiDependencyInput(
  dependency: AiAnalysisDependency,
  origin: PersonalReminderRuntimeCurrentSeed["origin"],
): AiAnalysisDependencyInput {
  return origin === "current_draft"
    ? currentAiDependencyInput(dependency)
    : retainedAiDependencyInput(dependency);
}

/** 原因集合の存在と候補からAI依存を合成する。 */
export function combineCauseSetAiDependency(
  inputs: readonly AiAnalysisDependencyInput[],
  presenceInputs: readonly AiAnalysisDependencyInput[],
  context: AiAnalysisDependencyReconciliationContext,
): AiAnalysisDependency {
  const dependency = combineReconciledAiAnalysisDependencies(inputs, context);
  if (
    dependency.status === "unknown" &&
    dependency.reasons.includes("not_recorded") &&
    dependency.producers == null
  ) {
    return combineReconciledAiAnalysisDependencies(
      [retainedAiDependencyInput(dependency), ...presenceInputs],
      context,
    );
  }
  return dependency;
}

function personalReminderSubjectKey(subject: PersonalReminderSubject): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function normalizePersonalReminderSubjects(
  subjects: readonly PersonalReminderSubject[],
): PersonalReminderSubject[] {
  const subjectsByKey = new Map<string, PersonalReminderSubject>();
  for (const subject of subjects) {
    const key = personalReminderSubjectKey(subject);
    const existing = subjectsByKey.get(key);
    if (existing == null || compareStrings(subject.candidateId, existing.candidateId) < 0) {
      subjectsByKey.set(key, subject);
    }
  }
  return [...subjectsByKey.values()].sort((left, right) =>
    compareStrings(personalReminderSubjectKey(left), personalReminderSubjectKey(right)),
  );
}

/** 原因集合が変わり得る主体を確定する。 */
export function createCauseSetSubjectChanges(
  dependency: AiAnalysisDependency,
  input: PersonalReminderRuntimeCauseSetSubjectChangeInput,
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCauseSetSubjectChanges {
  if (
    personalReminderCauseSetSubjectChangesAreUnbounded({
      causeSetDependency: dependency,
      presenceDependency: combineReconciledAiAnalysisDependencies(input.presenceInputs, context),
      negativeCandidateSubjectCount: input.negativeCandidateSubjectCount,
      inputUnbounded: input.unbounded,
    })
  ) {
    return Object.freeze({ scope: "unbounded" });
  }
  if (!aiAnalysisDependencyIsUnverified(dependency)) {
    return Object.freeze({
      scope: "bounded",
      addableSubjects: [],
      removableSubjects: [],
    });
  }
  const addableSubjects = normalizePersonalReminderSubjects(input.addableSubjects);
  const removableSubjects = normalizePersonalReminderSubjects(input.removableSubjects);
  return Object.freeze({
    scope: "bounded",
    addableSubjects,
    removableSubjects,
  });
}

/** source IDを重複なく並べて非空配列にする。 */
export function createNonEmptySourceIds(
  sourceIds: readonly SourceId[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const first = uniqueSourceIds[0];
  assertNonNullable(first, `${context}のsource IDがありません`);
  return Object.freeze([first, ...uniqueSourceIds.slice(1)]);
}

/** 対象項目に対応する前回原因を取得する。 */
export function createPreviousCauses(
  state: PersonalReminderRuntimeState,
  item: PersonalReminderRuntimeCollectedItem,
): PreviousPersonalReminderCauses {
  const previous = state.previousCausesByNodeId.get(item.item.nodeId);
  if (previous != null) {
    return previous;
  }
  return Object.freeze({ observedAt: item.item.createdAt, causes: Object.freeze([]) });
}

/** 項目種別付きのlocal decisionを取り出す。 */
export function determineLocalDecision(
  input: PersonalReminderRuntimeLocalDecision,
): PersonalReminderLocalDecision {
  if (input.itemType === "issue") {
    return input.value;
  }
  return input.value;
}

/** 関連項目のlocal decision種別を検証する。 */
export function validateLocalDecision(
  itemType: PersonalReminderRuntimeItem["type"],
  localDecision: PersonalReminderRuntimeLocalDecision | undefined,
  context: string,
): boolean {
  if (localDecision == null) {
    return false;
  }
  if (localDecision.itemType !== itemType) {
    throw new TypeError(`${context}のlocal decision種別が一致しません`);
  }
  return true;
}

/** 収集項目と詳細の対応を検証する。 */
export function validateCollectedItem(item: PersonalReminderRuntimeCollectedItem): void {
  if (item.detail.nodeId !== item.item.nodeId || item.detail.type !== item.item.type) {
    throw new TypeError(`個人催促runtimeのitemとdetailが一致しません。対象: ${item.item.nodeId}`);
  }
  if (item.repositoryFullName.length === 0) {
    throw new TypeError("個人催促runtimeのrepository full nameは空にできません");
  }
  if (item.completeness.status === "incomplete" && item.completeness.missing.length === 0) {
    throw new TypeError("不完全な個人催促runtime入力には不足項目が必要です");
  }
}

/** 項目作成者のactor種別を取得する。 */
export function actorTypeForItem(item: PersonalReminderItem): "human" | "bot" | "system" {
  if (item.author.status === "unavailable") {
    return "system";
  }
  return item.author.actor.type;
}

/** 項目作成者の候補IDを取得する。 */
export function actorCandidateId(actor: PersonalReminderItem["author"]): string | undefined {
  if (actor.status === "unavailable") {
    return undefined;
  }
  return actor.actor.login;
}

/** event実行者のactor種別を取得する。 */
export function eventActorType(event: NormalizedEvent): "human" | "bot" | "system" {
  return event.actor.type;
}

/** event実行者の候補IDを取得する。 */
export function eventActorCandidateId(event: NormalizedEvent): string | undefined {
  return event.actor.type === "system" ? undefined : event.actor.login;
}

function sourceRolesForKind(
  kind: string,
): readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] {
  if (kind === "item" || kind === "body" || kind === "comment") {
    return ["obligation_candidate", "actionability"];
  }
  if (kind === "push" || kind === "commit_added") {
    return ["resolution", "actionability"];
  }
  if (kind === "relation") {
    return ["relation", "resolution"];
  }
  if (kind === "review" || kind === "review_request") {
    return ["obligation_candidate", "actionability", "resolution"];
  }
  return ["actionability", "resolution"];
}

/** 根拠sourceの役割を重複なく並べる。 */
export function createRuntimeSourceRoles(
  roles: readonly PersonalReminderEvidenceRole[],
): readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] {
  const sortedRoles = [...new Set(roles)].sort(compareStrings);
  const firstRole = sortedRoles[0];
  assertNonNullable(firstRole, "個人催促runtime sourceのroleがありません");
  return Object.freeze([firstRole, ...sortedRoles.slice(1)]);
}

/** eventからAI入力用の根拠概要を作る。 */
export function sourceSummaryForEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "review":
      return `GitHub review ${event.state} ${event.commitStatus === "available" ? event.commitSha : "commit-unavailable"}`;
    case "review_request":
      return `GitHub review request ${event.action} ${event.target.type}:${event.target.nodeId}`;
    case "assignee":
      return `GitHub assignee ${event.action} ${event.assignee.login}`;
    case "label":
      return `GitHub label ${event.action} ${event.labelName}`;
    case "state":
      return `GitHub state ${event.state}${event.state === "closed" ? `:${event.stateReason}` : ""}`;
    case "relation":
      return `GitHub relation ${event.action} ${event.relationType} ${event.direction} ${
        event.target.type === "node" ? event.target.nodeId : event.target.url
      } ${event.provenance}`;
    case "push":
      return `GitHub push ${event.forcePush ? "force" : "normal"} ${event.headCommitSha}`;
    case "comment":
      return `GitHub comment ${event.bodyEmpty ? "empty" : "body"}`;
    case "ready_for_review":
    case "converted_to_draft":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return `GitHub ${event.kind} event`;
  }
}

type PersonalReminderRuntimeReviewRequest = Extract<
  GitHubItemDetail,
  { type: "pull_request" }
>["reviewRequests"]["current"][number];

/** review requestからAI入力用の根拠概要を作る。 */
export function sourceSummaryForReviewRequest(
  request: PersonalReminderRuntimeReviewRequest,
): string {
  if ("status" in request.target) {
    return "GitHub review request target unavailable";
  }
  if (request.target.type === "user") {
    return `GitHub review request user:${request.target.login}`;
  }
  return `GitHub review request team:${request.target.organizationLogin}/${request.target.slug}`;
}

/** 同じsource IDの根拠を整合性を確認して追加する。 */
export function addRuntimeSource(
  sources: Map<SourceId, PersonalReminderRuntimeSource>,
  source: PersonalReminderRuntimeSource,
): void {
  const previous = sources.get(source.source.sourceId);
  if (previous == null) {
    sources.set(source.source.sourceId, source);
    return;
  }
  if (
    previous.source.itemNodeId !== source.source.itemNodeId ||
    previous.source.kind !== source.source.kind ||
    previous.source.actorType !== source.source.actorType ||
    previous.source.actorCandidateId !== source.source.actorCandidateId ||
    previous.source.occurredAt !== source.source.occurredAt ||
    previous.source.summary !== source.source.summary
  ) {
    throw new TypeError(
      `個人催促runtime sourceの実体が重複しています。対象: ${source.source.sourceId}`,
    );
  }
  const roles = [...new Set([...previous.roles, ...source.roles])].sort(compareStrings);
  if (roles.length === 0) {
    throw new TypeError(
      `個人催促runtime sourceのroleがありません。対象: ${source.source.sourceId}`,
    );
  }
  const firstRole = roles[0];
  assertNonNullable(
    firstRole,
    `個人催促runtime sourceのroleがありません。対象: ${source.source.sourceId}`,
  );
  const roleTuple: readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] = [
    firstRole,
    ...roles.slice(1),
  ];
  sources.set(
    source.source.sourceId,
    Object.freeze({
      source: previous.source,
      roles: Object.freeze(roleTuple),
      evidence: Object.freeze(
        [
          ...new Map(
            [...previous.evidence, ...source.evidence].map((value) => [
              evidenceIdentity(value),
              value,
            ]),
          ).values(),
        ].sort((left, right) => compareStrings(evidenceIdentity(left), evidenceIdentity(right))),
      ),
      causalPush: previous.causalPush || source.causalPush,
    }),
  );
}

/** GitHub sourceを原因計画用の根拠に投影する。 */
export function sourceContext(
  itemNodeId: GitHubNodeId,
  sourceId: SourceId,
  kind: string,
  actorType: "human" | "bot" | "system",
  actorCandidate: string | undefined,
  occurredAt: UtcIsoDateTime,
  summary: string,
  causalPush: boolean,
): PersonalReminderRuntimeSource {
  const roles = sourceRolesForKind(kind);
  const source: PersonalReminderAiSourceContext = {
    sourceId,
    itemNodeId,
    kind,
    actorType,
    ...(actorCandidate == null ? {} : { actorCandidateId: actorCandidate }),
    occurredAt,
    summary,
  };
  return Object.freeze({
    source: Object.freeze(source),
    roles: Object.freeze(roles),
    evidence: Object.freeze([]),
    causalPush,
  });
}

/** 詳細記録の実行者のactor種別を取得する。 */
export function detailActorType(actor: GitHubDetailActor): "human" | "bot" | "system" {
  if (actor.status === "unavailable") {
    return "system";
  }
  return actor.account.apiType === "Bot" ? "bot" : "human";
}

/** 詳細記録の実行者の候補IDを取得する。 */
export function detailActorCandidateId(actor: GitHubDetailActor): string | undefined {
  return actor.status === "identified" ? actor.account.login : undefined;
}

import type { CanonicalPersonalReminderCausePlan } from "../../../application/tracking-run/stages/personal-reminder-plan-contracts.js";
import type { PersonalReminderPlannedRun } from "../../../application/tracking-run/stages/personal-reminder-plan.js";
import type { PersonalReminderCauseRuntimePlan } from "../../../application/tracking-run/stages/personal-reminder-runtime-contracts.js";
import type { PersonalReminderAiEvaluationCandidate } from "../../../codex/personal-reminder-runner.js";
import {
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  personalReminderCauseSchema,
} from "../../../domain/personal-reminder-causes.js";
import { assertNonNullable } from "../../../util/index.js";

/** 確定済み原因計画を未移行の採用処理が使う索引へ投影する。 */
export function projectLegacyPersonalReminderCausePlan(
  plan: CanonicalPersonalReminderCausePlan,
): PersonalReminderCauseRuntimePlan {
  return Object.freeze({
    ...plan,
    entries: Object.freeze(
      plan.entries.map((entry) =>
        Object.freeze({
          ...entry,
          activity: Object.freeze({
            ...entry.activity,
            actionabilityStartByAction: new Map(entry.activity.actionabilityStartByAction),
          }),
        }),
      ),
    ),
    preservedEvidenceByNodeId: new Map(plan.preservedEvidenceByNodeId),
    incompleteInputNodeIds: new Set(plan.incompleteInputNodeIds),
    deferredStructuralEndNodeIds: new Set(plan.deferredStructuralEndNodeIds),
    unrecordedDependencyNodeIds: new Set(plan.unrecordedDependencyNodeIds),
    causeSetAiDependencyByNodeId: new Map(plan.causeSetAiDependencyByNodeId),
    causeSetSubjectChangesByNodeId: new Map(plan.causeSetSubjectChangesByNodeId),
  });
}

/** 計画済みの実行原因だけを未移行runnerの入力shapeへ投影する。 */
export function projectLegacyPersonalReminderExecutionCandidates(
  planned: PersonalReminderPlannedRun,
): readonly PersonalReminderAiEvaluationCandidate[] {
  const entries = new Map(
    planned.data.plan.causePlan.entries.map((entry) => [entry.seed.causeId, entry]),
  );
  return Object.freeze(
    planned.data.plan.causes.flatMap((decision) => {
      if (decision.choice !== "execute") {
        return [];
      }
      const entry = entries.get(decision.causeId);
      assertNonNullable(entry, `個人催促の実行予定原因がありません。対象: ${decision.causeId}`);
      const cause =
        entry.previousCause ??
        personalReminderCauseSchema.parse({
          ...entry.seed,
          responseMembershipAssessmentRequirement: entry.responseMembershipAssessmentRequirement,
          currentInput: {
            fingerprint: decision.fingerprint,
            rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
            completeness: decision.exactInput.completeness,
            aiDependency: entry.currentInputAiDependency,
          },
          latestAttempt: { status: "not_evaluated" },
          adoptedAssessment: { status: "not_available" },
          actionableClock: { status: "not_observed" },
        });
      return [
        Object.freeze({
          cause,
          input: decision.exactInput,
          inputFingerprint: decision.fingerprint,
          priority: decision.priority,
        }),
      ];
    }),
  );
}

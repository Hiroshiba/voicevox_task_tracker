import type { CanonicalPersonalReminderCausePlan } from "../../../application/tracking-run/stages/personal-reminder-plan-contracts.js";
import type { PersonalReminderCauseRuntimePlan } from "../../../application/tracking-run/stages/personal-reminder-runtime-contracts.js";

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

import type { PersonalReminderFinalizedRun } from "../../../application/tracking-run/stages/personal-reminder-finalization.js";
import type { PersonalReminderAnalysisResult } from "../../personal-reminder/analysis-result.js";

/** 確定済みrunの項目結果だけを未移行の公開処理へ写す。 */
export function projectLegacyPersonalReminderFinalization(
  finalized: PersonalReminderFinalizedRun,
): PersonalReminderAnalysisResult {
  return Object.freeze({
    itemsByNodeId: new Map(
      finalized.data.items.map((item) => [
        item.item.nodeId,
        Object.freeze({
          itemNodeId: item.item.nodeId,
          causeResults: Object.freeze(
            item.causeResults.map(({ cause, staleness }) => Object.freeze({ cause, staleness })),
          ),
          evidence: item.evidence,
          planning: item.planning,
        }),
      ]),
    ),
  });
}

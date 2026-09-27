import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { GraphFinalItem } from "../../../application/tracking-run/stages/graph-reconciliation-contracts.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { Evidence } from "../../../domain/index.js";
import { requirePersonalReminderAnalyzedItem } from "../../personal-reminder/index.js";
import type { PersonalReminderAnalysis } from "../contracts.js";

/** 最終項目値に個人催促の根拠と原因を重ねる。 */
export function snapshotItems(
  reconciled: GraphReconciledRun,
  personalReminderAnalysis: PersonalReminderAnalysis,
): readonly GraphFinalItem[] {
  return Object.freeze(
    reconciled.data.finalItems.map((item) => {
      const personalReminderItem = requirePersonalReminderAnalyzedItem(
        personalReminderAnalysis.result,
        item.nodeId,
      );
      const evidenceByIdentity = new Map<string, Evidence>();
      for (const evidence of [...item.evidence, ...personalReminderItem.evidence]) {
        evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
      }
      const evidence = [...evidenceByIdentity.values()].sort((left, right) => {
        const leftIdentity = serializeCanonicalJson(left);
        const rightIdentity = serializeCanonicalJson(right);
        return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
      });
      return Object.freeze({
        ...item,
        personalReminderCauses: personalReminderItem.causeResults.map(({ cause }) => cause),
        personalReminderCausePlanning: personalReminderItem.planning,
        evidence: Object.freeze(evidence),
      });
    }),
  );
}

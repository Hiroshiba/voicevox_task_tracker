import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { GraphFinalItem } from "../../../application/tracking-run/stages/graph-reconciliation-contracts.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { EvidenceClosureResult } from "../../../application/tracking-run/contracts/evidence-closure.js";
import type { Evidence } from "../../../domain/index.js";

/** 最終項目値に個人催促の根拠と原因を重ねる。 */
export function snapshotItems(
  reconciled: GraphReconciledRun,
  closure: EvidenceClosureResult,
): readonly GraphFinalItem[] {
  const entries = new Map(closure.outward.items.map((entry) => [entry.item.nodeId, entry]));
  if (
    entries.size !== closure.outward.items.length ||
    entries.size !== reconciled.data.finalItems.length
  ) {
    throw new TypeError("閉包済み項目とgraph最終項目の集合が一致しません");
  }
  return Object.freeze(
    reconciled.data.finalItems.map((item) => {
      const entry = entries.get(item.nodeId);
      const { personalReminderCauses, personalReminderCausePlanning, ...sourceItem } = item;
      void personalReminderCauses;
      void personalReminderCausePlanning;
      if (
        entry == null ||
        serializeCanonicalJson(entry.item) !== serializeCanonicalJson(sourceItem)
      ) {
        throw new TypeError(`閉包済み項目とgraph最終項目が一致しません。対象: ${item.nodeId}`);
      }
      const evidenceByIdentity = new Map<string, Evidence>();
      for (const evidence of [...entry.item.evidence, ...entry.evidence]) {
        evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
      }
      const evidence = [...evidenceByIdentity.values()].sort((left, right) => {
        const leftIdentity = serializeCanonicalJson(left);
        const rightIdentity = serializeCanonicalJson(right);
        return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
      });
      return Object.freeze({
        ...item,
        personalReminderCauses: entry.causeResults.map(({ cause }) => cause),
        personalReminderCausePlanning: entry.planning,
        evidence: Object.freeze(evidence),
      });
    }),
  );
}

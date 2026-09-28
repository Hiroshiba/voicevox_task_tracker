import type { Evidence, SourceId } from "../../../domain/index.js";
import {
  createPersonalReminderEvidenceSourceIndex,
  type StateSnapshot,
} from "../../../persistence/index.js";
import type { PersonalReminderRuntimeState } from "../../../application/tracking-run/stages/personal-reminder-runtime-contracts.js";
import type { RuntimeState } from "../contracts.js";
import { previousSnapshot } from "../previous-state/snapshot.js";

function previousPersonalReminderEvidenceBySourceId(
  snapshot: StateSnapshot | undefined,
): ReadonlyMap<SourceId, readonly Evidence[]> {
  return createPersonalReminderEvidenceSourceIndex([
    ...(snapshot?.items.map((item) => item.evidence) ?? []),
    ...(snapshot?.relations.map((relation) => relation.evidence) ?? []),
  ]);
}

/** 前回snapshotの原因と根拠を後段の最終化へ渡す。 */
export function personalReminderPreviousState(state: RuntimeState): PersonalReminderRuntimeState {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return Object.freeze({
      previousCausesByNodeId: new Map(),
      previousEvidenceByNodeId: new Map(),
      previousEvidenceBySourceId: new Map(),
    });
  }
  return Object.freeze({
    previousCausesByNodeId: new Map(
      snapshot.items.map((item) => [
        item.nodeId,
        Object.freeze({ observedAt: item.observedAt, causes: item.personalReminderCauses }),
      ]),
    ),
    previousEvidenceByNodeId: new Map(snapshot.items.map((item) => [item.nodeId, item.evidence])),
    previousEvidenceBySourceId: previousPersonalReminderEvidenceBySourceId(snapshot),
  });
}

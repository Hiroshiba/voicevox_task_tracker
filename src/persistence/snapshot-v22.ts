import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotSchema from "../../schemas/snapshot-v22.schema.json" with { type: "json" };
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/index.js";
import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../domain/personal-reminder-causes.js";
import type { SourceId } from "../domain/source-id.js";
import type { Evidence, GraphNodeId, TrackedItemState } from "../domain/types.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import { createPersonalReminderEvidenceSourceIndex } from "./snapshot-evidence-closure.js";
import {
  assertPersonalReminderEvidenceClosure as assertVersion21EvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure as assertVersion21EvidenceRecordsClosure,
  createStateSnapshot as createVersion21Snapshot,
  snapshotEffectiveGraphStateByNodeId as version21EffectiveGraphStateByNodeId,
  version19SnapshotFields as version21ToVersion19Fields,
  type StateSnapshot as StateSnapshotVersion21,
} from "./snapshot-v21.js";

/** tracker-stateへ保存するschema version 22のcurrent snapshot。 */
export type StateSnapshot = Omit<StateSnapshotVersion21, "schemaVersion"> &
  Readonly<{ schemaVersion: "22" }>;

const snapshotVersionSchema = z.object({ schemaVersion: z.literal("22") });
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value)),
});
const validateSnapshotSchema = ajv.compile<StateSnapshot>(snapshotSchema);

function version21Basis(basis: PersonalReminderTimeBasis): PersonalReminderTimeBasis {
  if (basis.source === "reconfirmation_pending" || basis.source === "reconfirmed_observation") {
    return Object.freeze({ source: "first_observation", at: basis.at });
  }
  return basis;
}

function version21Cause(cause: PersonalReminderCause): PersonalReminderCause {
  return Object.freeze({
    ...cause,
    obligationSince: version21Basis(cause.obligationSince),
    actionableClock:
      cause.actionableClock.status === "not_observed"
        ? cause.actionableClock
        : Object.freeze({
            ...cause.actionableClock,
            actionableSince: version21Basis(cause.actionableClock.actionableSince),
            stallSince: version21Basis(cause.actionableClock.stallSince),
            basis:
              cause.actionableClock.basis === "reconfirmed_observation"
                ? "first_observation"
                : cause.actionableClock.basis,
          }),
  });
}

function version21Projection(snapshot: StateSnapshot): StateSnapshotVersion21 {
  return Object.freeze({
    ...snapshot,
    schemaVersion: "21",
    items: Object.freeze(
      snapshot.items.map((item) =>
        Object.freeze({
          ...item,
          personalReminderCauses: Object.freeze(item.personalReminderCauses.map(version21Cause)),
        }),
      ),
    ),
  });
}

function assertNoPendingClock(snapshot: StateSnapshot): void {
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      if (bases.some((basis) => basis.source === "reconfirmation_pending")) {
        throw new StateSnapshotSemanticError(
          `個人催促時計の再確認が完了していません。item: ${item.nodeId} cause: ${cause.causeId}`,
        );
      }
    }
  }
}

function assertReconfirmedEvidence(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  for (const item of snapshot.items) {
    const itemEvidence = new Set(item.evidence.map(serializeCanonicalJson));
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      for (const basis of bases) {
        if (basis.source !== "reconfirmed_observation") continue;
        for (const sourceId of basis.sourceIds) {
          const expected = expectedEvidenceBySourceId.get(sourceId) ?? [];
          if (
            expected.length === 0 ||
            expected.some((evidence) => !itemEvidence.has(serializeCanonicalJson(evidence)))
          ) {
            throw new StateSnapshotSemanticError(
              `再確認した個人催促時計のEvidenceがありません。item: ${item.nodeId} cause: ${cause.causeId} source: ${sourceId}`,
            );
          }
        }
      }
    }
  }
}

/** 未検証の値をschema検証済みの現行snapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  snapshotVersionSchema.parse(value);
  if (!validateSnapshotSchema(value)) {
    throw new StateSnapshotSchemaError(validateSnapshotSchema.errors?.length ?? 1);
  }
  const legacy = createVersion21Snapshot(version21Projection(value));
  const causesByNodeId = new Map(
    value.items.map((item) => [item.nodeId, item.personalReminderCauses]),
  );
  const snapshot = Object.freeze({
    ...legacy,
    schemaVersion: "22",
    items: Object.freeze(
      legacy.items.map((item) => {
        const causes = causesByNodeId.get(item.nodeId);
        if (causes == null) throw new StateSnapshotSchemaError(1);
        return Object.freeze({ ...item, personalReminderCauses: causes });
      }),
    ),
  } satisfies StateSnapshot);
  return snapshot;
}

/** 現行snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  const validated = createStateSnapshot(snapshot);
  assertNoPendingClock(validated);
  return serializeCanonicalJsonLine(validated);
}

/** canonical JSONから現行snapshotを検証して読み取る。 */
export function parseStateSnapshot(source: string): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  const snapshot = createStateSnapshot(value);
  assertNoPendingClock(snapshot);
  return snapshot;
}

/** 旧schemaで検証する境界だけへ個人催促時計を射影する。 */
export function version19SnapshotFields(
  snapshot: StateSnapshot,
): ReturnType<typeof version21ToVersion19Fields> {
  return version21ToVersion19Fields(createVersion21Snapshot(version21Projection(snapshot)));
}

/** 保存済み公開投影に含まれるeffective graph状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  return version21EffectiveGraphStateByNodeId(version21Projection(snapshot));
}

/** personal reminderのEvidence参照が現行snapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  assertNoPendingClock(snapshot);
  assertVersion21EvidenceClosure(createVersion21Snapshot(version21Projection(snapshot)));
  assertReconfirmedEvidence(
    snapshot,
    createPersonalReminderEvidenceSourceIndex([
      ...snapshot.items.map((item) => item.evidence),
      ...snapshot.relations.map((relation) => relation.evidence),
    ]),
  );
}

/** personal reminderのEvidence recordを現行snapshot内で照合する。 */
export function assertPersonalReminderEvidenceRecordsClosure(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  assertNoPendingClock(snapshot);
  assertVersion21EvidenceRecordsClosure(
    createVersion21Snapshot(version21Projection(snapshot)),
    expectedEvidenceBySourceId,
  );
  assertReconfirmedEvidence(snapshot, expectedEvidenceBySourceId);
}

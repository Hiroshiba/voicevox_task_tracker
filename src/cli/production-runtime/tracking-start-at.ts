import type { Config } from "../../config/index.js";
import type { TrackingStartAtState, UtcIsoDateTime } from "../../domain/index.js";
import { resolveConfiguredTrackingStartAt } from "../../application/tracking-run/stages/collection-tracking-request.js";
import type { StateSnapshot } from "../../persistence/index.js";
import type { RuntimeConfiguration, RuntimeState } from "./contracts.js";
import { previousSnapshot } from "./previous-state/snapshot.js";

export function pendingSnapshotTrackingStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  evaluatedAt: UtcIsoDateTime,
): TrackingStartAtState {
  return resolveConfiguredTrackingStartAt(
    configuration.config,
    previousSnapshot(state)?.trackingStartAt ??
      Object.freeze({
        status: "not_fixed",
      }),
    Object.freeze({
      outcome: "incomplete",
      finishedAt: evaluatedAt,
    }),
  );
}

export function completedSnapshotTrackingStartAt(
  config: Config,
  snapshot: StateSnapshot,
  completedAt: UtcIsoDateTime,
): TrackingStartAtState {
  const resolved = resolveConfiguredTrackingStartAt(
    config,
    snapshot.trackingStartAt,
    Object.freeze({
      outcome: "complete_success",
      finishedAt: completedAt,
    }),
  );
  if (resolved.status !== "fixed") {
    throw new TypeError("完全成功したrunでtracking.startAtを確定できませんでした");
  }
  return resolved;
}

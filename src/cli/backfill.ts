import { type TrackingBackfillCursor, type TrackingBackfillRequest } from "../domain/index.js";
import { type OnlineCliCommand } from "./daily-transaction.js";

/** onlineサブコマンドを追跡選定へ渡すbackfill要求へ変換する。 */
export function createTrackingBackfillRequest(
  command: OnlineCliCommand,
  cursor: TrackingBackfillCursor,
): TrackingBackfillRequest {
  if (command.kind !== "backfill" || command.mode === "none") {
    return Object.freeze({
      mode: "none",
    });
  }
  return Object.freeze({
    mode: command.mode,
    repositoryFilter: Object.freeze([...command.repositoryFilter]),
    cursor,
  });
}

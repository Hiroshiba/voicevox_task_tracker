import { TaskTrackerError } from "./task-tracker-error.js";

/** 到達不能な分岐へ到達したことを表す。 */
export class UnreachableError extends TaskTrackerError {
  public constructor(value: never) {
    super(`到達不能な値を受け取りました: ${String(value)}`, {});
  }
}

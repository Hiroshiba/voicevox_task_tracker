import { type Status, type TerminalStatus } from "./types.js";

/** statusが人の対応を必要としない終了状態か判定する。 */
export function isTerminalStatus(status: Status): status is TerminalStatus {
  switch (status) {
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return true;
    case "new_untriaged":
    case "needs_maintainer_decision":
    case "waiting_for_review":
    case "waiting_for_author":
    case "waiting_for_assignee":
    case "blocked":
    case "waiting_for_automation":
    case "ready_to_merge":
    case "in_progress":
    case "unknown":
      return false;
  }
}

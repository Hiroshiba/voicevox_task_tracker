import { summarizeAiBudgetLedger } from "../../../application/tracking-run/contracts/ai-budget-ledger.js";
import type { PersonalReminderExecutedRun } from "../../../application/tracking-run/stages/personal-reminder-execution.js";
import type { PersonalReminderPlannedRun } from "../../../application/tracking-run/stages/personal-reminder-plan.js";
import type {
  PersonalReminderAiCauseRunOutcome,
  PersonalReminderAiRunResult,
} from "../../../codex/personal-reminder-runner.js";
import type { PersonalReminderCauseId } from "../../../domain/personal-reminder-causes.js";

/** 原因別実行結果を未移行の採用処理へ一方向に投影する。 */
export function projectLegacyPersonalReminderExecution(
  planned: PersonalReminderPlannedRun,
  executed: PersonalReminderExecutedRun,
): PersonalReminderAiRunResult {
  const outcomesByCauseId = new Map<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>();
  for (const outcome of executed.data.outcomes) {
    if (outcome.status === "completed" || outcome.status === "cache_hit") {
      outcomesByCauseId.set(
        outcome.cause.causeId,
        Object.freeze({
          status: "accepted",
          origin: outcome.status === "completed" ? "executed" : "cache",
          generation: outcome.generation,
        }),
      );
    } else if (outcome.status === "failed") {
      outcomesByCauseId.set(
        outcome.cause.causeId,
        Object.freeze({ status: "failed", reason: outcome.reason }),
      );
    } else if (
      outcome.status === "deferred" &&
      outcome.reason !== "ai_disabled" &&
      outcome.reason !== "forced_generic_target"
    ) {
      outcomesByCauseId.set(
        outcome.cause.causeId,
        Object.freeze({ status: "deferred", reason: outcome.reason }),
      );
    }
  }
  const summary = summarizeAiBudgetLedger(executed.core.aiBudget);
  const newEvents = executed.core.aiBudget.events.filter(
    (event) => event.sequence > planned.core.aiBudget.sequence && event.action === "consumed",
  );
  return Object.freeze({
    outcomesByCauseId,
    usage: Object.freeze({
      calls: summary.logicalCandidateCount + summary.authenticationPreflightAttemptCount,
      inputCharacters: summary.inputCharacters,
      estimatedCostUsd: summary.estimatedCostUsd,
    }),
    executedBatchCount: newEvents.filter((event) => event.reservation.kind === "personal_initial")
      .length,
    cacheHitCauseCount: executed.data.outcomes.filter((outcome) => outcome.status === "cache_hit")
      .length,
    authenticationPreflightExecuted: newEvents.some(
      (event) => event.reservation.kind === "authentication_preflight",
    ),
  });
}

import type { AiAnalysisRunResult } from "../../../codex/analysis-runner.js";
import {
  summarizeAiBudgetLedger,
  type AiBudgetLedgerSnapshot,
} from "../contracts/ai-budget-ledger.js";
import { createGenericAiExecutedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type { GenericAiItemPlan, GenericAiPlannedRun } from "./generic-ai-plan.js";

/** 一つの計画項目に対応する汎用AI実行結果。 */
export type GenericAiExecutionOutcome =
  | Readonly<{
      item: GenericAiItemPlan;
      status: "completed";
      result: AiAnalysisRunResult["results"][number];
    }>
  | Readonly<{
      item: GenericAiItemPlan;
      status: "failed";
      failure: AiAnalysisRunResult["failures"][number];
    }>
  | Readonly<{
      item: GenericAiItemPlan;
      status: "deferred";
      reason: AiAnalysisRunResult["deferred"][number]["reason"];
    }>
  | Readonly<{
      item: GenericAiItemPlan;
      status: "not_executed";
      reason: "ai_disabled" | "no_selected_elements";
    }>;

/** 確定済みplanと検証済み実行結果を同じledgerに結合したrun。 */
export type GenericAiExecutedRun = StageState<
  "generic_ai_executed",
  GenericAiPlannedRun["data"] &
    Readonly<{
      outcomes: readonly GenericAiExecutionOutcome[];
      run: AiAnalysisRunResult | undefined;
    }>
>;

function indexRunOutcomes(
  run: AiAnalysisRunResult,
): ReadonlyMap<string, GenericAiExecutionOutcome["status"]> {
  const values = new Map<string, GenericAiExecutionOutcome["status"]>();
  for (const result of run.results) {
    if (values.has(result.candidateId)) {
      throw new TypeError(`汎用AIの結果IDが重複しています。対象: ${result.candidateId}`);
    }
    values.set(result.candidateId, "completed");
  }
  for (const failure of run.failures) {
    if (values.has(failure.candidateId)) {
      throw new TypeError(`汎用AIの結果IDが重複しています。対象: ${failure.candidateId}`);
    }
    values.set(failure.candidateId, "failed");
  }
  for (const deferred of run.deferred) {
    if (values.has(deferred.candidateId)) {
      throw new TypeError(`汎用AIの結果IDが重複しています。対象: ${deferred.candidateId}`);
    }
    values.set(deferred.candidateId, "deferred");
  }
  for (const skipped of run.skipped) {
    if (values.has(skipped.candidateId)) {
      throw new TypeError(`汎用AIの結果IDが重複しています。対象: ${skipped.candidateId}`);
    }
    values.set(skipped.candidateId, "not_executed");
  }
  return values;
}

function outcomeForItem(
  item: GenericAiItemPlan,
  run: AiAnalysisRunResult | undefined,
): GenericAiExecutionOutcome {
  if (run == null) {
    if (item.elements.some((element) => element.selected && element.choice !== "ai_disabled")) {
      throw new TypeError(`汎用AIの選択済み要素に実行結果がありません。対象: ${item.nodeId}`);
    }
    return Object.freeze({
      item,
      status: "not_executed",
      reason: item.selectedElements.length === 0 ? "no_selected_elements" : "ai_disabled",
    });
  }
  const result = run.results.find((value) => value.candidateId === item.nodeId);
  if (result != null) {
    const expected = new Set(item.selectedElements);
    const actual = new Set(result.elements.map((element) => element.element));
    if (
      result.elements.length !== expected.size ||
      actual.size !== expected.size ||
      result.elements.some((element) => {
        const plannedElement = item.elements.find((value) => value.element === element.element);
        return (
          !expected.has(element.element) ||
          plannedElement?.inputFingerprint !== element.generation.metadata.inputFingerprint
        );
      })
    ) {
      throw new TypeError(`汎用AIの結果要素が計画と一致しません。対象: ${item.nodeId}`);
    }
    return Object.freeze({ item, status: "completed", result });
  }
  const failure = run.failures.find((value) => value.candidateId === item.nodeId);
  if (failure != null) {
    return Object.freeze({ item, status: "failed", failure });
  }
  const deferred = run.deferred.find((value) => value.candidateId === item.nodeId);
  if (deferred != null) {
    return Object.freeze({ item, status: "deferred", reason: deferred.reason });
  }
  if (
    item.selectedElements.length !== 0 ||
    !run.skipped.some((value) => value.candidateId === item.nodeId)
  ) {
    throw new TypeError(`汎用AIの計画項目に実行結果がありません。対象: ${item.nodeId}`);
  }
  return Object.freeze({ item, status: "not_executed", reason: "no_selected_elements" });
}

/** 計画、候補結果、ledgerを照合して汎用AI実行段階を確定する。 */
export function completeGenericAiExecution(
  planned: GenericAiPlannedRun,
  run: AiAnalysisRunResult | undefined,
  ledger: AiBudgetLedgerSnapshot,
): GenericAiExecutedRun {
  if (
    ledger.ledgerId !== planned.core.aiBudget.ledgerId ||
    ledger.sequence < planned.core.aiBudget.sequence
  ) {
    throw new TypeError("汎用AI実行のledgerが計画と一致しません");
  }
  if (ledger.reservations.length !== 0) {
    throw new TypeError("汎用AI実行後に未解放の予約があります");
  }
  if (run != null) {
    const summary = summarizeAiBudgetLedger(ledger);
    if (
      run.usage.calls !==
        summary.logicalCandidateCount + summary.authenticationPreflightAttemptCount ||
      run.usage.inputCharacters !== summary.inputCharacters ||
      run.usage.estimatedCostUsd !== summary.estimatedCostUsd
    ) {
      throw new TypeError("汎用AIの利用量がledgerと一致しません");
    }
    const indexed = indexRunOutcomes(run);
    const plannedIds = new Set<string>(planned.data.plan.items.map((item) => item.nodeId));
    if (indexed.size !== plannedIds.size || [...indexed.keys()].some((id) => !plannedIds.has(id))) {
      throw new TypeError("汎用AIの結果項目集合が計画と一致しません");
    }
  }
  const outcomes = Object.freeze(planned.data.plan.items.map((item) => outcomeForItem(item, run)));
  return Object.freeze({
    stage: "generic_ai_executed",
    core: Object.freeze({ ...planned.core, aiBudget: ledger }),
    data: Object.freeze({ ...planned.data, outcomes, run }),
    proof: createGenericAiExecutedStageProof(),
  });
}

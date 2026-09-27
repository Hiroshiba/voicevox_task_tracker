import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { Config } from "../../../config/schema.js";
import type { StageProofFor } from "./proofs.js";
import type { AnalysisPreviousState } from "./previous-state.js";
import type { RunExecutionPolicy, RunIdentity } from "../request.js";
import type { AiBudgetLedgerSnapshot } from "./ai-budget-ledger.js";

/** 固定したstate branchの先頭revision。 */
export type BaseStateRevision =
  Readonly<{ status: "missing" }> | Readonly<{ status: "present"; revision: string }>;

/** 固定revisionから現行形式へ正規化した前回state。 */
export type PreparedBaseState = Readonly<{
  revision: BaseStateRevision;
  snapshot:
    | Readonly<{ status: "missing_branch" | "operations_only" }>
    | Readonly<{ status: "available"; snapshot: object }>;
  history: readonly Readonly<{ events: readonly unknown[] }>[];
  aiCache: AnalysisPreviousState["aiCache"];
  personalReminderAiCache: AnalysisPreviousState["personalReminderAiCache"];
  notificationLedger: AnalysisPreviousState["notificationLedger"];
  previousState: AnalysisPreviousState;
}>;

/** run開始時に固定するAI予算の初期残量。 */
export type InitialAiBudgetLedger = AiBudgetLedgerSnapshot & Readonly<{ sequence: 0 }>;

/** 前処理で確定しinventory遷移まで保持する値。 */
export type PreparedRunCore = Readonly<{
  identity: RunIdentity;
  executionPolicy: RunExecutionPolicy;
  config: Config;
  configDigest: Sha256Hash;
  baseState: PreparedBaseState;
  aiBudget: InitialAiBudgetLedger;
}>;

/** 解析段階へ引き継ぐ設定と前回stateの必要な投影。 */
export type AnalysisRunCore = Readonly<{
  identity: RunIdentity;
  executionPolicy: RunExecutionPolicy;
  config: Config;
  configDigest: Sha256Hash;
  baseRevision: BaseStateRevision;
  aiBudget: InitialAiBudgetLedger;
  previousState: AnalysisPreviousState;
}>;

/** 汎用AI採用後のグラフ統合に必要な設定と前回観測。 */
export type GraphReconciliationInput = Readonly<{
  config: Pick<Config, "ai" | "maintainers" | "labels" | "staleness" | "importance" | "attention">;
  previousSnapshot: AnalysisPreviousState["snapshot"];
}>;

/** 汎用AI計画以後へ渡すrun識別と予算の投影。 */
export type GenericAiRunCore = Readonly<{
  identity: RunIdentity;
  executionPolicy: RunExecutionPolicy;
  configDigest: Sha256Hash;
  baseRevision: BaseStateRevision;
  aiBudget: AiBudgetLedgerSnapshot;
  graphInput: GraphReconciliationInput;
}>;

/** グラフ統合後に必要なrun識別と予算だけを持つcore。 */
export type GraphReconciledRunCore = Omit<GenericAiRunCore, "graphInput">;

/** 実装済み段階と段階ごとのcore型の唯一の対応表。 */
export type CoreByStage = Readonly<{
  prepared: PreparedRunCore;
  inventory_collected: AnalysisRunCore;
  collected: AnalysisRunCore;
  deterministically_analyzed: AnalysisRunCore;
  generic_ai_planned: GenericAiRunCore;
  generic_ai_executed: GenericAiRunCore;
  generic_ai_adopted: GenericAiRunCore;
  graph_reconciled: GraphReconciledRunCore;
}>;

/** 段階名に対応したcoreとproofを持つ成果物。 */
export type StageState<StageName extends keyof CoreByStage, StageData> = Readonly<{
  stage: StageName;
  core: CoreByStage[StageName];
  data: Readonly<StageData>;
  proof: StageProofFor<StageName>;
}>;

/** 準備済みcoreから解析に必要な値だけを投影する。 */
export function projectAnalysisRunCore(prepared: PreparedRunCore): AnalysisRunCore {
  return Object.freeze({
    identity: prepared.identity,
    executionPolicy: prepared.executionPolicy,
    config: prepared.config,
    configDigest: prepared.configDigest,
    baseRevision: prepared.baseState.revision,
    aiBudget: prepared.aiBudget,
    previousState: prepared.baseState.previousState,
  });
}

/** 汎用AI計画へ必要なrun識別と予算だけを投影する。 */
export function projectGenericAiRunCore(analyzed: AnalysisRunCore): GenericAiRunCore {
  return Object.freeze({
    identity: analyzed.identity,
    executionPolicy: analyzed.executionPolicy,
    configDigest: analyzed.configDigest,
    baseRevision: analyzed.baseRevision,
    aiBudget: analyzed.aiBudget,
    graphInput: Object.freeze({
      config: Object.freeze({
        ai: analyzed.config.ai,
        maintainers: analyzed.config.maintainers,
        labels: analyzed.config.labels,
        staleness: analyzed.config.staleness,
        importance: analyzed.config.importance,
        attention: analyzed.config.attention,
      }),
      previousSnapshot: analyzed.previousState.snapshot,
    }),
  });
}

/** グラフ統合後に不要な前回観測と設定をcoreから除く。 */
export function projectGraphReconciledRunCore(adopted: GenericAiRunCore): GraphReconciledRunCore {
  return Object.freeze({
    identity: adopted.identity,
    executionPolicy: adopted.executionPolicy,
    configDigest: adopted.configDigest,
    baseRevision: adopted.baseRevision,
    aiBudget: adopted.aiBudget,
  });
}

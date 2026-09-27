import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { Config } from "../../../config/schema.js";
import type { StageProofFor } from "./proofs.js";
import type { AnalysisPreviousState } from "./previous-state.js";
import type { RunExecutionPolicy, RunIdentity } from "../request.js";

/** 固定したstate branchの先頭revision。 */
export type BaseStateRevision =
  Readonly<{ status: "missing" }> | Readonly<{ status: "present"; revision: string }>;

/** 固定revisionから現行形式へ正規化した前回state。 */
export type PreparedBaseState = Readonly<{
  revision: BaseStateRevision;
  snapshot:
    | Readonly<{ status: "missing_branch" | "operations_only" }>
    | Readonly<{ status: "available"; snapshot: object }>;
  history: AnalysisPreviousState["history"];
  aiCache: AnalysisPreviousState["aiCache"];
  personalReminderAiCache: AnalysisPreviousState["personalReminderAiCache"];
  notificationLedger: AnalysisPreviousState["notificationLedger"];
  previousState: AnalysisPreviousState;
}>;

/** run開始時に固定するAI予算の初期残量。 */
export type InitialAiBudgetLedger = Readonly<{
  ledgerId: string;
  sequence: 0;
  maxProcessAttempts: number;
  maxInputCharacters: number;
  maxEstimatedCostUsd: number;
  consumedProcessAttempts: 0;
  consumedInputCharacters: 0;
  consumedEstimatedCostUsd: 0;
}>;

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

/** 実装済み段階と段階ごとのcore型の唯一の対応表。 */
export type CoreByStage = Readonly<{
  prepared: PreparedRunCore;
  inventory_collected: AnalysisRunCore;
  collected: AnalysisRunCore;
  deterministically_analyzed: AnalysisRunCore;
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

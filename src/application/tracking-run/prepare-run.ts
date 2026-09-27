import type { Config } from "../../config/schema.js";
import { parseSha256Hash, type Sha256Hash } from "../../canonical-json/sha256.js";
import { createPreparedStageProof, type StageProofFor } from "./contracts/proofs.js";
import {
  runIdentitySchema,
  runRequestSchema,
  type RunExecutionPolicy,
  type RunIdentity,
  type RunRequest,
} from "./request.js";

/** 固定revisionから現行形式へ正規化した前回state。 */
export type PreparedBaseStateShape = Readonly<{
  revision: Readonly<{ status: "missing" }> | Readonly<{ status: "present"; revision: string }>;
  snapshot: Readonly<{ status: "missing_branch" | "operations_only" | "available" }>;
  history: readonly object[];
  aiCache: readonly object[];
  personalReminderAiCache: readonly object[];
  notificationLedger: object;
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

/** 前処理が確定した後段共通のrun状態。 */
export type PreparedRun<BaseState extends PreparedBaseStateShape> = Readonly<{
  stage: "prepared";
  core: Readonly<{
    identity: RunIdentity;
    executionPolicy: RunExecutionPolicy;
    config: Config;
    configDigest: Sha256Hash;
    baseState: BaseState;
    aiBudget: InitialAiBudgetLedger;
  }>;
  data: Readonly<{ request: RunRequest }>;
  proof: StageProofFor<"prepared">;
}>;

/** 検証済み設定と同一revisionの前回stateからrunを準備する。 */
export function prepareRun<BaseState extends PreparedBaseStateShape>(
  input: Readonly<{
    request: RunRequest;
    identity: RunIdentity;
    config: Config;
    configDigest: Sha256Hash;
    baseState: BaseState;
  }>,
): PreparedRun<BaseState> {
  const request = runRequestSchema.parse(input.request);
  const identity = runIdentitySchema.parse(input.identity);
  parseSha256Hash(input.configDigest);
  if (
    request.invocationId !== identity.invocationId ||
    request.scheduledFor !== identity.scheduledFor ||
    request.startedAt !== identity.startedAt
  ) {
    throw new TypeError("run要求と識別情報が一致しません");
  }
  if (
    input.baseState.revision.status === "missing" &&
    (input.baseState.snapshot.status !== "missing_branch" ||
      input.baseState.history.length !== 0 ||
      input.baseState.aiCache.length !== 0 ||
      input.baseState.personalReminderAiCache.length !== 0)
  ) {
    throw new TypeError("未作成state branchの前回stateが空ではありません");
  }
  return Object.freeze({
    stage: "prepared",
    core: Object.freeze({
      identity,
      executionPolicy: request.executionPolicy,
      config: input.config,
      configDigest: input.configDigest,
      baseState: input.baseState,
      aiBudget: Object.freeze({
        ledgerId: identity.runId,
        sequence: 0,
        maxProcessAttempts: input.config.ai.budget.maxCodexExecAttemptsPerRun,
        maxInputCharacters: input.config.ai.budget.maxTotalInputCharactersPerRun,
        maxEstimatedCostUsd: input.config.ai.budget.maxEstimatedCostUsdPerRun,
        consumedProcessAttempts: 0,
        consumedInputCharacters: 0,
        consumedEstimatedCostUsd: 0,
      }),
    }),
    data: Object.freeze({ request }),
    proof: createPreparedStageProof(),
  });
}

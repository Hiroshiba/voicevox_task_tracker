import type { AnalysisRunStageName } from "./closed-values.js";

const stageProofBrand: unique symbol = Symbol("stageProof");
const runCompletenessProofBrand: unique symbol = Symbol("runCompletenessProof");
const checkpointBindingProofBrand: unique symbol = Symbol("checkpointBindingProof");
const resumeBindingProofBrand: unique symbol = Symbol("resumeBindingProof");
const receiptChainProofBrand: unique symbol = Symbol("receiptChainProof");

class StageProofToken<StageName extends AnalysisRunStageName> {
  readonly [stageProofBrand]: StageName;

  private constructor(stageName: StageName) {
    this[stageProofBrand] = stageName;
  }
}

class RunCompletenessProofToken {
  readonly [runCompletenessProofBrand]: true;

  private constructor() {
    this[runCompletenessProofBrand] = true;
  }
}

class CheckpointBindingProofToken {
  readonly [checkpointBindingProofBrand]: true;

  private constructor() {
    this[checkpointBindingProofBrand] = true;
  }
}

class ResumeBindingProofToken {
  readonly [resumeBindingProofBrand]: true;

  private constructor() {
    this[resumeBindingProofBrand] = true;
  }
}

class ReceiptChainProofToken {
  readonly [receiptChainProofBrand]: true;

  private constructor() {
    this[receiptChainProofBrand] = true;
  }
}

/** 段階ごとの検証を通過した証明。 */
export type StageProofFor<StageName extends AnalysisRunStageName> = StageProofToken<StageName>;

/** 公開前の完全性検証を通過した証明。 */
export type RunCompletenessProof = RunCompletenessProofToken;

/** checkpointと保存先の結合を検証した証明。 */
export type CheckpointBindingProof = CheckpointBindingProofToken;

/** 再開入力の結合を検証した証明。 */
export type ResumeBindingProof = ResumeBindingProofToken;

/** receiptの連鎖を検証した証明。 */
export type ReceiptChainProof = ReceiptChainProofToken;

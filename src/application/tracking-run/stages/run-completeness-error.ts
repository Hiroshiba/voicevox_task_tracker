import type { EvidenceUse } from "../contracts/evidence-closure.js";

/** 閉包または最終値の不完全性の種別。 */
export type RunCompletenessErrorCode =
  | "missing_source"
  | "private_source"
  | "future_source"
  | "transport_alias"
  | "wrong_owner"
  | "kind_mismatch"
  | "source_id_conflict"
  | "invalid_reference";

/** 不完全なoutward参照の位置と期待範囲を保持する。 */
export class RunCompletenessError extends Error {
  public readonly code: RunCompletenessErrorCode;
  public readonly sourceId: string;
  public readonly path: readonly (string | number)[];
  public readonly use: EvidenceUse | undefined;

  /** 不完全な参照と元の検証失敗を保持する。 */
  public constructor(
    code: RunCompletenessErrorCode,
    sourceId: string,
    path: readonly (string | number)[],
    use: EvidenceUse | undefined,
    cause?: unknown,
  ) {
    super(`根拠参照を閉包できません。種別: ${code} source: ${sourceId}`, { cause });
    this.name = "RunCompletenessError";
    this.code = code;
    this.sourceId = sourceId;
    this.path = Object.freeze([...path]);
    this.use = use;
  }
}

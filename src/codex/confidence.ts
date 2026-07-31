/** Codex confidenceの設定閾値。 */
export type CodexConfidenceThresholds = Readonly<{
  high: number;
  medium: number;
}>;

/** confidenceに応じた表示と通知の扱い。 */
export type CodexConfidenceClassification = Readonly<{
  level: "high" | "medium" | "low";
  displayMode: "confirmed" | "estimated" | "fallback";
  notificationPolicy: "eligible" | "normal_priority_only" | "suppressed";
}>;

function validateProbability(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

/** 設定値を使ってCodex confidenceをhigh、medium、lowへ分類する。 */
export function classifyCodexConfidence(
  confidence: number,
  thresholds: CodexConfidenceThresholds,
): CodexConfidenceClassification {
  validateProbability(confidence, "Codex confidence");
  validateProbability(thresholds.high, "high confidence閾値");
  validateProbability(thresholds.medium, "medium confidence閾値");
  if (thresholds.high < thresholds.medium) {
    throw new RangeError("high confidence閾値はmedium confidence閾値以上にしてください");
  }

  if (confidence >= thresholds.high) {
    return Object.freeze({
      level: "high",
      displayMode: "confirmed",
      notificationPolicy: "eligible",
    });
  }
  if (confidence >= thresholds.medium) {
    return Object.freeze({
      level: "medium",
      displayMode: "estimated",
      notificationPolicy: "normal_priority_only",
    });
  }
  return Object.freeze({
    level: "low",
    displayMode: "fallback",
    notificationPolicy: "suppressed",
  });
}

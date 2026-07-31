import { type Severity, type WaitClass } from "./types.js";

type SeverityRank = 0 | 1 | 2 | 3;

/** wait classごとのwatch、urgent、critical閾値。 */
export type SeverityThreshold = Readonly<{
  watch: number;
  urgent: number;
  critical: number;
}>;

/** staleness.thresholdsHoursと同じ構造のseverity閾値。 */
export type SeverityThresholds = Readonly<Record<WaitClass, SeverityThreshold>>;

/** 経過時間によるseverity判定で超えた閾値。 */
export type CrossedSeverityThreshold =
  | Readonly<{
      status: "not_reached";
      nextSeverity: "watch";
      nextThresholdHours: number;
    }>
  | Readonly<{
      status: "reached";
      severity: Exclude<Severity, "none">;
      thresholdHours: number;
    }>;

/** wait classと経過時間による直接severity判定の入力。 */
export type DirectSeverityInput = Readonly<{
  waitClass: WaitClass;
  elapsedHours: number;
  thresholdsHours: SeverityThresholds;
  severityLift: number;
  criticalAllowed: boolean;
}>;

/** wait classと経過時間による直接severity判定の根拠。 */
export type DirectSeverityReason = Readonly<{
  kind: "elapsed_threshold";
  waitClass: WaitClass;
  elapsedHours: number;
  crossedThreshold: CrossedSeverityThreshold;
  baseSeverity: Severity;
  labelLiftRequested: 0 | 1;
  labelLiftApplied: 0 | 1;
  criticalSuppressed: boolean;
  summary: string;
}>;

/** wait classと経過時間による直接severity判定結果。 */
export type DirectSeverityDecision = Readonly<{
  severity: Severity;
  reason: DirectSeverityReason;
}>;

function getSeverityRank(severity: Severity): SeverityRank {
  switch (severity) {
    case "none":
      return 0;
    case "watch":
      return 1;
    case "urgent":
      return 2;
    case "critical":
      return 3;
  }
}

function validateThreshold(threshold: SeverityThreshold, waitClass: WaitClass): void {
  for (const [severity, value] of Object.entries(threshold)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${waitClass}.${severity}のseverity閾値は0以上の有限値にしてください`);
    }
  }
  if (threshold.watch > threshold.urgent || threshold.urgent > threshold.critical) {
    throw new RangeError(`${waitClass}のseverity閾値はwatch、urgent、criticalの順にしてください`);
  }
}

function liftSeverity(severity: Severity, lift: 0 | 1): Severity {
  if (lift === 0) {
    return severity;
  }
  switch (severity) {
    case "none":
      return "watch";
    case "watch":
      return "urgent";
    case "urgent":
    case "critical":
      return "critical";
  }
}

function determineBaseSeverity(
  elapsedHours: number,
  threshold: SeverityThreshold,
): Readonly<{
  severity: Severity;
  crossedThreshold: CrossedSeverityThreshold;
}> {
  if (elapsedHours >= threshold.critical) {
    return Object.freeze({
      severity: "critical",
      crossedThreshold: Object.freeze({
        status: "reached",
        severity: "critical",
        thresholdHours: threshold.critical,
      }),
    });
  }
  if (elapsedHours >= threshold.urgent) {
    return Object.freeze({
      severity: "urgent",
      crossedThreshold: Object.freeze({
        status: "reached",
        severity: "urgent",
        thresholdHours: threshold.urgent,
      }),
    });
  }
  if (elapsedHours >= threshold.watch) {
    return Object.freeze({
      severity: "watch",
      crossedThreshold: Object.freeze({
        status: "reached",
        severity: "watch",
        thresholdHours: threshold.watch,
      }),
    });
  }
  return Object.freeze({
    severity: "none",
    crossedThreshold: Object.freeze({
      status: "not_reached",
      nextSeverity: "watch",
      nextThresholdHours: threshold.watch,
    }),
  });
}

function createSummary(
  baseSeverity: Severity,
  finalSeverity: Severity,
  threshold: CrossedSeverityThreshold,
  labelLiftApplied: 0 | 1,
  criticalSuppressed: boolean,
): string {
  const thresholdSummary =
    threshold.status === "reached"
      ? `${threshold.severity}の${threshold.thresholdHours.toString()}時間閾値を超えました`
      : `watchの${threshold.nextThresholdHours.toString()}時間閾値には達していません`;
  const liftSummary = labelLiftApplied === 1 ? "ラベル効果でseverityを1段階引き上げました" : "";
  const suppressionSummary = criticalSuppressed
    ? "低信頼のAI推定だけではcriticalにせずurgentへ抑制しました"
    : "";
  return [thresholdSummary, liftSummary, suppressionSummary]
    .filter((part) => part.length > 0)
    .join("。")
    .concat(`。経過時間によるseverityは${baseSeverity}、最終severityは${finalSeverity}です`);
}

/** severityをnone、watch、urgent、criticalの順で比較する。 */
export function compareSeverity(left: Severity, right: Severity): -1 | 0 | 1 {
  const difference = getSeverityRank(left) - getSeverityRank(right);
  if (difference < 0) {
    return -1;
  }
  if (difference > 0) {
    return 1;
  }
  return 0;
}

/** wait class別閾値とラベル効果から直接severityを判定する。 */
export function determineDirectSeverity(input: DirectSeverityInput): DirectSeverityDecision {
  if (!Number.isFinite(input.elapsedHours) || input.elapsedHours < 0) {
    throw new RangeError("severity判定の経過時間は0以上の有限値にしてください");
  }
  if (input.severityLift !== 0 && input.severityLift !== 1) {
    throw new RangeError("ラベルによるseverity引き上げは0または1にしてください");
  }

  const threshold = input.thresholdsHours[input.waitClass];
  validateThreshold(threshold, input.waitClass);
  const base = determineBaseSeverity(input.elapsedHours, threshold);
  const labelLiftRequested = input.severityLift === 1 ? 1 : 0;
  const liftedSeverity = liftSeverity(base.severity, labelLiftRequested);
  const criticalSuppressed = liftedSeverity === "critical" && !input.criticalAllowed;
  const severity = criticalSuppressed ? "urgent" : liftedSeverity;
  const labelLiftApplied = compareSeverity(severity, base.severity) > 0 ? 1 : 0;

  return Object.freeze({
    severity,
    reason: Object.freeze({
      kind: "elapsed_threshold",
      waitClass: input.waitClass,
      elapsedHours: input.elapsedHours,
      crossedThreshold: base.crossedThreshold,
      baseSeverity: base.severity,
      labelLiftRequested,
      labelLiftApplied,
      criticalSuppressed,
      summary: createSummary(
        base.severity,
        severity,
        base.crossedThreshold,
        labelLiftApplied,
        criticalSuppressed,
      ),
    }),
  });
}

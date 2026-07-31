import { createUtcIsoDateTime, type TrackedItemState, type UtcIsoDateTime } from "./types.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** terminal項目をactive datasetへ保持する既定日数。 */
export const DEFAULT_TERMINAL_RETENTION_DAYS = 180;

/** tracking.startAtの確定状態。 */
export type TrackingStartAtState =
  | Readonly<{
      status: "not_fixed";
    }>
  | Readonly<{
      status: "fixed";
      value: UtcIsoDateTime;
      source: "configuration" | "first_complete_run";
    }>;

/** 設定ファイルにおけるtracking.startAtの指定状態。 */
export type ConfiguredTrackingStartAt =
  | Readonly<{
      status: "not_configured";
    }>
  | Readonly<{
      status: "configured";
      value: UtcIsoDateTime;
    }>;

/** startAt確定を試みるrunの完了状態。 */
export type TrackingRunCompletion = Readonly<{
  outcome: "complete_success" | "incomplete";
  finishedAt: UtcIsoDateTime;
}>;

/** tracking.startAtを確定する入力。 */
export type ResolveTrackingStartAtInput = Readonly<{
  configuredStartAt: ConfiguredTrackingStartAt;
  previousState: TrackingStartAtState;
  run: TrackingRunCompletion;
}>;

/** terminal保持期間を判定する項目状態。 */
export type RetentionItemState =
  | Readonly<{
      state: "open";
    }>
  | Readonly<{
      state: "closed" | "merged";
      terminalAt: UtcIsoDateTime;
    }>;

/** terminal項目のactive dataset保持判定入力。 */
export type DetermineTerminalRetentionInput = Readonly<{
  item: RetentionItemState;
  evaluatedAt: UtcIsoDateTime;
  retentionDays: number;
}>;

/** terminal項目をactive datasetへ残すか退避するかの判定。 */
export type TerminalRetentionDecision =
  | Readonly<{
      dataset: "active";
      reason: "open";
    }>
  | Readonly<{
      dataset: "active";
      reason: "within_terminal_retention";
      retainedThrough: UtcIsoDateTime;
    }>
  | Readonly<{
      dataset: "archive";
      reason: "terminal_retention_expired";
      retainedThrough: UtcIsoDateTime;
    }>;

/** 前回のCodex分析入力とGitHub状態。 */
export type PreviousTrackedItemObservation =
  | Readonly<{
      status: "not_available";
    }>
  | Readonly<{
      status: "available";
      state: TrackedItemState;
      analysisInputFingerprint: string;
    }>;

/** tracked itemのCodex再分析と停滞通知評価を決める入力。 */
export type DetermineTrackedItemWorkInput = Readonly<{
  state: TrackedItemState;
  analysisInputFingerprint: string;
  previousObservation: PreviousTrackedItemObservation;
}>;

/** Codex分析を実行するかの判定。 */
export type CodexAnalysisWorkDecision =
  | Readonly<{
      action: "analyze";
      reason: "active_item" | "terminal_transition" | "analysis_input_changed";
    }>
  | Readonly<{
      action: "suppress";
      reason: "terminal_unchanged";
    }>;

/** 停滞通知候補を評価するかの判定。 */
export type StallNotificationWorkDecision =
  | Readonly<{
      action: "evaluate";
      reason: "active_item" | "terminal_transition" | "analysis_input_changed";
    }>
  | Readonly<{
      action: "suppress";
      reason: "terminal_unchanged";
    }>;

/** tracked itemに対する再分析と停滞通知評価の作業判定。 */
export type TrackedItemWorkDecision = Readonly<{
  codexAnalysis: CodexAnalysisWorkDecision;
  stallNotification: StallNotificationWorkDecision;
}>;

/** 追跡とは独立して設定する既定digest上の通知分類。 */
export type TrackingNotificationClass = "standard" | "automation_noise";

/** 既定digestへ含めるかの判定。 */
export type DefaultDigestDecision =
  | Readonly<{
      action: "include";
      reason: "standard_item";
    }>
  | Readonly<{
      action: "suppress";
      reason: "automation_noise";
    }>;

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function validateFingerprint(value: string, context: string): void {
  if (value.length === 0) {
    throw new TypeError(`${context}は空にできません`);
  }
}

function isTerminalState(state: TrackedItemState): state is "closed" | "merged" {
  switch (state) {
    case "open":
      return false;
    case "closed":
    case "merged":
      return true;
  }
}

/** 設定値、永続値、完全成功runの順でtracking.startAtを一度だけ確定する。 */
export function resolveTrackingStartAt(input: ResolveTrackingStartAtInput): TrackingStartAtState {
  parseTimestamp(input.run.finishedAt, "run完了時刻");
  if (input.configuredStartAt.status === "configured") {
    parseTimestamp(input.configuredStartAt.value, "設定されたtracking.startAt");
    return Object.freeze({
      status: "fixed",
      value: input.configuredStartAt.value,
      source: "configuration",
    });
  }
  if (input.previousState.status === "fixed") {
    parseTimestamp(input.previousState.value, "永続化されたtracking.startAt");
    return Object.freeze({
      status: "fixed",
      value: input.previousState.value,
      source: input.previousState.source,
    });
  }
  if (input.run.outcome === "incomplete") {
    return Object.freeze({
      status: "not_fixed",
    });
  }
  return Object.freeze({
    status: "fixed",
    value: input.run.finishedAt,
    source: "first_complete_run",
  });
}

/** closedまたはmerged項目を保持期間内だけactive datasetへ残す。 */
export function determineTerminalRetention(
  input: DetermineTerminalRetentionInput,
): TerminalRetentionDecision {
  const evaluatedAt = parseTimestamp(input.evaluatedAt, "保持判定時刻");
  if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 0) {
    throw new RangeError("terminal保持日数は0以上の安全な整数にしてください");
  }
  if (input.item.state === "open") {
    return Object.freeze({
      dataset: "active",
      reason: "open",
    });
  }

  const terminalAt = parseTimestamp(input.item.terminalAt, "terminal遷移時刻");
  if (terminalAt > evaluatedAt) {
    throw new RangeError("terminal遷移時刻は保持判定時刻以前にしてください");
  }
  const retainedThroughTimestamp = terminalAt + input.retentionDays * MILLISECONDS_PER_DAY;
  if (!Number.isFinite(retainedThroughTimestamp)) {
    throw new RangeError("terminal保持期限を有効な日時として計算できません");
  }
  const retainedThrough = createUtcIsoDateTime(new Date(retainedThroughTimestamp).toISOString());
  if (evaluatedAt <= retainedThroughTimestamp) {
    return Object.freeze({
      dataset: "active",
      reason: "within_terminal_retention",
      retainedThrough,
    });
  }
  return Object.freeze({
    dataset: "archive",
    reason: "terminal_retention_expired",
    retainedThrough,
  });
}

/** terminal遷移も分析入力変更もない項目のCodex再分析と停滞通知評価を抑止する。 */
export function determineTrackedItemWork(
  input: DetermineTrackedItemWorkInput,
): TrackedItemWorkDecision {
  validateFingerprint(input.analysisInputFingerprint, "現在の分析入力fingerprint");
  if (input.previousObservation.status === "available") {
    validateFingerprint(
      input.previousObservation.analysisInputFingerprint,
      "前回の分析入力fingerprint",
    );
  }

  if (!isTerminalState(input.state)) {
    return Object.freeze({
      codexAnalysis: Object.freeze({
        action: "analyze",
        reason: "active_item",
      }),
      stallNotification: Object.freeze({
        action: "evaluate",
        reason: "active_item",
      }),
    });
  }

  if (
    input.previousObservation.status === "available" &&
    input.previousObservation.state !== input.state
  ) {
    return Object.freeze({
      codexAnalysis: Object.freeze({
        action: "analyze",
        reason: "terminal_transition",
      }),
      stallNotification: Object.freeze({
        action: "evaluate",
        reason: "terminal_transition",
      }),
    });
  }

  if (
    input.previousObservation.status === "not_available" ||
    input.previousObservation.analysisInputFingerprint !== input.analysisInputFingerprint
  ) {
    return Object.freeze({
      codexAnalysis: Object.freeze({
        action: "analyze",
        reason: "analysis_input_changed",
      }),
      stallNotification: Object.freeze({
        action: "evaluate",
        reason: "analysis_input_changed",
      }),
    });
  }

  return Object.freeze({
    codexAnalysis: Object.freeze({
      action: "suppress",
      reason: "terminal_unchanged",
    }),
    stallNotification: Object.freeze({
      action: "suppress",
      reason: "terminal_unchanged",
    }),
  });
}

/** automation noiseだけを追跡選定と独立した規則で既定digestから除外する。 */
export function determineDefaultDigestDecision(
  notificationClass: TrackingNotificationClass,
): DefaultDigestDecision {
  switch (notificationClass) {
    case "standard":
      return Object.freeze({
        action: "include",
        reason: "standard_item",
      });
    case "automation_noise":
      return Object.freeze({
        action: "suppress",
        reason: "automation_noise",
      });
  }
}

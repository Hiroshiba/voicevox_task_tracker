import { TaskTrackerError } from "../util/task-tracker-error.js";

/** Codex adapterで発生するエラーの基底クラス。 */
export abstract class CodexAdapterError extends TaskTrackerError {}

/** Codex CLIの実行試行で発生し、再試行できるエラーの基底クラス。 */
export abstract class CodexAttemptError extends CodexAdapterError {
  public readonly attempts: number;

  protected constructor(message: string, attempts: number, options: ErrorOptions) {
    super(message, options);
    this.attempts = attempts;
  }
}

/** Codex CLIが制限時間内に終了しなかったことを表す。 */
export class CodexTimeoutError extends CodexAttemptError {
  public readonly timeoutMilliseconds: number;

  public constructor(attempts: number, timeoutMilliseconds: number) {
    super(
      `Codex CLIが制限時間内に終了しませんでした。試行回数: ${attempts.toString()} 制限時間ミリ秒: ${timeoutMilliseconds.toString()}`,
      attempts,
      {},
    );
    this.timeoutMilliseconds = timeoutMilliseconds;
  }
}

/** Codex CLIが正常終了しなかったことを表す。 */
export class CodexNonZeroExitError extends CodexAttemptError {
  public readonly exitCode: number | null;
  public readonly signal: NodeJS.Signals | null;

  public constructor(attempts: number, exitCode: number | null, signal: NodeJS.Signals | null) {
    const exitCodeText = exitCode == null ? "なし" : exitCode.toString();
    const signalText = signal ?? "なし";
    super(
      `Codex CLIが正常終了しませんでした。試行回数: ${attempts.toString()} 終了コード: ${exitCodeText} signal: ${signalText}`,
      attempts,
      {},
    );
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** Codex CLIの最終メッセージをJSONとして読み込めなかったことを表す。 */
export class CodexInvalidJsonError extends CodexAttemptError {
  public constructor(attempts: number, options: ErrorOptions) {
    super(
      `Codex CLIの最終メッセージをJSONとして読み込めません。試行回数: ${attempts.toString()}`,
      attempts,
      options,
    );
  }
}

/** Codex CLIの起動または標準入力の送信に失敗したことを表す。 */
export class CodexProcessStartError extends CodexAttemptError {
  public constructor(attempts: number, options: ErrorOptions) {
    super(`Codex CLIを起動できません。試行回数: ${attempts.toString()}`, attempts, options);
  }
}

/** Codex adapterが固定資材を読み込めなかったことを表す。 */
export class CodexResourceError extends CodexAdapterError {
  public constructor(resource: string, options: ErrorOptions) {
    super(`Codex adapterの固定資材を読み込めません。対象: ${resource}`, options);
  }
}

/** Codex adapterの一時作業ディレクトリを安全に管理できなかったことを表す。 */
export class CodexTemporaryWorkspaceError extends CodexAdapterError {
  public constructor(action: "create" | "cleanup", options: ErrorOptions) {
    const actionText = action === "create" ? "作成" : "削除";
    super(`Codex用の一時作業ディレクトリを${actionText}できません`, options);
  }
}

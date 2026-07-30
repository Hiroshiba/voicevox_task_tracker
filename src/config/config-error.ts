import { TaskTrackerError } from "../util/task-tracker-error.js";

export type ConfigIssue = Readonly<{
  path: string;
  message: string;
}>;

function createErrorMessage(issues: readonly ConfigIssue[]): string {
  if (issues.length === 0) {
    throw new TypeError("設定エラーには1件以上の問題が必要です");
  }

  return ["設定が不正です。", ...issues.map((issue) => `- ${issue.path}: ${issue.message}`)].join(
    "\n",
  );
}

/** 設定ファイルの読み込みまたは検証に失敗したことを表す。 */
export class ConfigError extends TaskTrackerError {
  public readonly issues: readonly ConfigIssue[];

  public constructor(issues: readonly ConfigIssue[], options: ErrorOptions) {
    super(createErrorMessage(issues), options);
    this.issues = [...issues];
  }
}

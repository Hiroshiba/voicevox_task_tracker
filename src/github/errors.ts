import { TaskTrackerError } from "../util/task-tracker-error.js";

export type GitHubRateLimitSnapshot =
  | Readonly<{
      source: "rest";
      limit: number;
      remaining: number;
      resetAt: string;
      observedAt: string;
      resource: string;
    }>
  | Readonly<{
      source: "graphql";
      limit: number;
      remaining: number;
      resetAt: string;
      observedAt: string;
      cost: number;
    }>;

/** GitHubクライアントで発生するエラーの基底クラス。 */
export abstract class GitHubClientError extends TaskTrackerError {}

/** GitHub App認証情報が不足または不正であることを表す。 */
export class GitHubCredentialsError extends GitHubClientError {
  public readonly variableNames: readonly string[];

  public constructor(variableNames: readonly string[]) {
    super(`GitHub App認証情報が不正です。対象: ${variableNames.join(", ")}`, {});
    this.variableNames = [...variableNames];
  }
}

/** GitHubの読み取り専用制約に反するリクエストを表す。 */
export class GitHubReadOnlyViolationError extends GitHubClientError {
  public readonly method: string;

  public constructor(method: string) {
    super(`GitHubへの書き込みリクエストを拒否しました。HTTP method: ${method}`, {});
    this.method = method;
  }
}

/** GitHub GraphQLの読み取り専用制約に反する操作を表す。 */
export class GitHubGraphQLReadOnlyViolationError extends GitHubClientError {
  public constructor() {
    super("GitHub GraphQLのmutationまたはsubscriptionを拒否しました", {});
  }
}

/** GitHub GraphQL文書が安全に解釈できないことを表す。 */
export class GitHubGraphQLDocumentError extends GitHubClientError {
  public constructor(options: ErrorOptions) {
    super("GitHub GraphQL文書を解釈できません", options);
  }
}

/** GitHub API予算の安全余裕へ到達したことを表す。 */
export class GitHubApiBudgetExceededError extends GitHubClientError {
  public readonly snapshot: GitHubRateLimitSnapshot;

  public constructor(snapshot: GitHubRateLimitSnapshot) {
    super(
      `GitHub API予算の安全余裕へ到達しました。残量: ${snapshot.remaining.toString()}/${snapshot.limit.toString()}`,
      {},
    );
    this.snapshot = snapshot;
  }
}

/** GitHub APIレスポンスが期待する契約を満たさないことを表す。 */
export class GitHubResponseValidationError extends GitHubClientError {
  public constructor(context: string, options: ErrorOptions) {
    super(`GitHub APIレスポンスが不正です。対象: ${context}`, options);
  }
}

/** GitHub API呼び出しが失敗したことを表す。 */
export class GitHubRequestError extends GitHubClientError {
  public readonly attempts: number;
  public readonly status: number | undefined;

  public constructor(status: number | undefined, attempts: number, options: ErrorOptions) {
    const statusText = status == null ? "不明" : status.toString();
    super(
      `GitHub API呼び出しに失敗しました。status: ${statusText} attempts: ${attempts.toString()}`,
      options,
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/** GitHub APIのretry上限へ到達したことを表す。 */
export class GitHubRetryExhaustedError extends GitHubClientError {
  public readonly attempts: number;
  public readonly status: number;

  public constructor(status: number, attempts: number, options: ErrorOptions) {
    super(
      `GitHub APIのretry上限へ到達しました。status: ${status.toString()} attempts: ${attempts.toString()}`,
      options,
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/** GitHub App認証処理が失敗したことを表す。 */
export class GitHubAuthenticationError extends GitHubClientError {
  public constructor(context: string, options: ErrorOptions) {
    super(`GitHub App認証に失敗しました。対象: ${context}`, options);
  }
}

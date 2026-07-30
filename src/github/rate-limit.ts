import { z } from "zod";

import {
  GitHubApiBudgetExceededError,
  GitHubResponseValidationError,
  type GitHubRateLimitSnapshot,
} from "./errors.js";

type GitHubResponseHeaders = Readonly<Record<string, string | number | undefined>>;

const integerHeaderSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

const restRateLimitSchema = z
  .strictObject({
    limit: integerHeaderSchema.refine((value) => value > 0),
    remaining: integerHeaderSchema,
    reset: integerHeaderSchema,
    resource: z.string().min(1),
  })
  .superRefine((rateLimit, context) => {
    if (rateLimit.remaining > rateLimit.limit) {
      context.addIssue({
        code: "custom",
        path: ["remaining"],
        message: "remainingはlimit以下である必要があります",
      });
    }
  });

export const graphQLRateLimitSchema = z
  .strictObject({
    cost: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    remaining: z.number().int().nonnegative(),
    resetAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((rateLimit, context) => {
    if (rateLimit.remaining > rateLimit.limit) {
      context.addIssue({
        code: "custom",
        path: ["remaining"],
        message: "remainingはlimit以下である必要があります",
      });
    }
  });

export type GraphQLRateLimit = z.output<typeof graphQLRateLimitSchema>;

type RateLimitState =
  | Readonly<{
      status: "unobserved";
    }>
  | Readonly<{
      status: "observed";
      snapshot: GitHubRateLimitSnapshot;
    }>;

function getHeader(headers: GitHubResponseHeaders, name: string): string | undefined {
  const expectedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expectedName && value != null) {
      return String(value);
    }
  }
  return undefined;
}

function hasAnyRestRateLimitHeader(headers: GitHubResponseHeaders): boolean {
  return [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
  ].some((name) => getHeader(headers, name) != null);
}

function toUtcIsoDateTime(date: Date, context: string): string {
  if (Number.isNaN(date.getTime())) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("日時を解釈できません"),
    });
  }
  return date.toISOString();
}

/** GitHub API予算の安全余裕へ到達しているかを判定する。 */
export function isGitHubApiBudgetExceeded(
  remaining: number,
  limit: number,
  githubApiBudgetRatio: number,
): boolean {
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new TypeError("remainingには0以上の安全な整数を指定してください");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("limitには正の安全な整数を指定してください");
  }
  if (remaining > limit) {
    throw new TypeError("remainingはlimit以下にしてください");
  }
  if (
    !Number.isFinite(githubApiBudgetRatio) ||
    githubApiBudgetRatio < 0 ||
    githubApiBudgetRatio > 1
  ) {
    throw new TypeError("githubApiBudgetRatioには0以上1以下を指定してください");
  }

  const safetyRatio = 1 - githubApiBudgetRatio;
  return remaining / limit <= safetyRatio;
}

/** RESTとGraphQLのGitHub API予算を監視する。 */
export class GitHubRateLimitController {
  readonly #githubApiBudgetRatio: number;
  #state: RateLimitState = { status: "unobserved" };

  public constructor(githubApiBudgetRatio: number) {
    if (
      !Number.isFinite(githubApiBudgetRatio) ||
      githubApiBudgetRatio < 0 ||
      githubApiBudgetRatio > 1
    ) {
      throw new TypeError("githubApiBudgetRatioには0以上1以下を指定してください");
    }
    this.#githubApiBudgetRatio = githubApiBudgetRatio;
  }

  /** RESTレスポンスのrate limit headerを記録する。 */
  public observeRestHeaders(headers: GitHubResponseHeaders, observedAt: Date): void {
    if (!hasAnyRestRateLimitHeader(headers)) {
      return;
    }

    const result = restRateLimitSchema.safeParse({
      limit: getHeader(headers, "x-ratelimit-limit"),
      remaining: getHeader(headers, "x-ratelimit-remaining"),
      reset: getHeader(headers, "x-ratelimit-reset"),
      resource: getHeader(headers, "x-ratelimit-resource"),
    });
    if (!result.success) {
      throw new GitHubResponseValidationError("REST rate limit header", {
        cause: new TypeError("rate limit headerの形式が不正です"),
      });
    }

    const snapshot = {
      source: "rest",
      limit: result.data.limit,
      remaining: result.data.remaining,
      resetAt: toUtcIsoDateTime(
        new Date(result.data.reset * 1000),
        "REST x-ratelimit-reset header",
      ),
      observedAt: toUtcIsoDateTime(observedAt, "REST rate limit観測日時"),
      resource: result.data.resource,
    } satisfies GitHubRateLimitSnapshot;
    this.record(snapshot);
  }

  /** GraphQLレスポンスのrate limit costを記録する。 */
  public observeGraphQL(rateLimit: GraphQLRateLimit, observedAt: Date): void {
    const result = graphQLRateLimitSchema.safeParse(rateLimit);
    if (!result.success) {
      throw new GitHubResponseValidationError("GraphQL rateLimit", {
        cause: new TypeError("GraphQL rateLimitの形式が不正です"),
      });
    }

    const snapshot = {
      source: "graphql",
      limit: result.data.limit,
      remaining: result.data.remaining,
      resetAt: toUtcIsoDateTime(new Date(result.data.resetAt), "GraphQL rateLimit.resetAt"),
      observedAt: toUtcIsoDateTime(observedAt, "GraphQL rate limit観測日時"),
      cost: result.data.cost,
    } satisfies GitHubRateLimitSnapshot;
    this.record(snapshot);
  }

  /** 次のGitHub API呼び出しを開始できることを確認する。 */
  public assertCanContinue(now: Date): void {
    if (Number.isNaN(now.getTime())) {
      throw new TypeError("現在日時を解釈できません");
    }
    if (this.#state.status === "unobserved") {
      return;
    }
    if (new Date(this.#state.snapshot.resetAt).getTime() <= now.getTime()) {
      this.#state = { status: "unobserved" };
      return;
    }
    this.throwIfExceeded(this.#state.snapshot);
  }

  /** 最後に観測したrate limitを返す。 */
  public getSnapshot(): GitHubRateLimitSnapshot | undefined {
    if (this.#state.status === "unobserved") {
      return undefined;
    }
    return this.#state.snapshot;
  }

  private record(snapshot: GitHubRateLimitSnapshot): void {
    this.#state = {
      status: "observed",
      snapshot,
    };
    this.throwIfExceeded(snapshot);
  }

  private throwIfExceeded(snapshot: GitHubRateLimitSnapshot): void {
    if (isGitHubApiBudgetExceeded(snapshot.remaining, snapshot.limit, this.#githubApiBudgetRatio)) {
      throw new GitHubApiBudgetExceededError(snapshot);
    }
  }
}

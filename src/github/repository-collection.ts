import { type GitHubRepositoryId, type UtcIsoDateTime } from "../domain/index.js";
import {
  GitHubRepositoryStaleFallbackUnavailableError,
  GitHubRetryExhaustedError,
} from "./errors.js";
import {
  type PublicRepository,
  type PublicRepositoryAllowlist,
} from "./public-repository-allowlist.js";

/** リポジトリから最後に取得できた値と観測時刻。 */
export type PreviousRepositoryValue<Value> = Readonly<{
  value: Value;
  observedAt: UtcIsoDateTime;
}>;

type FreshRepositoryCollectionResult<Value> = Readonly<{
  freshness: "fresh";
  repository: PublicRepository;
  value: Value;
  observedAt: UtcIsoDateTime;
}>;

type StaleRepositoryCollectionResult<Value> = Readonly<{
  freshness: "stale";
  repository: PublicRepository;
  previousValue: Value;
  lastSuccessfulAt: UtcIsoDateTime;
  failedAt: UtcIsoDateTime;
  diagnostic: Readonly<{
    code: "github_repository_temporarily_unavailable";
    message: string;
  }>;
}>;

/** リポジトリ単位の最新値または明示された前回値。 */
export type RepositoryCollectionResult<Value> =
  FreshRepositoryCollectionResult<Value> | StaleRepositoryCollectionResult<Value>;

export type CollectRepositoriesOptions<Value> = Readonly<{
  allowlist: PublicRepositoryAllowlist;
  observedAt: UtcIsoDateTime;
  previousValues: ReadonlyMap<GitHubRepositoryId, PreviousRepositoryValue<Value>>;
  collect: (repository: PublicRepository) => Promise<Value>;
}>;

function isStaleEligibleError(error: unknown): error is GitHubRetryExhaustedError {
  return error instanceof GitHubRetryExhaustedError && error.status === 503;
}

/** 公開リポジトリを収集し、503で取得不能なものだけ前回値をstaleとして保持する。 */
export async function collectRepositoriesWithStaleFallback<Value>(
  options: CollectRepositoriesOptions<Value>,
): Promise<readonly RepositoryCollectionResult<Value>[]> {
  const results: RepositoryCollectionResult<Value>[] = [];

  for (const repository of options.allowlist.repositories) {
    try {
      const value = await options.collect(repository);
      results.push(
        Object.freeze({
          freshness: "fresh",
          repository,
          value,
          observedAt: options.observedAt,
        }),
      );
    } catch (error: unknown) {
      if (!isStaleEligibleError(error)) {
        throw error;
      }
      const previous = options.previousValues.get(repository.id);
      if (previous == null) {
        throw new GitHubRepositoryStaleFallbackUnavailableError(
          `${repository.owner}/${repository.name}`,
          {
            cause: error,
          },
        );
      }
      results.push(
        Object.freeze({
          freshness: "stale",
          repository,
          previousValue: previous.value,
          lastSuccessfulAt: previous.observedAt,
          failedAt: options.observedAt,
          diagnostic: Object.freeze({
            code: "github_repository_temporarily_unavailable",
            message: `${repository.owner}/${repository.name}の取得に失敗したため前回値を保持しています`,
          }),
        }),
      );
    }
  }

  return Object.freeze(results);
}

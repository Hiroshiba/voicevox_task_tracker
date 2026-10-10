import {
  GitHubRequestError,
  type GitHubRestRequest,
  type GitHubRestResponse,
} from "../../github/index.js";
import { excludedPullRequest } from "../../application/tracking-run/excluded-pull-request.js";

/** 個別除外対象のPull RequestがHTTP 404を返すことを確認する。 */
export async function assertExcludedPullRequestReturns404(
  request: GitHubRestRequest,
): Promise<void> {
  let response: GitHubRestResponse;
  try {
    response = await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: excludedPullRequest.owner,
      repo: excludedPullRequest.repository,
      pull_number: excludedPullRequest.number,
    });
  } catch (error: unknown) {
    if (error instanceof GitHubRequestError) {
      if (error.status === 404) {
        return;
      }
      if (error.status === 304) {
        throw new Error("個別除外対象のPull Requestが304を返したので例外を削除してください", {
          cause: error,
        });
      }
    }
    throw error;
  }
  throw new Error(
    `個別除外対象のPull Requestを取得できたので例外を削除してください。status: ${response.status.toString()}`,
  );
}

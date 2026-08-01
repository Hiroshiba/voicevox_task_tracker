import {
  parseSourceId,
  type GitHubItemUrl,
  type SourceId,
  type TrackedItemInputEvent,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

function directSourceUrl(
  sourceId: SourceId,
  itemUrl: GitHubItemUrl,
  sourceUrlsById: ReadonlyMap<SourceId, GitHubItemUrl>,
  fragmentPrefix: string,
): GitHubItemUrl {
  const sourceUrl = sourceUrlsById.get(sourceId);
  assertNonNullable(
    sourceUrl,
    `個別sourceに対応する入力イベントが1件ではありません。対象: ${sourceId}`,
  );
  const item = new URL(itemUrl);
  const source = new URL(sourceUrl);
  if (source.origin !== item.origin || source.pathname !== item.pathname) {
    throw new TypeError(`個別sourceのURLが項目URLと一致しません。対象: ${sourceId}`);
  }
  if (!source.hash.startsWith(fragmentPrefix) || source.hash.length === fragmentPrefix.length) {
    throw new TypeError(`個別sourceのURLに対応するanchorがありません。対象: ${sourceId}`);
  }
  return sourceUrl;
}

/** 入力イベントを重複のないsource ID別URL Mapへ変換する。 */
export function createEvidenceSourceUrlMap(
  inputEvents: readonly TrackedItemInputEvent[],
): ReadonlyMap<SourceId, GitHubItemUrl> {
  const sourceUrlsById = new Map<SourceId, GitHubItemUrl>();
  for (const event of inputEvents) {
    if (!sourceUrlsById.has(event.sourceId)) {
      sourceUrlsById.set(event.sourceId, event.url);
      continue;
    }
    const previousUrl = sourceUrlsById.get(event.sourceId);
    assertNonNullable(previousUrl, `入力イベントのURLがありません。対象: ${event.sourceId}`);
    if (previousUrl !== event.url) {
      throw new TypeError(`同じsource IDに異なるURLがあります。対象: ${event.sourceId}`);
    }
    throw new TypeError(`同じsource IDの入力イベントが複数あります。対象: ${event.sourceId}`);
  }
  return sourceUrlsById;
}

/** source IDの種別から公開evidenceが参照するGitHub URLを解決する。 */
export function resolveEvidenceSourceUrl(
  sourceId: SourceId,
  itemUrl: GitHubItemUrl,
  sourceUrlsById: ReadonlyMap<SourceId, GitHubItemUrl>,
): GitHubItemUrl {
  const { kind } = parseSourceId(sourceId);
  switch (kind) {
    case "github_issue_comment":
      return directSourceUrl(sourceId, itemUrl, sourceUrlsById, "#issuecomment-");
    case "github_pull_request_review":
      return directSourceUrl(sourceId, itemUrl, sourceUrlsById, "#pullrequestreview-");
    case "github_pull_request_review_comment":
      return directSourceUrl(sourceId, itemUrl, sourceUrlsById, "#discussion_r");
    case "github_actor":
    case "github_user":
    case "github_team":
    case "github_account":
    case "github_item":
    case "github_commit":
    case "github_timeline_event":
    case "github_label":
    case "github_inbound_cross_reference":
    case "github_pull_request_review_thread":
    case "github_review_request":
    case "github_native_dependency":
    case "github_native_hierarchy":
    case "github_check_run":
    case "github_commit_status":
    case "github_check_rollup":
    case "github_status_check_rollup":
    case "github_auto_merge_request":
    case "github_merge_queue_entry":
    case "github_item_detail":
    case "github_item_body":
    case "body":
    case "golden_event":
    case "golden_item":
    case "golden_review_request":
    case "golden_team":
    case "golden_checks":
    case "golden_commit":
    case "golden_relation":
    case "golden_ai_source":
    case "golden_large":
    case "golden_large_edge":
      return itemUrl;
    default:
      throw new TypeError(`公開evidence URLへ解決できないsource ID種別です。対象: ${kind}`);
  }
}

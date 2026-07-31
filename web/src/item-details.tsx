import { type ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

import {
  type PublicItemDetailsDto,
  type PublicItemHistoryEventDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import {
  confidencePresentation,
  formatConfidence,
  formatJstDateTime,
  formatRelativeTime,
  severityLabel,
  statusLabel,
  waitingOnCandidateLabel,
  waitingOnRoleLabel,
  type ConfidencePresentation,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import { type ItemSelection } from "./url-state.js";

/** details.jsonの項目読込状態。 */
export type ItemDetailsState =
  | Readonly<{
      status: "not_requested";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      itemsByNodeId: ReadonlyMap<string, PublicItemDetailsDto>;
    }>
  | Readonly<{
      status: "failed";
    }>;

/** 全項目検索の実行状態。 */
export type ItemSearchState =
  | Readonly<{
      status: "inactive";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "available";
      nodeIds: readonly string[];
    }>
  | Readonly<{
      status: "failed";
    }>;

type ItemDetailsLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
  nodeId: string;
  onSelect: (nodeId: string) => void;
}>;

type ItemWorkspaceProps = Readonly<{
  clearSelectionHref: string;
  createItemHref: (nodeId: string) => string;
  detailsState: ItemDetailsState;
  locale: string;
  now: Date;
  onClearSearch: () => void;
  onClearSelection: () => void;
  onRetryDetails: () => void;
  onSearchQueryChange: (query: string) => void;
  onSelectItem: (nodeId: string) => void;
  searchQuery: string;
  searchState: ItemSearchState;
  selection: ItemSelection;
  summary: PublicSummaryDto;
}>;

type ItemDetailsProps = Readonly<{
  clearSelectionHref: string;
  createItemHref: (nodeId: string) => string;
  details: PublicItemDetailsDto;
  locale: string;
  now: Date;
  onClearSelection: () => void;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
}>;

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];

type SeverityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "severity_changed" }>
>["before"];

const REVIEW_STATE_LABELS = {
  not_applicable: "対象外",
  not_requested: "未依頼",
  requested: "依頼済み",
  changes_requested: "変更要求あり",
  approved: "承認済み",
  unknown: "不明",
} satisfies Readonly<Record<PublicItemDetailsDto["reviewState"], string>>;

const CHECK_STATE_LABELS = {
  not_applicable: "対象外",
  not_required: "不要",
  pending: "実行中",
  passing: "成功",
  failing: "失敗",
  unknown: "不明",
} satisfies Readonly<Record<PublicItemDetailsDto["checkState"], string>>;

const EVIDENCE_SUPPORT_LABELS = {
  status: "状態",
  waiting_on: "waitingOn",
  relation: "依存関係",
  progress: "進捗",
  notification: "通知",
  uncertainty: "不確実性",
} satisfies Readonly<Record<PublicItemDetailsDto["evidence"][number]["supports"], string>>;

function shouldHandleClientNavigation(
  event: Readonly<{
    altKey: boolean;
    button: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }>,
): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/** 同一ページ内で項目詳細を開き、通常のリンク操作も維持する。 */
export function ItemDetailsLink({ children, href, nodeId, onSelect }: ItemDetailsLinkProps) {
  return (
    <a
      href={href}
      aria-controls="item-details"
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) {
          return;
        }
        event.preventDefault();
        onSelect(nodeId);
      }}
    >
      {children}
    </a>
  );
}

function confidenceDescription(presentation: ConfidencePresentation): string {
  switch (presentation.level) {
    case "confirmed":
      return "GitHubの確定情報とルールに基づく判定です。";
    case "high_estimate":
      return "確度の高い推定です。根拠からGitHubの情報を確認できます。";
    case "estimate":
      return "推定を含む判定です。根拠からGitHubの情報を確認してください。";
    case "uncertain":
      return "根拠が不足しているため、状態や次の行動は候補として示しています。";
    default:
      throw new UnreachableError(presentation.level);
  }
}

function decisionFieldLabel(label: string, presentation: ConfidencePresentation): string {
  switch (presentation.fieldQualifier) {
    case "":
      return label;
    case "推定":
      return `推定${label}`;
    case "候補":
      return `${label}候補`;
    default:
      throw new UnreachableError(presentation.fieldQualifier);
  }
}

function ConfidenceDisplay({
  confidence,
  locale,
}: Readonly<{ confidence: number; locale: string }>) {
  const presentation = confidencePresentation(confidence);
  return (
    <div
      class={`confidence-panel confidence-${presentation.level}`}
      data-confidence-level={presentation.level}
      role="status"
    >
      <strong>
        判定: {presentation.label}・confidence {formatConfidence(confidence, locale)}
      </strong>
      <span>{confidenceDescription(presentation)}</span>
    </div>
  );
}

function DetailTime({
  label,
  locale,
  now,
  value,
}: Readonly<{ label: string; locale: string; now: Date; value: string }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <time dateTime={value}>{formatJstDateTime(value, locale)}</time>
        <span class="relative-time">{formatRelativeTime(value, now, locale)}</span>
      </dd>
    </div>
  );
}

function formatResponsibilityHistoryValue(value: ResponsibilityHistoryValue): string {
  if (value.state === "absent") {
    return "記録なし";
  }
  const waitingOn =
    value.value.waitingOn.length === 0
      ? "対応完了"
      : value.value.waitingOn.map(waitingOnCandidateLabel).join("、");
  return `${statusLabel(value.value.status)}・${waitingOn}`;
}

function formatSeverityHistoryValue(value: SeverityHistoryValue): string {
  return value.state === "absent" ? "記録なし" : severityLabel(value.value);
}

function HistoryEvent({
  event,
  locale,
}: Readonly<{ event: PublicItemHistoryEventDto; locale: string }>) {
  let label: string;
  let before: string;
  let after: string;
  switch (event.kind) {
    case "responsibility_changed":
      label = "状態とwaitingOnの変更";
      before = formatResponsibilityHistoryValue(event.before);
      after = formatResponsibilityHistoryValue(event.after);
      break;
    case "severity_changed":
      label = "severityの変更";
      before = formatSeverityHistoryValue(event.before);
      after = formatSeverityHistoryValue(event.after);
      break;
    default:
      throw new UnreachableError(event);
  }
  return (
    <article class="history-event" data-history-kind={event.kind}>
      <div>
        <h4>{label}</h4>
        <time dateTime={event.recordedAt}>{formatJstDateTime(event.recordedAt, locale)}</time>
      </div>
      <p>
        <span>{before}</span>
        <span aria-hidden="true">→</span>
        <span class="visually-hidden">から</span>
        <strong>{after}</strong>
      </p>
      <p class="history-run-id">Run {event.runId}</p>
    </article>
  );
}

function ItemHistory({
  history,
  locale,
}: Readonly<{ history: readonly PublicItemHistoryEventDto[]; locale: string }>) {
  const latestEvent = history.at(-1);
  return (
    <section aria-labelledby="item-history-heading" class="detail-subsection">
      <h3 id="item-history-heading">前回との差分と履歴</h3>
      {latestEvent == null ? (
        <p>前回から状態、waitingOn、severityに記録された差分はありません。</p>
      ) : (
        <>
          <div class="latest-difference">
            <h4>前回との差分</h4>
            <HistoryEvent event={latestEvent} locale={locale} />
          </div>
          <details class="history-list">
            <summary>全履歴を表示</summary>
            <ol>
              {[...history].reverse().map((event) => (
                <li key={`${event.runId}:${event.kind}:${event.recordedAt}`}>
                  <HistoryEvent event={event} locale={locale} />
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}

function ItemDetails({
  clearSelectionHref,
  createItemHref,
  details,
  locale,
  now,
  onClearSelection,
  onSelectItem,
  summary,
}: ItemDetailsProps) {
  const item = details.summary;
  const heading = useRef<HTMLHeadingElement>(null);
  const presentation = confidencePresentation(item.confidence);
  const itemsByNodeId = new Map(
    summary.items.map((summaryItem) => [summaryItem.nodeId, summaryItem]),
  );
  const timestampFields = [
    {
      label: "作成",
      value: details.timestamps.createdAt,
    },
    {
      label: "GitHub更新",
      value: details.timestamps.githubUpdatedAt,
    },
    {
      label: "最終human activity",
      value: details.timestamps.lastHumanActivityAt,
    },
    {
      label: "最終進捗",
      value: details.timestamps.lastProgressAt,
    },
    {
      label: "現在statusの開始",
      value: details.timestamps.statusSince,
    },
    {
      label: "現在waitingOnの開始",
      value: details.timestamps.ownerSince,
    },
    {
      label: "停滞開始",
      value: details.timestamps.stallSince,
    },
    {
      label: "項目観測",
      value: details.timestamps.observedAt,
    },
  ];
  useEffect(() => {
    heading.current?.focus();
  }, [item.nodeId]);

  return (
    <article class="item-details-card" data-node-id={item.nodeId}>
      <div class="item-details-heading">
        <div>
          <p class="item-reference">{item.displayReference}</p>
          <h3 ref={heading} tabIndex={-1}>
            {item.title}
          </h3>
        </div>
        <a
          href={clearSelectionHref}
          onClick={(event) => {
            if (!shouldHandleClientNavigation(event)) {
              return;
            }
            event.preventDefault();
            onClearSelection();
          }}
        >
          詳細を閉じる
        </a>
      </div>

      <ConfidenceDisplay confidence={item.confidence} locale={locale} />

      <dl class="detail-summary-grid">
        <div>
          <dt>GitHub</dt>
          <dd>
            <SafeGitHubLink href={item.url}>GitHubで項目を開く</SafeGitHubLink>
          </dd>
        </div>
        <div>
          <dt>GitHub上の状態</dt>
          <dd>{item.state}</dd>
        </div>
        <div>
          <dt>{decisionFieldLabel("status", presentation)}</dt>
          <dd>{statusLabel(item.status)}</dd>
        </div>
        <div>
          <dt>severity</dt>
          <dd>
            <span class={`severity-badge severity-${item.severity}`}>
              {severityLabel(item.severity)}
            </span>
          </dd>
        </div>
        <div>
          <dt>review</dt>
          <dd>{REVIEW_STATE_LABELS[details.reviewState]}</dd>
        </div>
        <div>
          <dt>checks</dt>
          <dd>{CHECK_STATE_LABELS[details.checkState]}</dd>
        </div>
      </dl>

      <section aria-labelledby="item-waiting-on-heading" class="detail-subsection">
        <h3 id="item-waiting-on-heading">{decisionFieldLabel("waitingOn", presentation)}</h3>
        {item.waitingOn.length === 0 ? (
          <p>対応完了</p>
        ) : (
          <ul class="waiting-on-list">
            {item.waitingOn.map((waitingOn) => {
              const waitingOnPresentation = confidencePresentation(waitingOn.confidence);
              return (
                <li key={`${waitingOn.kind}:${waitingOn.candidateId}:${waitingOn.role}`}>
                  <div>
                    <strong>{waitingOnCandidateLabel(waitingOn)}</strong>
                    <span>{waitingOnRoleLabel(waitingOn.role)}</span>
                    <span>
                      {waitingOnPresentation.label}・
                      {formatConfidence(waitingOn.confidence, locale)}
                    </span>
                  </div>
                  <p>{waitingOn.reasonSummary}</p>
                  <p class="source-id-list">source ID: {waitingOn.sourceIds.join("、")}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="item-next-action-heading" class="detail-subsection">
        <h3 id="item-next-action-heading">{decisionFieldLabel("次の行動", presentation)}</h3>
        <p class={presentation.level === "uncertain" ? "uncertain-value" : ""}>{item.nextAction}</p>
      </section>

      <section aria-labelledby="item-times-heading" class="detail-subsection">
        <h3 id="item-times-heading">各種時刻</h3>
        <dl class="timestamp-grid">
          {timestampFields.map((field) => (
            <DetailTime
              key={field.label}
              label={field.label}
              value={field.value}
              now={now}
              locale={locale}
            />
          ))}
        </dl>
      </section>

      <section aria-labelledby="item-blockers-heading" class="detail-subsection">
        <h3 id="item-blockers-heading">blocker一覧</h3>
        {item.blockerNodeIds.length === 0 ? (
          <p>blockerはありません。</p>
        ) : (
          <ul class="blocker-list">
            {item.blockerNodeIds.map((nodeId) => {
              const blocker = itemsByNodeId.get(nodeId);
              assertNonNullable(blocker, `blocker ${nodeId}の公開項目がありません`);
              return (
                <li key={nodeId}>
                  <ItemDetailsLink
                    href={createItemHref(nodeId)}
                    nodeId={nodeId}
                    onSelect={onSelectItem}
                  >
                    {blocker.displayReference} {blocker.title}
                  </ItemDetailsLink>
                  <SafeGitHubLink href={blocker.url}>GitHubで開く</SafeGitHubLink>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="item-evidence-heading" class="detail-subsection">
        <h3 id="item-evidence-heading">判定根拠</h3>
        {details.evidence.length === 0 ? (
          <p>公開できる判定根拠はありません。</p>
        ) : (
          <ol class="evidence-list">
            {details.evidence.map((evidence) => (
              <li key={`${evidence.sourceId}:${evidence.supports}`}>
                <div>
                  <span>{EVIDENCE_SUPPORT_LABELS[evidence.supports]}</span>
                  <code>{evidence.sourceId}</code>
                </div>
                <p>{evidence.summary}</p>
                <SafeGitHubLink href={evidence.sourceUrl}>GitHub上の根拠を開く</SafeGitHubLink>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="item-context-heading" class="detail-subsection">
        <h3 id="item-context-heading">補足情報</h3>
        <dl class="detail-context-grid">
          <div>
            <dt>ラベル</dt>
            <dd>{details.labels.length === 0 ? "なし" : details.labels.join("、")}</dd>
          </div>
          <div>
            <dt>assignee</dt>
            <dd>
              {details.assignees.length === 0
                ? "なし"
                : details.assignees.map((assignee) => `@${assignee.login}`).join("、")}
            </dd>
          </div>
        </dl>
        {details.uncertainties.length > 0 && (
          <div class="uncertainty-list">
            <h4>不確実な点</h4>
            <ul>
              {details.uncertainties.map((uncertainty) => (
                <li key={uncertainty}>{uncertainty}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <ItemHistory history={details.history} locale={locale} />
    </article>
  );
}

function SearchStatus({
  onRetryDetails,
  searchState,
  summary,
}: Readonly<{
  onRetryDetails: () => void;
  searchState: ItemSearchState;
  summary: PublicSummaryDto;
}>) {
  switch (searchState.status) {
    case "inactive":
      return (
        <p class="search-status" role="status" aria-live="polite">
          全{summary.items.length.toLocaleString()}件を表示しています。
        </p>
      );
    case "loading":
      return (
        <p class="search-status" role="status" aria-live="polite">
          検索用の公開詳細データを読み込んでいます。
        </p>
      );
    case "available":
      return (
        <p class="search-status" role="status" aria-live="polite">
          {searchState.nodeIds.length.toLocaleString()}件が検索条件に一致しました。
        </p>
      );
    case "failed":
      return (
        <div class="search-load-failure" role="alert">
          <p>検索用の公開詳細データを取得できませんでした。</p>
          <button type="button" onClick={onRetryDetails}>
            再取得
          </button>
        </div>
      );
    default:
      throw new UnreachableError(searchState);
  }
}

/** 項目検索と選択中項目の詳細を表示する。 */
export function ItemWorkspace({
  clearSelectionHref,
  createItemHref,
  detailsState,
  locale,
  now,
  onClearSearch,
  onClearSelection,
  onRetryDetails,
  onSearchQueryChange,
  onSelectItem,
  searchQuery,
  searchState,
  selection,
  summary,
}: ItemWorkspaceProps) {
  let selectedContent: ComponentChildren;
  if (selection.status === "none") {
    selectedContent = (
      <p class="item-details-placeholder">
        attention queueまたは全項目一覧の「詳細を開く」から項目を選択できます。
      </p>
    );
  } else {
    switch (detailsState.status) {
      case "not_requested":
      case "loading":
        selectedContent = (
          <p class="item-details-placeholder" role="status" aria-live="polite">
            選択した項目の詳細を読み込んでいます。
          </p>
        );
        break;
      case "loaded": {
        const details = detailsState.itemsByNodeId.get(selection.nodeId);
        assertNonNullable(details, `選択項目 ${selection.nodeId} のdetailsがありません`);
        selectedContent = (
          <ItemDetails
            clearSelectionHref={clearSelectionHref}
            createItemHref={createItemHref}
            details={details}
            locale={locale}
            now={now}
            onClearSelection={onClearSelection}
            onSelectItem={onSelectItem}
            summary={summary}
          />
        );
        break;
      }
      case "failed":
        selectedContent = (
          <div class="item-details-placeholder" role="alert">
            <p>選択した項目の詳細を取得できませんでした。</p>
            <button type="button" onClick={onRetryDetails}>
              再取得
            </button>
          </div>
        );
        break;
      default:
        throw new UnreachableError(detailsState);
    }
  }

  return (
    <section aria-labelledby="item-workspace-heading" class="section-card item-workspace">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Search and details</p>
          <h2 id="item-workspace-heading">項目検索と詳細</h2>
        </div>
        <p>公開済みデータだけを使い、項目の判定根拠と変更履歴まで確認できます。</p>
      </div>
      <div class="item-search" role="search" aria-labelledby="item-search-label">
        <label id="item-search-label" for="item-search-input">
          リポジトリ、番号、タイトル、アクター、team、ラベルで検索
        </label>
        <div class="search-input-row">
          <input
            id="item-search-input"
            type="search"
            value={searchQuery}
            maxLength={200}
            aria-describedby="item-search-description"
            onInput={(event) => {
              onSearchQueryChange(event.currentTarget.value);
            }}
          />
          <button type="button" disabled={searchQuery.length === 0} onClick={onClearSearch}>
            検索をクリア
          </button>
        </div>
        <p id="item-search-description">
          空白で区切った語をすべて含む項目を、外部問い合わせなしで検索します。
        </p>
        <SearchStatus searchState={searchState} summary={summary} onRetryDetails={onRetryDetails} />
      </div>
      <div id="item-details" class="item-details-region" aria-live="polite">
        {selectedContent}
      </div>
    </section>
  );
}

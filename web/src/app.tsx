import { useEffect, useMemo, useState } from "preact/hooks";

import {
  type PublicDetailsDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { DependencyGraph, type PublicDetailsLoader } from "./dependency-graph.js";
import {
  ItemDetailsLink,
  ItemWorkspace,
  type ItemDetailsState,
  type ItemSearchState,
} from "./item-details.js";
import {
  attentionPriority,
  createItemDetailsMap,
  createItemTableRows,
  filterAndSortTableRows,
  formatJstDateTime,
  formatRelativeTime,
  formatStallDuration,
  formatWaitingOn,
  searchItemNodeIds,
  selectAttentionItems,
  severityLabel,
  statusLabel,
  type TableColumnKey,
  type TableFilters,
  type TableSort,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import {
  createWebViewHref,
  parseWebViewState,
  type GraphSelection,
  type ParsedWebViewState,
  type ValidGraphClusterIds,
  type WebViewState,
} from "./url-state.js";

const TABLE_PAGE_SIZE = 50;

type AppProps = Readonly<{
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
  title: string;
}>;

type TimeDisplayProps = Readonly<{
  label: string;
  locale: string;
  now: Date;
  value: string;
}>;

type ItemTableProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  filters: TableFilters;
  locale: string;
  now: Date;
  onFilterChange: (key: TableColumnKey, value: string) => void;
  onSelectItem: (nodeId: string) => void;
  onSortChange: (key: TableColumnKey) => void;
  searchState: ItemSearchState;
  sort: TableSort;
  summary: PublicSummaryDto;
}>;

type AttentionQueueProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  locale: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
}>;

type TableColumnDefinition = Readonly<{
  key: TableColumnKey;
  label: string;
}>;

const TABLE_COLUMNS: readonly TableColumnDefinition[] = [
  {
    key: "repository",
    label: "リポジトリ",
  },
  {
    key: "type",
    label: "種別",
  },
  {
    key: "status",
    label: "status",
  },
  {
    key: "waitingOn",
    label: "waitingOn",
  },
  {
    key: "stall",
    label: "停滞時間",
  },
  {
    key: "blocker",
    label: "blocker",
  },
  {
    key: "updated",
    label: "更新日時",
  },
];

const STATUS_VALUES: readonly PublicItemSummaryDto["status"][] = [
  "new_untriaged",
  "needs_maintainer_decision",
  "waiting_for_review",
  "waiting_for_author",
  "waiting_for_assignee",
  "blocked",
  "waiting_for_automation",
  "ready_to_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
];

const SEVERITY_VALUES: readonly PublicItemSummaryDto["severity"][] = [
  "critical",
  "urgent",
  "watch",
  "none",
];

type SharedDetailsLoaderState =
  | Readonly<{
      status: "empty";
    }>
  | Readonly<{
      status: "loading";
      promise: Promise<PublicDetailsDto>;
    }>
  | Readonly<{
      status: "loaded";
      details: PublicDetailsDto;
    }>;

function createSharedDetailsLoader(loadDetails: PublicDetailsLoader): PublicDetailsLoader {
  let state: SharedDetailsLoaderState = {
    status: "empty",
  };
  return () => {
    if (state.status === "loading") {
      return state.promise;
    }
    if (state.status === "loaded") {
      return Promise.resolve(state.details);
    }

    let request: Promise<PublicDetailsDto>;
    try {
      request = loadDetails();
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    const sharedRequest = request.then(
      (details) => {
        state = {
          status: "loaded",
          details,
        };
        return details;
      },
      (error: unknown) => {
        state = {
          status: "empty",
        };
        throw error;
      },
    );
    state = {
      status: "loading",
      promise: sharedRequest,
    };
    return sharedRequest;
  };
}

function TimeDisplay({ label, locale, now, value }: TimeDisplayProps) {
  return (
    <span class="time-display">
      <span class="time-label">{label}</span>
      <time dateTime={value}>{formatJstDateTime(value, locale)}</time>
      <span class="relative-time">{formatRelativeTime(value, now, locale)}</span>
    </span>
  );
}

function Dashboard({ locale, now, summary }: Omit<AppProps, "loadDetails" | "title">) {
  const aggregates = summary.aggregates;
  const primaryMetrics = [
    {
      label: "リポジトリ",
      value: aggregates.repositoryCount,
    },
    {
      label: "項目",
      value: aggregates.itemCount,
    },
    {
      label: "unknown",
      value: aggregates.unknownItemCount,
    },
    {
      label: "staleリポジトリ",
      value: aggregates.staleRepositoryCount,
    },
    {
      label: "stale項目",
      value: aggregates.staleItemCount,
    },
  ];

  return (
    <section aria-labelledby="overview-heading" class="section-card overview">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Overview</p>
          <h2 id="overview-heading">概要</h2>
        </div>
        <div class="run-times">
          <TimeDisplay label="全体観測" value={summary.observedAt} now={now} locale={locale} />
          <TimeDisplay label="生成" value={summary.generatedAt} now={now} locale={locale} />
        </div>
      </div>

      <AiStateNotice ai={summary.ai} />

      <dl class="metric-grid">
        {primaryMetrics.map((metric) => (
          <div class="metric" key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value.toLocaleString(locale)}</dd>
          </div>
        ))}
      </dl>

      <div class="aggregate-groups">
        <section aria-labelledby="status-count-heading">
          <h3 id="status-count-heading">status別</h3>
          <dl class="count-list">
            {STATUS_VALUES.map((status) => (
              <div key={status}>
                <dt>{statusLabel(status)}</dt>
                <dd>{aggregates.statusCounts[status].toLocaleString(locale)}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="severity-count-heading">
          <h3 id="severity-count-heading">severity別</h3>
          <dl class="count-list">
            {SEVERITY_VALUES.map((severity) => (
              <div key={severity}>
                <dt>
                  <span class={`severity-badge severity-${severity}`}>
                    {severityLabel(severity)}
                  </span>
                </dt>
                <dd>{aggregates.severityCounts[severity].toLocaleString(locale)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </section>
  );
}

function AiStateNotice({ ai }: Readonly<{ ai: PublicSummaryDto["ai"] }>) {
  if (!ai.enabled) {
    return (
      <p class="notice" role="status">
        AI分析は設定で無効です。確定ルールで表示しています。
      </p>
    );
  }
  if (!ai.available) {
    return (
      <p class="notice notice-warning" role="status">
        AIを利用できなかったため、確定ルールと利用可能な前回結果で表示しています。
      </p>
    );
  }
  if (ai.degraded) {
    return (
      <p class="notice notice-warning" role="status">
        AI分析の一部が縮退したため、確定ルールと利用可能な前回結果を併用しています。
      </p>
    );
  }
  return null;
}

function RepositoryFreshness({ locale, now, summary }: Omit<AppProps, "loadDetails" | "title">) {
  return (
    <section aria-labelledby="freshness-heading" class="section-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Freshness</p>
          <h2 id="freshness-heading">リポジトリの鮮度</h2>
        </div>
        <p>観測に失敗したリポジトリは、前回値として明示します。</p>
      </div>
      <div
        class="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="リポジトリ鮮度表の横スクロール領域"
      >
        <table class="freshness-table">
          <caption class="visually-hidden">リポジトリごとの項目数、観測時刻、鮮度</caption>
          <thead>
            <tr>
              <th scope="col">リポジトリ</th>
              <th scope="col">項目数</th>
              <th scope="col">観測時刻</th>
              <th scope="col">鮮度</th>
            </tr>
          </thead>
          <tbody>
            {summary.repositories.map((repository) => (
              <tr
                key={repository.id}
                data-repository-id={repository.id}
                data-freshness={repository.freshness.status}
                class={repository.freshness.status === "stale" ? "stale-row" : ""}
              >
                <th scope="row">{repository.fullName}</th>
                <td>{repository.itemCount.toLocaleString(locale)}</td>
                <td>
                  <TimeDisplay
                    label="観測"
                    value={repository.observedAt}
                    now={now}
                    locale={locale}
                  />
                </td>
                <td>
                  {repository.freshness.status === "fresh" ? (
                    <span class="freshness-badge freshness-fresh">最新観測</span>
                  ) : (
                    <span class="freshness-detail">
                      <span class="freshness-badge freshness-stale">古い観測値</span>
                      <TimeDisplay
                        label="取得失敗"
                        value={repository.freshness.failedAt}
                        now={now}
                        locale={locale}
                      />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AttentionQueue({
  createItemHref,
  locale,
  now,
  onSelectItem,
  summary,
}: AttentionQueueProps) {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  const attentionItems = selectAttentionItems(summary.items);

  return (
    <section aria-labelledby="attention-heading" class="section-card attention-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Attention queue</p>
          <h2 id="attention-heading">対応が必要な項目</h2>
        </div>
        <p>severity、対応優先度、影響範囲、停滞時間の順で表示します。</p>
      </div>
      {attentionItems.length === 0 ? (
        <p class="empty-state">現在、対応が必要な項目はありません。</p>
      ) : (
        <ol class="attention-list">
          {attentionItems.map((item) => {
            const repository = repositoriesById.get(item.repositoryId);
            assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
            const priority = attentionPriority(item);
            return (
              <li key={item.nodeId} data-node-id={item.nodeId}>
                <article class="attention-item">
                  <div class="attention-title">
                    <div class="badge-row">
                      <span class={`severity-badge severity-${item.severity}`}>
                        {severityLabel(item.severity)}
                      </span>
                      <span class="priority-badge">対応優先度 {priority.label}</span>
                    </div>
                    <p class="item-reference">
                      {repository.fullName} #{item.number.toString()}
                    </p>
                    <h3>{item.title}</h3>
                  </div>
                  <dl class="attention-details">
                    <div>
                      <dt>waitingOn</dt>
                      <dd>{formatWaitingOn(item, summary.confidenceThresholds)}</dd>
                    </div>
                    <div>
                      <dt>停滞時間</dt>
                      <dd>{formatStallDuration(item.stallSince, now)}</dd>
                    </div>
                    <div>
                      <dt>影響範囲</dt>
                      <dd>
                        {item.downstreamImpact.repositoryCount.toLocaleString(locale)}
                        リポジトリ・
                        {item.downstreamImpact.openNodeCount.toLocaleString(locale)}
                        項目
                      </dd>
                    </div>
                    <div>
                      <dt>理由</dt>
                      <dd>
                        {item.waitingOn.map((waitingOn) => waitingOn.reasonSummary).join("、")}
                      </dd>
                    </div>
                    <div>
                      <dt>項目観測</dt>
                      <dd>
                        <TimeDisplay
                          label="観測"
                          value={item.observedAt}
                          now={now}
                          locale={locale}
                        />
                      </dd>
                    </div>
                  </dl>
                  <div class="item-actions">
                    <ItemDetailsLink
                      href={createItemHref(item.nodeId)}
                      nodeId={item.nodeId}
                      onSelect={onSelectItem}
                    >
                      詳細を開く
                    </ItemDetailsLink>
                    <SafeGitHubLink href={item.url}>GitHubで開く</SafeGitHubLink>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {summary.aggregates.staleItemCount > 0 && (
        <p class="notice">
          古い観測値の項目は、現在の要対応queueから除外しています。一覧で内容を確認できます。
        </p>
      )}
    </section>
  );
}

function ItemTable({
  createItemHref,
  filters,
  locale,
  now,
  onFilterChange,
  onSelectItem,
  onSortChange,
  searchState,
  sort,
  summary,
}: ItemTableProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const rows = useMemo(() => createItemTableRows(summary, now, locale), [summary, now, locale]);
  const searchedRows = useMemo(() => {
    switch (searchState.status) {
      case "inactive":
        return rows;
      case "available": {
        const matchingNodeIds = new Set(searchState.nodeIds);
        return rows.filter((row) => matchingNodeIds.has(row.item.nodeId));
      }
      case "loading":
      case "failed":
        return [];
      default:
        throw new Error("未対応の検索状態です");
    }
  }, [rows, searchState]);
  const filteredRows = useMemo(
    () => filterAndSortTableRows(searchedRows, filters, sort, locale),
    [searchedRows, filters, sort, locale],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / TABLE_PAGE_SIZE));
  const firstRowIndex = pageIndex * TABLE_PAGE_SIZE;
  const visibleRows = filteredRows.slice(firstRowIndex, firstRowIndex + TABLE_PAGE_SIZE);

  function updateFilter(key: TableColumnKey, value: string): void {
    onFilterChange(key, value);
    setPageIndex(0);
  }

  function updateSort(key: TableColumnKey): void {
    onSortChange(key);
    setPageIndex(0);
  }

  useEffect(() => {
    setPageIndex(0);
  }, [filters, searchState, sort]);

  return (
    <section aria-labelledby="items-heading" class="section-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">All items</p>
          <h2 id="items-heading">全項目一覧</h2>
        </div>
        <p>
          {filteredRows.length.toLocaleString(locale)}件を表示対象にしています。列名で並び替え、
          入力欄で列ごとに絞り込めます。
        </p>
      </div>
      <div class="table-scroll">
        <table class="items-table">
          <caption class="visually-hidden">全追跡項目をグラフなしで確認できる一覧</caption>
          <thead>
            <tr>
              {TABLE_COLUMNS.map((column) => (
                <th
                  scope="col"
                  key={column.key}
                  aria-sort={sort.key === column.key ? sort.direction : "none"}
                >
                  <button
                    class="sort-button"
                    type="button"
                    onClick={() => {
                      updateSort(column.key);
                    }}
                  >
                    {column.label}
                    <span aria-hidden="true" class="sort-indicator">
                      {sort.key === column.key ? (sort.direction === "ascending" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                  <label class="filter-label">
                    <span class="visually-hidden">{column.label}で絞り込み</span>
                    <input
                      type="search"
                      value={filters[column.key]}
                      maxLength={200}
                      aria-label={`${column.label}で絞り込み`}
                      placeholder="絞り込み"
                      onInput={(event) => {
                        updateFilter(column.key, event.currentTarget.value);
                      }}
                    />
                  </label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.item.nodeId}
                data-node-id={row.item.nodeId}
                data-freshness={row.item.repositoryFreshness}
                class={row.item.repositoryFreshness === "stale" ? "stale-row" : ""}
              >
                <th scope="row">
                  <span class="repository-name">{row.repository.fullName}</span>
                  <ItemDetailsLink
                    href={createItemHref(row.item.nodeId)}
                    nodeId={row.item.nodeId}
                    onSelect={onSelectItem}
                  >
                    {row.item.displayReference} {row.item.title}
                  </ItemDetailsLink>
                  <SafeGitHubLink href={row.item.url}>GitHubで開く</SafeGitHubLink>
                  {row.item.repositoryFreshness === "stale" && (
                    <span class="freshness-badge freshness-stale">古い観測値</span>
                  )}
                </th>
                <td>{row.typeText}</td>
                <td>
                  <span>{statusLabel(row.item.status)}</span>
                  <span class={`severity-badge severity-${row.item.severity}`}>
                    {severityLabel(row.item.severity)}
                  </span>
                  <span class="priority-badge">優先度 {attentionPriority(row.item).label}</span>
                </td>
                <td>{formatWaitingOn(row.item, summary.confidenceThresholds)}</td>
                <td>
                  <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
                  <time dateTime={row.item.stallSince}>
                    {formatJstDateTime(row.item.stallSince, locale)}
                  </time>
                </td>
                <td>{row.blockerText}</td>
                <td>
                  <TimeDisplay
                    label="GitHub更新"
                    value={row.item.githubUpdatedAt}
                    now={now}
                    locale={locale}
                  />
                  <TimeDisplay
                    label="項目観測"
                    value={row.item.observedAt}
                    now={now}
                    locale={locale}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <p class="empty-state">
            {searchState.status === "loading"
              ? "検索用の公開詳細データを読み込んでいます。"
              : searchState.status === "failed"
                ? "検索用の公開詳細データを取得できませんでした。"
                : "条件に一致する項目はありません。"}
          </p>
        )}
      </div>
      <nav aria-label="一覧のページ送り" class="pagination">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => {
            setPageIndex((currentPage) => currentPage - 1);
          }}
        >
          前のページ
        </button>
        <p aria-live="polite">
          {pageIndex + 1} / {pageCount}ページ
        </p>
        <button
          type="button"
          disabled={pageIndex + 1 >= pageCount}
          onClick={() => {
            setPageIndex((currentPage) => currentPage + 1);
          }}
        >
          次のページ
        </button>
      </nav>
    </section>
  );
}

/** 公開summary DTOを一覧画面として表示する。 */
export function App({ loadDetails, locale, now, summary, title }: AppProps) {
  const validItemNodeIds = useMemo(
    () => new Set(summary.items.map((item) => item.nodeId)),
    [summary.items],
  );
  const validGraphClusterIds = useMemo<ValidGraphClusterIds>(
    () => ({
      componentIds: new Set(summary.graph.components.map((component) => component.id)),
      repositoryIds: new Set(
        summary.graph.repositoryClusters.map((cluster) => cluster.repositoryId),
      ),
    }),
    [summary.graph.components, summary.graph.repositoryClusters],
  );
  const sharedLoadDetails = useMemo(() => createSharedDetailsLoader(loadDetails), [loadDetails]);
  const [navigationState, setNavigationState] = useState<ParsedWebViewState>(() =>
    parseWebViewState(window.location.search, validItemNodeIds, validGraphClusterIds),
  );
  const [detailsState, setDetailsState] = useState<ItemDetailsState>({
    status: "not_requested",
  });
  const viewState = navigationState.state;
  const detailsNeeded =
    viewState.searchQuery.trim().length > 0 || viewState.selection.status === "selected";

  useEffect(() => {
    if (navigationState.status === "sanitized") {
      window.history.replaceState(
        {},
        "",
        createWebViewHref(window.location.pathname, navigationState.state),
      );
    }
  }, [navigationState]);

  useEffect(() => {
    function applyBrowserHistory(): void {
      const parsedState = parseWebViewState(
        window.location.search,
        validItemNodeIds,
        validGraphClusterIds,
      );
      if (parsedState.status === "sanitized") {
        window.history.replaceState(
          {},
          "",
          createWebViewHref(window.location.pathname, parsedState.state),
        );
      }
      setNavigationState(parsedState);
    }
    window.addEventListener("popstate", applyBrowserHistory);
    return () => {
      window.removeEventListener("popstate", applyBrowserHistory);
    };
  }, [validGraphClusterIds, validItemNodeIds]);

  useEffect(() => {
    if (!detailsNeeded || detailsState.status !== "not_requested") {
      return;
    }
    setDetailsState({
      status: "loading",
    });
    void sharedLoadDetails()
      .then((details) => {
        setDetailsState({
          status: "loaded",
          itemsByNodeId: createItemDetailsMap(summary, details),
          graphNodesByNodeId: new Map(details.graph.nodes.map((node) => [node.nodeId, node])),
        });
      })
      .catch((error: unknown) => {
        console.error("項目検索と詳細表示の公開データ取得に失敗しました", error);
        setDetailsState({
          status: "failed",
        });
      });
  }, [detailsNeeded, detailsState.status, sharedLoadDetails, summary]);

  const searchState = useMemo<ItemSearchState>(() => {
    if (viewState.searchQuery.trim().length === 0) {
      return {
        status: "inactive",
      };
    }
    switch (detailsState.status) {
      case "not_requested":
      case "loading":
        return {
          status: "loading",
        };
      case "loaded":
        return {
          status: "available",
          nodeIds: searchItemNodeIds(summary, detailsState.itemsByNodeId, viewState.searchQuery),
        };
      case "failed":
        return {
          status: "failed",
        };
      default:
        throw new UnreachableError(detailsState);
    }
  }, [detailsState, summary, viewState.searchQuery]);

  function navigate(nextState: WebViewState, mode: "push" | "replace"): void {
    const href = createWebViewHref(window.location.pathname, nextState);
    if (mode === "push") {
      window.history.pushState({}, "", href);
    } else {
      window.history.replaceState({}, "", href);
    }
    setNavigationState({
      status: "valid",
      state: nextState,
    });
  }

  function selectItem(nodeId: string): void {
    if (!validItemNodeIds.has(nodeId)) {
      throw new TypeError(`選択できない項目です: ${nodeId}`);
    }
    navigate(
      {
        ...viewState,
        selection: {
          status: "selected",
          nodeId,
        },
      },
      "push",
    );
  }

  function clearSelection(): void {
    navigate(
      {
        ...viewState,
        selection: {
          status: "none",
        },
      },
      "push",
    );
  }

  function selectGraphCluster(selection: GraphSelection): void {
    if (selection.status === "selected") {
      const validIds =
        selection.kind === "component"
          ? validGraphClusterIds.componentIds
          : validGraphClusterIds.repositoryIds;
      const selectedId =
        selection.kind === "component" ? selection.componentId : selection.repositoryId;
      if (!validIds.has(selectedId)) {
        throw new TypeError(`選択できない依存グラフclusterです: ${selectedId}`);
      }
    }
    navigate(
      {
        ...viewState,
        graphSelection: selection,
      },
      "push",
    );
  }

  function replaceSearchQuery(searchQuery: string): void {
    navigate(
      {
        ...viewState,
        searchQuery,
      },
      "replace",
    );
  }

  function replaceTableFilter(key: TableColumnKey, value: string): void {
    navigate(
      {
        ...viewState,
        tableFilters: {
          ...viewState.tableFilters,
          [key]: value,
        },
      },
      "replace",
    );
  }

  function replaceTableSort(key: TableColumnKey): void {
    navigate(
      {
        ...viewState,
        tableSort: {
          key,
          direction:
            viewState.tableSort.key === key && viewState.tableSort.direction === "ascending"
              ? "descending"
              : "ascending",
        },
      },
      "replace",
    );
  }

  function createItemHref(nodeId: string): string {
    if (!validItemNodeIds.has(nodeId)) {
      throw new TypeError(`deep linkを作成できない項目です: ${nodeId}`);
    }
    return createWebViewHref(window.location.pathname, {
      ...viewState,
      selection: {
        status: "selected",
        nodeId,
      },
    });
  }

  const clearSelectionHref = createWebViewHref(window.location.pathname, {
    ...viewState,
    selection: {
      status: "none",
    },
  });

  return (
    <>
      <a class="skip-link" href="#main-content">
        本文へ移動
      </a>
      <header class="site-header">
        <div>
          <p class="eyebrow">VOICEVOX Organization</p>
          <h1>{title}</h1>
          <p>IssueとPull Requestの現在地、次の担当、停滞を一か所で確認できます。</p>
        </div>
        <p class="run-id">Run {summary.runId}</p>
      </header>
      <main id="main-content">
        {navigationState.status === "sanitized" && (
          <p class="notice notice-warning url-state-notice" role="status" aria-live="polite">
            URLに含まれる不正または未対応の表示条件を無視しました。
          </p>
        )}
        <Dashboard summary={summary} now={now} locale={locale} />
        <RepositoryFreshness summary={summary} now={now} locale={locale} />
        <ItemWorkspace
          clearSelectionHref={clearSelectionHref}
          createItemHref={createItemHref}
          detailsState={detailsState}
          locale={locale}
          now={now}
          searchQuery={viewState.searchQuery}
          searchState={searchState}
          selection={viewState.selection}
          summary={summary}
          onClearSearch={() => {
            replaceSearchQuery("");
          }}
          onClearSelection={clearSelection}
          onRetryDetails={() => {
            setDetailsState({
              status: "not_requested",
            });
          }}
          onSearchQueryChange={replaceSearchQuery}
          onSelectItem={selectItem}
        />
        <AttentionQueue
          createItemHref={createItemHref}
          summary={summary}
          now={now}
          locale={locale}
          onSelectItem={selectItem}
        />
        <DependencyGraph
          summary={summary}
          now={now}
          locale={locale}
          loadDetails={sharedLoadDetails}
          selection={viewState.graphSelection}
          onSelectionChange={selectGraphCluster}
        />
        <ItemTable
          createItemHref={createItemHref}
          filters={viewState.tableFilters}
          locale={locale}
          now={now}
          searchState={searchState}
          sort={viewState.tableSort}
          summary={summary}
          onFilterChange={replaceTableFilter}
          onSelectItem={selectItem}
          onSortChange={replaceTableSort}
        />
      </main>
      <footer>
        <p>GitHubの公開情報を読み取り専用で整理しています。</p>
      </footer>
    </>
  );
}

/** 公開DTOを読み込めなかったことを画面へ通知する。 */
export function DataLoadFailure() {
  return (
    <main class="load-failure">
      <h1>データを表示できません</h1>
      <p>公開データの読み込みまたは検証に失敗しました。時間を置いて再度確認してください。</p>
    </main>
  );
}

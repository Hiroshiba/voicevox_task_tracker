import { type ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { DependencyGraphPage } from "./dependency-graph-page.js";
import { type PublicDetailsLoader } from "./dependency-graph.js";
import { createSharedDetailsLoader } from "./details-loader.js";
import { ItemDetailsPage } from "./item-details-page.js";
import { ItemsPage } from "./items-page.js";
import { type TableColumnKey } from "./model.js";
import { OverviewPage } from "./overview-page.js";
import { RepositoriesPage } from "./repositories-page.js";
import {
  createItemRouteTargets,
  createWebViewHref,
  createWebViewState,
  parseWebViewState,
  type GraphSelection,
  type ParsedWebViewState,
  type ValidWebRouteTargets,
  type WebRoute,
  type WebViewState,
} from "./url-state.js";

type AppProps = Readonly<{
  basePath: string;
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
  title: string;
}>;

type NavigationPage = "overview" | "items" | "graph" | "repositories";

const NAVIGATION_PAGES: readonly Readonly<{
  label: string;
  page: NavigationPage;
}>[] = [
  {
    label: "概要",
    page: "overview",
  },
  {
    label: "項目一覧",
    page: "items",
  },
  {
    label: "依存グラフ",
    page: "graph",
  },
  {
    label: "リポジトリ",
    page: "repositories",
  },
];

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

function routeForNavigationPage(page: NavigationPage): WebRoute {
  switch (page) {
    case "overview":
      return {
        page: "overview",
      };
    case "items":
      return {
        page: "items",
      };
    case "graph":
      return {
        page: "graph",
        selection: {
          status: "none",
        },
      };
    case "repositories":
      return {
        page: "repositories",
      };
  }
}

function isCurrentNavigationPage(route: WebRoute, page: NavigationPage): boolean {
  if (route.page === "item-details") {
    return page === "items";
  }
  return route.page === page;
}

function replaceWebViewUrl(basePath: string, state: WebViewState): void {
  window.history.replaceState(
    {},
    "",
    `${createWebViewHref(basePath, state)}${window.location.hash}`,
  );
}

/** 公開summary DTOをpathnameで選択したページとして表示する。 */
export function App({ basePath, loadDetails, locale, now, summary, title }: AppProps) {
  const itemTargets = useMemo(() => createItemRouteTargets(summary.items), [summary.items]);
  const itemTargetsByNodeId = useMemo(
    () => new Map(itemTargets.map((target) => [target.nodeId, target])),
    [itemTargets],
  );
  const validTargets = useMemo<ValidWebRouteTargets>(
    () => ({
      items: itemTargets,
      graphClusters: {
        componentIds: new Set(summary.graph.components.map((component) => component.id)),
        repositoryIds: new Set(
          summary.graph.repositoryClusters.map((cluster) => cluster.repositoryId),
        ),
      },
    }),
    [itemTargets, summary.graph.components, summary.graph.repositoryClusters],
  );
  const sharedLoadDetails = useMemo(() => createSharedDetailsLoader(loadDetails), [loadDetails]);
  const [navigationState, setNavigationState] = useState<ParsedWebViewState>(() =>
    parseWebViewState(window.location, basePath, validTargets),
  );
  const viewState = navigationState.state;

  useEffect(() => {
    if (navigationState.status !== "valid") {
      replaceWebViewUrl(basePath, navigationState.state);
    }
  }, [basePath, navigationState]);

  useEffect(() => {
    function applyBrowserHistory(): void {
      const parsedState = parseWebViewState(window.location, basePath, validTargets);
      if (parsedState.status !== "valid") {
        replaceWebViewUrl(basePath, parsedState.state);
      }
      setNavigationState(parsedState);
    }
    window.addEventListener("popstate", applyBrowserHistory);
    return () => {
      window.removeEventListener("popstate", applyBrowserHistory);
    };
  }, [basePath, validTargets]);

  function navigate(nextState: WebViewState, mode: "push" | "replace"): void {
    const href = createWebViewHref(basePath, nextState);
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
    const target = itemTargetsByNodeId.get(nodeId);
    if (target == null) {
      throw new TypeError(`選択できない項目です: ${nodeId}`);
    }
    navigate(
      createWebViewState({
        page: "item-details",
        target,
      }),
      "push",
    );
  }

  function selectGraphCluster(selection: GraphSelection): void {
    if (selection.status === "selected") {
      const validIds =
        selection.kind === "component"
          ? validTargets.graphClusters.componentIds
          : validTargets.graphClusters.repositoryIds;
      const selectedId =
        selection.kind === "component" ? selection.componentId : selection.repositoryId;
      if (!validIds.has(selectedId)) {
        throw new TypeError(`選択できない依存グラフclusterです: ${selectedId}`);
      }
    }
    navigate(
      createWebViewState({
        page: "graph",
        selection,
      }),
      "push",
    );
  }

  function replaceSearchQuery(searchQuery: string): void {
    if (viewState.route.page !== "items") {
      throw new TypeError("項目一覧以外では検索条件を変更できません");
    }
    navigate(
      {
        ...viewState,
        searchQuery,
      },
      "replace",
    );
  }

  function replaceTableFilter(key: TableColumnKey, value: string): void {
    if (viewState.route.page !== "items") {
      throw new TypeError("項目一覧以外では表の絞り込み条件を変更できません");
    }
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
    if (viewState.route.page !== "items") {
      throw new TypeError("項目一覧以外では表の並び順を変更できません");
    }
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
    const target = itemTargetsByNodeId.get(nodeId);
    if (target == null) {
      throw new TypeError(`deep linkを作成できない項目です: ${nodeId}`);
    }
    return createWebViewHref(
      basePath,
      createWebViewState({
        page: "item-details",
        target,
      }),
    );
  }

  function renderPage(): ComponentChildren {
    switch (viewState.route.page) {
      case "overview":
        return (
          <OverviewPage
            createItemHref={createItemHref}
            itemsHref={createWebViewHref(
              basePath,
              createWebViewState({
                page: "items",
              }),
            )}
            locale={locale}
            now={now}
            summary={summary}
            onSelectItem={selectItem}
            onSelectItems={() => {
              navigateToPage("items");
            }}
            onSelectRepositories={() => {
              navigateToPage("repositories");
            }}
            repositoriesHref={createWebViewHref(
              basePath,
              createWebViewState({
                page: "repositories",
              }),
            )}
          />
        );
      case "items":
        return (
          <ItemsPage
            createItemHref={createItemHref}
            filters={viewState.tableFilters}
            loadDetails={sharedLoadDetails}
            locale={locale}
            now={now}
            searchQuery={viewState.searchQuery}
            sort={viewState.tableSort}
            summary={summary}
            onFilterChange={replaceTableFilter}
            onSearchQueryChange={replaceSearchQuery}
            onSelectItem={selectItem}
            onSortChange={replaceTableSort}
          />
        );
      case "item-details":
        return (
          <ItemDetailsPage
            key={viewState.route.target.nodeId}
            clearSelectionHref={createWebViewHref(
              basePath,
              createWebViewState({
                page: "items",
              }),
            )}
            createItemHref={createItemHref}
            loadDetails={sharedLoadDetails}
            locale={locale}
            now={now}
            summary={summary}
            target={viewState.route.target}
            onClearSelection={() => {
              navigate(
                createWebViewState({
                  page: "items",
                }),
                "push",
              );
            }}
            onSelectItem={selectItem}
          />
        );
      case "graph":
        return (
          <DependencyGraphPage
            loadDetails={sharedLoadDetails}
            locale={locale}
            now={now}
            selection={viewState.route.selection}
            summary={summary}
            onSelectionChange={selectGraphCluster}
          />
        );
      case "repositories":
        return <RepositoriesPage locale={locale} now={now} summary={summary} />;
      default:
        throw new UnreachableError(viewState.route);
    }
  }

  function navigateToPage(page: NavigationPage): void {
    navigate(createWebViewState(routeForNavigationPage(page)), "push");
  }

  return (
    <>
      <a class="skip-link" href="#main-content">
        本文へ移動
      </a>
      <header class="site-header">
        <div class="site-identity">
          <p class="eyebrow">VOICEVOX Organization</p>
          <h1>{title}</h1>
        </div>
        <nav class="global-navigation" aria-label="グローバルナビゲーション">
          <ul>
            {NAVIGATION_PAGES.map((navigationPage) => {
              const route = routeForNavigationPage(navigationPage.page);
              const href = createWebViewHref(basePath, createWebViewState(route));
              return (
                <li key={navigationPage.page}>
                  <a
                    href={href}
                    aria-current={
                      isCurrentNavigationPage(viewState.route, navigationPage.page)
                        ? "page"
                        : undefined
                    }
                    onClick={(event) => {
                      if (!shouldHandleClientNavigation(event)) {
                        return;
                      }
                      event.preventDefault();
                      navigateToPage(navigationPage.page);
                    }}
                  >
                    {navigationPage.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <details class="run-details">
          <summary>実行情報</summary>
          <p class="run-id">Run {summary.runId}</p>
        </details>
      </header>
      <main id="main-content">
        {navigationState.status === "sanitized" && (
          <p class="notice notice-warning url-state-notice" role="status" aria-live="polite">
            URLに含まれる不正または未対応の表示条件を無視しました。
          </p>
        )}
        {renderPage()}
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

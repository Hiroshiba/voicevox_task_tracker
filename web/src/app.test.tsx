import axe from "axe-core";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import indexHtml from "../index.html?raw";
import sampleDetailsSource from "../public/data/details.json";
import sampleSummarySource from "../public/data/summary.json";
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { App } from "./app.js";
import {
  compareAttentionItems,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  selectAttentionItems,
  type TableColumnKey,
  type TableFilters,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const LOCALE = "ja-JP";
const TITLE = "VOICEVOX Task Tracker";
const BASE_PATH = "/voicevox_task_tracker/";
const sampleDetails = createPublicDetailsDto(sampleDetailsSource);
const sampleSummary = createPublicSummaryDto(sampleSummarySource);
const TABLE_COLUMN_KEYS: readonly TableColumnKey[] = [
  "repository",
  "type",
  "status",
  "waitingOn",
  "stall",
  "blocker",
  "updated",
];

let container: HTMLDivElement | undefined;

function currentContainer(): HTMLDivElement {
  assertNonNullable(container, "テスト用の描画先がありません");
  return container;
}

function renderApp(summary: PublicSummaryDto): void {
  renderAppWithDetails(summary, sampleDetails);
}

function renderAppWithDetails(summary: PublicSummaryDto, details: PublicDetailsDto): void {
  renderAppWithLoader(summary, () => Promise.resolve(details));
}

function renderAppWithLoader(
  summary: PublicSummaryDto,
  loadDetails: () => Promise<PublicDetailsDto>,
): void {
  act(() => {
    render(
      <App
        basePath={BASE_PATH}
        loadDetails={loadDetails}
        locale={LOCALE}
        now={NOW}
        summary={summary}
        title={TITLE}
      />,
      currentContainer(),
    );
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

async function enterSearch(value: string): Promise<void> {
  const search = requiredElement<HTMLInputElement>("#item-search-input");
  await act(async () => {
    search.value = value;
    search.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
      }),
    );
    await Promise.resolve();
  });
  await flushUi();
}

function definitionValue(label: string): string {
  const term = [...currentContainer().querySelectorAll("dt")].find(
    (candidate) => candidate.textContent === label,
  );
  assertNonNullable(term, `${label}の集計名がありません`);
  const value = term.nextElementSibling;
  assertNonNullable(value, `${label}の集計値がありません`);
  return value.textContent ?? "";
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = currentContainer().querySelector<ElementType>(selector);
  assertNonNullable(element, `要素がありません: ${selector}`);
  return element;
}

function itemRowNodeIds(): readonly string[] {
  return [...currentContainer().querySelectorAll<HTMLTableRowElement>(".items-table tbody tr")].map(
    (row) => row.dataset["nodeId"] ?? "",
  );
}

type OrderingItemOptions = Readonly<{
  nodeId: string;
  severity: PublicItemSummaryDto["severity"];
  status: PublicItemSummaryDto["status"];
  priorityWeight: number;
  repositoryCount: number;
  openNodeCount: number;
  stallSince: string;
}>;

function createOrderingItem(options: OrderingItemOptions): PublicItemSummaryDto {
  const source = sampleSummary.items[0];
  assertNonNullable(source, "並び順テストの基準項目がありません");
  return {
    ...source,
    nodeId: options.nodeId,
    severity: options.severity,
    status: options.status,
    priorityWeight: options.priorityWeight,
    stallSince: options.stallSince,
    downstreamImpact: {
      nodeId: options.nodeId,
      repositoryCount: options.repositoryCount,
      openNodeCount: options.openNodeCount,
    },
  };
}

function filtersWith(key: TableColumnKey, value: string): TableFilters {
  return {
    ...createEmptyTableFilters(),
    [key]: value,
  };
}

function colorChannel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  return (
    0.2126 * colorChannel(hex, 0) + 0.7152 * colorChannel(hex, 2) + 0.0722 * colorChannel(hex, 4)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/voicevox_task_tracker/");
  container = document.createElement("div");
  document.body.replaceChildren(currentContainer());
});

afterEach(() => {
  render(null, currentContainer());
  document.body.replaceChildren();
  container = undefined;
});

describe("Web UI", () => {
  it("要対応項目を先頭にして主要集計、観測時刻、AI unavailableを表示する", () => {
    renderApp(sampleSummary);

    const mainSections = [
      ...requiredElement<HTMLElement>("main").querySelectorAll(":scope > section"),
    ];
    expect(mainSections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "対応が必要な項目",
      "全体の状況",
    ]);
    expect(definitionValue("リポジトリ")).toBe("3件");
    expect(definitionValue("項目")).toBe("5件");
    expect(definitionValue("鮮度要確認")).toContain("1リポジトリ");
    expect(
      requiredElement<HTMLAnchorElement>(
        '.metric-with-link a[href="/voicevox_task_tracker/repositories"]',
      ),
    ).not.toBeNull();

    const aggregateDetails = requiredElement<HTMLDetailsElement>(".aggregate-details");
    expect(aggregateDetails.open).toBe(false);
    expect(definitionValue("unknown項目")).toBe("0");
    expect(definitionValue("古い観測値の項目")).toBe("1");
    expect(definitionValue("マージ可能")).toBe("1");
    expect(definitionValue("レビュー待ち")).toBe("1");
    expect(
      [...aggregateDetails.querySelectorAll("dt")].map((element) => element.textContent),
    ).not.toContain("未トリアージ");
    expect(
      [...aggregateDetails.querySelectorAll("dt")].map((element) => element.textContent),
    ).not.toContain("通常");
    expect(currentContainer().textContent).toContain("AIを利用できなかったため");
    const observedTime = requiredElement<HTMLTimeElement>(".overview-observed-time time");
    expect(observedTime.dateTime).toBe(sampleSummary.observedAt);
    expect(observedTime.textContent).toBe("1 日前");
    expect(observedTime.parentElement?.querySelector(".absolute-time")?.textContent).toContain(
      "JST",
    );
  });

  it("グローバルナビゲーションを実リンクとして表示しpathごとにページを切り替える", () => {
    const loadDetails = vi.fn(() => Promise.resolve(sampleDetails));
    renderAppWithLoader(sampleSummary, loadDetails);

    const overviewLink = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/"]',
    );
    const itemsLink = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/items"]',
    );
    const graphLink = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/graph"]',
    );
    const repositoriesLink = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/repositories"]',
    );
    expect(overviewLink.getAttribute("aria-current")).toBe("page");
    expect(requiredElement<HTMLDetailsElement>(".run-details").open).toBe(false);
    expect(currentContainer().textContent).toContain("対応が必要な項目");
    expect(currentContainer().querySelector(".items-table")).toBeNull();

    act(() => {
      itemsLink.click();
    });
    expect(window.location.pathname).toBe("/voicevox_task_tracker/items");
    expect(itemsLink.getAttribute("aria-current")).toBe("page");
    expect(currentContainer().querySelector(".items-table")).not.toBeNull();

    act(() => {
      graphLink.click();
    });
    expect(window.location.pathname).toBe("/voicevox_task_tracker/graph");
    expect(currentContainer().textContent).toContain("依存グラフ");

    act(() => {
      repositoriesLink.click();
    });
    expect(window.location.pathname).toBe("/voicevox_task_tracker/repositories");
    expect(currentContainer().textContent).toContain("リポジトリの鮮度");
    expect(loadDetails).not.toHaveBeenCalled();
  });

  it.each([
    {
      path: "/voicevox_task_tracker/items/",
      canonicalPath: "/voicevox_task_tracker/items",
      pageSelector: ".items-table",
    },
    {
      path: "/voicevox_task_tracker/graph/",
      canonicalPath: "/voicevox_task_tracker/graph",
      pageSelector: ".component-browser",
    },
    {
      path: "/voicevox_task_tracker/repositories/",
      canonicalPath: "/voicevox_task_tracker/repositories",
      pageSelector: ".freshness-table",
    },
  ])(
    "末尾スラッシュ付きの$pageSelectorを警告なしで表示してURLを正規化する",
    ({ path, canonicalPath, pageSelector }) => {
      window.history.replaceState({}, "", path);

      renderApp(sampleSummary);

      expect(currentContainer().querySelector(pageSelector)).not.toBeNull();
      expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
      expect(window.location.pathname).toBe(canonicalPath);
    },
  );

  it("末尾スラッシュ付きの項目詳細pathを警告なしで表示してURLを正規化する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103/");

    renderApp(sampleSummary);
    await flushUi();

    expect(
      currentContainer().querySelector('.item-details-card[data-node-id="sample-item-editor-103"]'),
    ).not.toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/items/sample-editor/103");
  });

  it("末尾スラッシュ付きのcluster pathを警告なしで表示してURLを正規化する", async () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/graph/repository/sample-repository-editor/",
    );

    renderApp(sampleSummary);
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    expect(
      requiredElement<HTMLInputElement>('input[name="graph-cluster-kind"][value="repository"]')
        .checked,
    ).toBe(true);
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe(
      "/voicevox_task_tracker/graph/repository/sample-repository-editor",
    );
  });

  it("スキップリンクのhashが付いたURLを補正対象にしない", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items#main-content");

    renderApp(sampleSummary);

    expect(currentContainer().querySelector(".items-table")).not.toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/items");
    expect(window.location.hash).toBe("#main-content");
  });

  it("popstateでpathnameと項目一覧queryを復元する", () => {
    renderApp(sampleSummary);
    window.history.pushState(
      {},
      "",
      "/voicevox_task_tracker/items?repo=sample-core&sort=updated&direction=descending",
    );

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/items");
    expect(
      requiredElement<HTMLInputElement>('input[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("sample-core");
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("updated");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
  });

  it("公開DTOのtimezoneを絶対時刻へ反映する", () => {
    const newYorkFixture = createPublicSummaryDto({
      ...sampleSummary,
      timezone: "America/New_York",
    });

    renderApp(newYorkFixture);

    const generatedTime = requiredElement<HTMLTimeElement>(
      `.aggregate-details time[datetime="${newYorkFixture.generatedAt}"]`,
    );
    expect(generatedTime.textContent).toBe("24 時間前");
    expect(generatedTime.parentElement?.querySelector(".absolute-time")?.textContent).toBe(
      "2026/07/30 20:05:00 GMT-4",
    );
  });

  it("公開DTOのtimezoneを必須とする", () => {
    expect(() =>
      createPublicSummaryDto({
        ...sampleSummary,
        timezone: undefined,
      }),
    ).toThrow();
  });

  it("AI無効をAI利用失敗と区別して表示する", () => {
    renderApp({
      ...sampleSummary,
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
    });

    expect(currentContainer().textContent).toContain("AI分析は設定で無効です");
    expect(currentContainer().textContent).not.toContain("AIを利用できなかったため");
  });

  it("AIを利用できる縮退runを完全成功と区別して表示する", () => {
    renderApp({
      ...sampleSummary,
      ai: {
        enabled: true,
        available: true,
        degraded: true,
      },
    });

    expect(currentContainer().textContent).toContain("AI分析の一部が縮退したため");
    expect(currentContainer().textContent).not.toContain("AIを利用できなかったため");
  });

  it("AI分析が正常なときは状態通知を表示しない", () => {
    renderApp({
      ...sampleSummary,
      ai: {
        enabled: true,
        available: true,
        degraded: false,
      },
    });

    expect(currentContainer().querySelector(".ai-state-notice")).toBeNull();
  });

  it("要対応項目の主情報を常時表示し補助情報を折りたたむ", () => {
    renderApp(sampleSummary);

    const firstItem = requiredElement<HTMLElement>(
      '.attention-list li[data-node-id="sample-item-editor-101"]',
    );
    expect(firstItem.querySelector("h3")?.textContent).toBe("サンプル辞書更新をマージする");
    expect(firstItem.querySelector(".item-reference")?.textContent).toContain(
      "VOICEVOX/sample-editor #101",
    );
    expect(firstItem.querySelector(".attention-primary-details")?.textContent).toContain(
      "マージ判断者",
    );
    expect(firstItem.querySelector(".attention-primary-details")?.textContent).toContain("12日");
    expect(firstItem.querySelector(".severity-critical")?.textContent).toBe("最重要");

    const supportingDetails = requiredElement<HTMLDetailsElement>(
      '.attention-list li[data-node-id="sample-item-editor-101"] .attention-more',
    );
    expect(supportingDetails.open).toBe(false);
    expect(supportingDetails.textContent).toContain("対応優先度");
    expect(supportingDetails.textContent).toContain("影響範囲");
    expect(supportingDetails.textContent).toContain("項目観測");
  });

  it("attention queueをseverity、対応優先度、影響範囲、停滞時間で並べる", () => {
    expect(selectAttentionItems(sampleSummary.items).map((item) => item.nodeId)).toEqual([
      "sample-item-editor-101",
      "sample-item-engine-202",
      "sample-item-editor-103",
      "sample-item-engine-204",
    ]);

    const critical = createOrderingItem({
      nodeId: "critical",
      severity: "critical",
      status: "blocked",
      priorityWeight: 0,
      repositoryCount: 0,
      openNodeCount: 0,
      stallSince: "2026-07-31T00:00:00.000Z",
    });
    const urgent = createOrderingItem({
      nodeId: "urgent",
      severity: "urgent",
      status: "ready_to_merge",
      priorityWeight: 100,
      repositoryCount: 10,
      openNodeCount: 100,
      stallSince: "2026-07-01T00:00:00.000Z",
    });
    const highPriority = createOrderingItem({
      nodeId: "high-priority",
      severity: "urgent",
      status: "ready_to_merge",
      priorityWeight: 25,
      repositoryCount: 0,
      openNodeCount: 0,
      stallSince: "2026-07-31T00:00:00.000Z",
    });
    const mediumPriority = createOrderingItem({
      nodeId: "medium-priority",
      severity: "urgent",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 10,
      openNodeCount: 100,
      stallSince: "2026-07-01T00:00:00.000Z",
    });
    const widerRepositoryImpact = createOrderingItem({
      nodeId: "repository-impact",
      severity: "watch",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 3,
      openNodeCount: 1,
      stallSince: "2026-07-31T00:00:00.000Z",
    });
    const narrowerRepositoryImpact = createOrderingItem({
      nodeId: "narrow-repository-impact",
      severity: "watch",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 2,
      openNodeCount: 100,
      stallSince: "2026-07-01T00:00:00.000Z",
    });
    const widerItemImpact = createOrderingItem({
      nodeId: "item-impact",
      severity: "watch",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 2,
      openNodeCount: 5,
      stallSince: "2026-07-31T00:00:00.000Z",
    });
    const narrowerItemImpact = createOrderingItem({
      nodeId: "narrow-item-impact",
      severity: "watch",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 2,
      openNodeCount: 4,
      stallSince: "2026-07-01T00:00:00.000Z",
    });
    const olderStall = createOrderingItem({
      nodeId: "older-stall",
      severity: "watch",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 1,
      openNodeCount: 1,
      stallSince: "2026-07-01T00:00:00.000Z",
    });
    const newerStall = createOrderingItem({
      nodeId: "newer-stall",
      severity: "watch",
      status: "waiting_for_review",
      priorityWeight: 12,
      repositoryCount: 1,
      openNodeCount: 1,
      stallSince: "2026-07-02T00:00:00.000Z",
    });

    expect(compareAttentionItems(critical, urgent)).toBeLessThan(0);
    expect(compareAttentionItems(highPriority, mediumPriority)).toBeLessThan(0);
    expect(compareAttentionItems(widerRepositoryImpact, narrowerRepositoryImpact)).toBeLessThan(0);
    expect(compareAttentionItems(widerItemImpact, narrowerItemImpact)).toBeLessThan(0);
    expect(compareAttentionItems(olderStall, newerStall)).toBeLessThan(0);
  });

  it("一覧の全列でfilterとsortを適用する", () => {
    const rows = createItemTableRows(sampleSummary, NOW, LOCALE);
    const filterCases: readonly Readonly<{
      key: TableColumnKey;
      value: string;
      expectedNodeIds: readonly string[];
    }>[] = [
      {
        key: "repository",
        value: "sample-core",
        expectedNodeIds: ["sample-item-core-305"],
      },
      {
        key: "type",
        value: "Issue",
        expectedNodeIds: ["sample-item-editor-103", "sample-item-engine-204"],
      },
      {
        key: "status",
        value: "マージ可能",
        expectedNodeIds: ["sample-item-editor-101"],
      },
      {
        key: "waitingOn",
        value: "sample-reviewers",
        expectedNodeIds: ["sample-item-engine-202"],
      },
      {
        key: "stall",
        value: "31日",
        expectedNodeIds: ["sample-item-engine-204"],
      },
      {
        key: "blocker",
        value: "sample-editor#103",
        expectedNodeIds: ["sample-item-engine-204"],
      },
      {
        key: "updated",
        value: "2026-07-29T06",
        expectedNodeIds: ["sample-item-engine-202"],
      },
    ];

    for (const filterCase of filterCases) {
      const filtered = filterAndSortTableRows(
        rows,
        filtersWith(filterCase.key, filterCase.value),
        {
          key: "repository",
          direction: "ascending",
        },
        LOCALE,
      );
      expect(filtered.map((row) => row.item.nodeId)).toEqual(filterCase.expectedNodeIds);
    }

    for (const key of TABLE_COLUMN_KEYS) {
      const ascending = filterAndSortTableRows(
        rows,
        createEmptyTableFilters(),
        {
          key,
          direction: "ascending",
        },
        LOCALE,
      );
      const descending = filterAndSortTableRows(
        rows,
        createEmptyTableFilters(),
        {
          key,
          direction: "descending",
        },
        LOCALE,
      );
      expect(ascending[0]?.item.nodeId).not.toBe(descending[0]?.item.nodeId);
    }
  });

  it("主要4列を表示し開閉式の入力とbuttonで一覧を絞り込み並び替える", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items");
    renderApp(sampleSummary);
    expect(
      [...currentContainer().querySelectorAll(".items-table thead th")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["項目", "状態", "次の担当", "停滞"]);
    const filterDetails = requiredElement<HTMLDetailsElement>(".item-filters");
    expect(filterDetails.open).toBe(false);
    expect(filterDetails.querySelectorAll('input[type="search"]')).toHaveLength(7);
    act(() => {
      requiredElement<HTMLElement>(".item-filters > summary").click();
    });
    expect(filterDetails.open).toBe(true);
    const filter = requiredElement<HTMLInputElement>('input[aria-label="リポジトリで絞り込み"]');

    act(() => {
      filter.value = "sample-core";
      filter.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
        }),
      );
    });
    expect(itemRowNodeIds()).toEqual(["sample-item-core-305"]);

    act(() => {
      filter.value = "";
      filter.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
        }),
      );
    });
    const sortKey = requiredElement<HTMLSelectElement>("#item-sort-key");

    act(() => {
      sortKey.value = "stall";
      sortKey.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(itemRowNodeIds()[0]).toBe("sample-item-engine-204");
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("stall");

    const directionButton = requiredElement<HTMLButtonElement>(".item-sort-controls button");
    act(() => {
      directionButton.click();
    });
    expect(itemRowNodeIds()[0]).toBe("sample-item-editor-101");
    expect(new URL(window.location.href).searchParams.get("direction")).toBe("descending");
    expect(requiredElement<HTMLAnchorElement>('.items-table tbody a[target="_blank"]').rel).toBe(
      "noopener noreferrer",
    );
  });

  it("GitHub由来のHTMLを文字列として描画し危険URLを遷移不能にする", () => {
    const xssTitle = '<img src="x" onerror="globalThis.__xssExecuted = true">';
    const xssSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              title: xssTitle,
            }
          : item,
      ),
    });
    renderApp(xssSummary);

    expect(currentContainer().querySelector("img")).toBeNull();
    expect(currentContainer().textContent).toContain(xssTitle);

    const dangerousUrlSource = {
      ...sampleSummary,
      items: sampleSummary.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              url: "javascript:alert(1)",
            }
          : item,
      ),
    };
    expect(() => createPublicSummaryDto(dangerousUrlSource)).toThrow();

    act(() => {
      render(
        <SafeGitHubLink href="https://example.com/VOICEVOX/sample">危険リンク</SafeGitHubLink>,
        currentContainer(),
      );
    });
    expect(currentContainer().querySelector('a[href^="https://example.com"]')).toBeNull();
    expect(currentContainer().textContent).toContain("安全でないリンクを無効化しました");
  });

  it("古い観測値のリポジトリを先に表示し正常なリポジトリを折りたたむ", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/repositories");
    renderApp(sampleSummary);

    const staleRepository = requiredElement<HTMLTableRowElement>(
      'tr[data-repository-id="sample-repository-core"]',
    );
    const freshRepository = requiredElement<HTMLTableRowElement>(
      'tr[data-repository-id="sample-repository-editor"]',
    );

    expect(staleRepository.dataset["freshness"]).toBe("stale");
    expect(staleRepository.textContent).toContain("古い観測値");
    expect(freshRepository.dataset["freshness"]).toBe("fresh");
    const repositoryRows = [
      ...currentContainer().querySelectorAll<HTMLTableRowElement>(
        ".freshness-table tbody [data-repository-id]",
      ),
    ];
    expect(repositoryRows.map((row) => row.dataset["repositoryId"])).toEqual([
      "sample-repository-core",
      "sample-repository-editor",
      "sample-repository-engine",
    ]);
    const normalRepositories = requiredElement<HTMLDetailsElement>(".freshness-normal");
    expect(normalRepositories.open).toBe(false);
    expect(normalRepositories.textContent).toContain("以下はすべて最新観測です");
    expect(normalRepositories.querySelectorAll("thead th")).toHaveLength(3);
    const freshnessScrollRegion = requiredElement<HTMLElement>(
      '[role="region"][aria-label="要確認リポジトリ鮮度表の横スクロール領域"]',
    );
    expect(freshnessScrollRegion.tabIndex).toBe(0);

    act(() => {
      render(null, currentContainer());
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items");
    renderApp(sampleSummary);
    const staleItem = requiredElement<HTMLTableRowElement>(
      '.items-table tr[data-node-id="sample-item-core-305"]',
    );
    expect(staleItem.dataset["freshness"]).toBe("stale");
    expect(staleItem.textContent).toContain("古い観測値");
  });

  it("選択項目の状況と次の行動を先に表示し内部情報を折りたたむ", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderApp(sampleSummary);
    await flushUi();

    const details = requiredElement<HTMLElement>(
      '.item-details-card[data-node-id="sample-item-engine-204"]',
    );
    expect(
      requiredElement<HTMLAnchorElement>(
        '.global-navigation a[href="/voicevox_task_tracker/items"]',
      ).getAttribute("aria-current"),
    ).toBe("page");
    expect(details.textContent).toContain("GitHubで項目を開く");
    const currentAction = requiredElement<HTMLElement>(".current-action-panel");
    expect(currentAction.textContent).toContain("現在のstatus");
    expect(currentAction.textContent).toContain("ブロック中");
    expect(currentAction.textContent).toContain("次の担当");
    expect(currentAction.textContent).toContain("waitingOn");
    expect(currentAction.textContent).toContain("VOICEVOX/sample-editor#103");
    expect(currentAction.textContent).toContain("次の行動");
    expect(currentAction.textContent).toContain("31日");
    expect(currentAction.querySelectorAll(".waiting-on-list > li")).toHaveLength(2);
    expect(currentAction.querySelectorAll(".primary-blocker-badge")).toHaveLength(1);
    expect(currentAction.querySelector(".blocker-list")).toBeNull();
    expect(currentAction.textContent?.match(/VOICEVOX\/sample-editor#103/gu)).toHaveLength(1);

    const disclosures = [...details.querySelectorAll<HTMLDetailsElement>(".detail-disclosure")];
    expect(disclosures).toHaveLength(5);
    expect(disclosures.every((disclosure) => !disclosure.open)).toBe(true);
    expect(details.querySelectorAll(".timestamp-grid time")).toHaveLength(8);
    expect(requiredElement<HTMLDetailsElement>(".timestamp-details").open).toBe(false);
    expect(requiredElement<HTMLDetailsElement>(".decision-details").open).toBe(false);
    expect(requiredElement<HTMLDetailsElement>(".evidence-details").open).toBe(false);
    expect(requiredElement<HTMLDetailsElement>(".context-details").open).toBe(false);
    expect(requiredElement<HTMLDetailsElement>(".history-details").open).toBe(false);
    expect(details.textContent).toContain("複数blockerから影響度が最も高い項目を選びました");
    expect(details.textContent).toContain("VOICEVOX/sample-editor#103");
    expect(details.textContent).toContain("example/sample-distribution#42");
    expect(details.textContent).toContain("判定根拠");
    expect(details.textContent).toContain("GitHub上の根拠を開く");
    expect(details.textContent).toContain("confidence 100%");
    expect(details.textContent).toContain("前回との差分");
    expect(details.textContent).toContain("通常");
    expect(details.textContent).toContain("要確認");
    expect(details.querySelector<HTMLAnchorElement>(".evidence-list a")?.rel).toBe(
      "noopener noreferrer",
    );
    expect(document.activeElement?.textContent).toBe("サンプル配布処理を実装する");
  });

  it("リポジトリ、番号、タイトル、アクター、team、ラベルを公開DTO内で検索する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items");
    renderApp(sampleSummary);
    const cases = [
      {
        query: "sample-core",
        nodeIds: ["sample-item-core-305"],
      },
      {
        query: "#202",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "方針を決める",
        nodeIds: ["sample-item-editor-103"],
      },
      {
        query: "hiho",
        nodeIds: ["sample-item-editor-103"],
      },
      {
        query: "sample-dictionary-author",
        nodeIds: ["sample-item-editor-101"],
      },
      {
        query: "sample-review-actor",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "sample-reviewers",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "blocked",
        nodeIds: ["sample-item-engine-204"],
      },
    ] satisfies readonly Readonly<{
      query: string;
      nodeIds: readonly string[];
    }>[];

    for (const searchCase of cases) {
      await enterSearch(searchCase.query);
      expect(itemRowNodeIds()).toEqual(searchCase.nodeIds);
      expect(new URL(window.location.href).searchParams.get("q")).toBe(searchCase.query);
    }
  });

  it("検索、表filter、並び順を項目一覧のdeep linkから再現する", async () => {
    const deepLink =
      "/voicevox_task_tracker/items?q=blocked&repo=sample-engine&status=%E3%83%96%E3%83%AD%E3%83%83%E3%82%AF&sort=stall&direction=descending";
    window.history.replaceState({}, "", deepLink);
    renderApp(sampleSummary);
    await flushUi();

    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("blocked");
    expect(
      requiredElement<HTMLInputElement>('input[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("sample-engine");
    expect(requiredElement<HTMLInputElement>('input[aria-label="statusで絞り込み"]').value).toBe(
      "ブロック",
    );
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("stall");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);

    act(() => {
      render(null, currentContainer());
    });
    renderApp(sampleSummary);
    await flushUi();

    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("blocked");
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);
  });

  it("repository clusterの選択をdeep linkから再現する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/graph");
    renderApp(sampleSummary);
    const repositoryMode = requiredElement<HTMLInputElement>(
      'input[name="graph-cluster-kind"][value="repository"]',
    );
    act(() => {
      repositoryMode.click();
    });
    const repositoryButton = requiredElement<HTMLButtonElement>(
      '.component-browser [data-repository-id="sample-repository-editor"]',
    );
    act(() => {
      repositoryButton.click();
    });
    expect(window.location.pathname).toBe(
      "/voicevox_task_tracker/graph/repository/sample-repository-editor",
    );
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    expect(window.location.pathname).toBe(
      "/voicevox_task_tracker/graph/repository/sample-repository-editor",
    );
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");

    act(() => {
      render(null, currentContainer());
    });
    renderApp(sampleSummary);
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    expect(
      requiredElement<HTMLInputElement>('input[name="graph-cluster-kind"][value="repository"]')
        .checked,
    ).toBe(true);
    expect(
      requiredElement<HTMLButtonElement>(
        '.component-browser [data-repository-id="sample-repository-editor"]',
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      [...currentContainer().querySelectorAll<SVGGElement>(".graph-node")].map(
        (node) => node.dataset["nodeId"],
      ),
    ).toEqual(["sample-item-editor-101", "sample-item-editor-103"]);
  });

  it("不正なURL状態を個別に無視して安全な既定状態へ戻す", async () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/items/missing/999?q=first&q=second&repo=%00&sort=invalid&direction=sideways&item=missing&unexpected=value#item-details",
    );
    renderApp(sampleSummary);
    await flushUi();

    expect(currentContainer().textContent).toContain("URLに含まれる不正または未対応");
    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("");
    expect(
      requiredElement<HTMLInputElement>('input[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("");
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("repository");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "昇順",
    );
    expect(requiredElement<HTMLTableCellElement>('th[aria-sort="ascending"]').textContent).toBe(
      "項目",
    );
    expect(currentContainer().querySelector(".item-details-card")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/items");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#item-details");
  });

  it("存在しないcluster pathを未選択の依存グラフへ戻す", () => {
    const loadDetails = vi.fn(() => Promise.resolve(sampleDetails));
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/graph/component/missing?graph=component&cluster=missing",
    );

    renderAppWithLoader(sampleSummary, loadDetails);

    expect(currentContainer().textContent).toContain("URLに含まれる不正または未対応");
    expect(currentContainer().textContent).toContain("一覧から1件選ぶと依存グラフを開きます");
    expect(window.location.pathname).toBe("/voicevox_task_tracker/graph");
    expect(window.location.search).toBe("");
    expect(loadDetails).not.toHaveBeenCalled();
  });

  it("低confidenceの状態、waitingOn、次の行動を候補として表示する", async () => {
    const lowConfidenceSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item) =>
        item.nodeId === "sample-item-editor-103"
          ? {
              ...item,
              confidence: 0.5,
              waitingOn: item.waitingOn.map((waitingOn) => ({
                ...waitingOn,
                confidence: 0.5,
              })),
            }
          : item,
      ),
    });
    const lowConfidenceItem = lowConfidenceSummary.items.find(
      (item) => item.nodeId === "sample-item-editor-103",
    );
    assertNonNullable(lowConfidenceItem, "低confidenceのsummary項目がありません");
    const lowConfidenceDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === lowConfidenceItem.nodeId
          ? {
              ...details,
              summary: lowConfidenceItem,
              uncertainties: ["判断者を確定できる根拠が不足しています"],
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103");
    renderAppWithDetails(lowConfidenceSummary, lowConfidenceDetails);
    await flushUi();

    const details = requiredElement<HTMLElement>(".item-details-card");
    expect(details.querySelector(".confidence-uncertain")).not.toBeNull();
    expect(details.textContent).toContain("判定: 未確定");
    expect(details.textContent).toContain("status候補");
    expect(details.textContent).toContain("waitingOn候補");
    expect(details.textContent).toContain("次の行動候補");
    expect(details.textContent).toContain("判断者を確定できる根拠が不足");
  });

  it("公開DTOのconfidence閾値を表示区分へ反映する", async () => {
    const targetNodeId = "sample-item-editor-103";
    const configuredSummary = createPublicSummaryDto({
      ...sampleSummary,
      confidenceThresholds: {
        high: 0.9,
        medium: 0.7,
      },
      items: sampleSummary.items.map((item) =>
        item.nodeId === targetNodeId
          ? {
              ...item,
              confidence: 0.8,
              waitingOn: item.waitingOn.map((waitingOn) => ({
                ...waitingOn,
                confidence: 0.8,
              })),
            }
          : item,
      ),
    });
    const configuredItem = configuredSummary.items.find((item) => item.nodeId === targetNodeId);
    assertNonNullable(configuredItem, "閾値確認用のsummary項目がありません");
    const configuredDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === targetNodeId
          ? {
              ...details,
              summary: configuredItem,
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103");

    renderAppWithDetails(configuredSummary, configuredDetails);
    await flushUi();

    const details = requiredElement<HTMLElement>(".item-details-card");
    expect(details.querySelector(".confidence-estimate")).not.toBeNull();
    expect(details.querySelector(".confidence-high_estimate")).toBeNull();
    expect(details.textContent).toContain("判定: 推定");
  });

  it("keyboard focusとlink activationだけで検索結果から詳細を開いて閉じる", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items");
    renderApp(sampleSummary);
    const search = requiredElement<HTMLInputElement>("#item-search-input");
    search.focus();
    expect(document.activeElement).toBe(search);
    await enterSearch("blocked");

    const detailsLink = requiredElement<HTMLAnchorElement>(
      '.items-table tr[data-node-id="sample-item-engine-204"] a[href="/voicevox_task_tracker/items/sample-engine/204"]',
    );
    detailsLink.focus();
    expect(document.activeElement).toBe(detailsLink);
    await act(async () => {
      detailsLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    await flushUi();

    expect(window.location.pathname).toBe("/voicevox_task_tracker/items/sample-engine/204");
    expect(document.activeElement?.textContent).toBe("サンプル配布処理を実装する");
    const closeLink = requiredElement<HTMLAnchorElement>(
      '.item-details-actions a[href="/voicevox_task_tracker/items"]',
    );
    closeLink.focus();
    expect(document.activeElement).toBe(closeLink);
    await act(async () => {
      closeLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(currentContainer().querySelector(".item-details-card")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/items");
  });

  it("詳細内のGitHub由来文字列をHTMLとして実行しない", async () => {
    const xssText = '<img src="x" onerror="globalThis.__detailXss = true">';
    const xssSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item) =>
        item.nodeId === "sample-item-editor-101"
          ? {
              ...item,
              title: xssText,
            }
          : item,
      ),
    });
    const xssItem = xssSummary.items.find((item) => item.nodeId === "sample-item-editor-101");
    assertNonNullable(xssItem, "XSSテストのsummary項目がありません");
    const xssDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === xssItem.nodeId
          ? {
              ...details,
              summary: xssItem,
              labels: [xssText],
              evidence: details.evidence.map((evidence) => ({
                ...evidence,
                summary: xssText,
              })),
              uncertainties: [xssText],
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/101");
    renderAppWithDetails(xssSummary, xssDetails);
    await flushUi();

    expect(currentContainer().querySelector("img")).toBeNull();
    expect(currentContainer().querySelector("script")).toBeNull();
    expect(currentContainer().textContent).toContain(xssText);
  });

  it("CSPを維持し、危険なinline実行を許可しない", () => {
    expect(indexHtml).toContain("default-src 'self'");
    expect(indexHtml).toContain("base-uri 'none'");
    expect(indexHtml).toContain("form-action 'none'");
    expect(indexHtml).toContain("object-src 'none'");
    expect(indexHtml).toContain('<link rel="stylesheet" href="/src/styles.css" />');
    expect(indexHtml).not.toContain("'unsafe-inline'");
    expect(indexHtml).not.toContain("'unsafe-eval'");
  });

  it("主要な文字色と背景色がWCAG AAのコントラスト比を満たす", () => {
    const colorPairs = [
      ["18213b", "f4f7fb"],
      ["175bc1", "ffffff"],
      ["4b5f86", "ffffff"],
      ["52617b", "ffffff"],
      ["596985", "ffffff"],
      ["ffffff", "a62332"],
      ["552800", "ffc46b"],
      ["173f72", "d6e9ff"],
      ["435169", "edf0f5"],
      ["174f39", "ddf4e9"],
      ["643000", "ffebc9"],
      ["173f72", "e8f3ff"],
      ["5a3500", "fff5dc"],
      ["6b2430", "fff0f2"],
    ] satisfies readonly Readonly<[string, string]>[];

    for (const [foreground, background] of colorPairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("WCAG 2.2 AA対象の重大な自動a11y違反がない", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderApp(sampleSummary);
    await flushUi();

    const results = await axe.run(document.body, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      rules: {
        "color-contrast": {
          enabled: false,
        },
      },
    });
    const seriousViolations = results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(
      seriousViolations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target),
      })),
    ).toEqual([]);
  });
});

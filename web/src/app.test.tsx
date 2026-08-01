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
  act(() => {
    render(
      <App
        loadDetails={() => Promise.resolve(details)}
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
  it("公開DTOの集計値、観測時刻、AI unavailableを概要へ表示する", () => {
    renderApp(sampleSummary);

    expect(definitionValue("リポジトリ")).toBe("3");
    expect(definitionValue("項目")).toBe("5");
    expect(definitionValue("unknown")).toBe("0");
    expect(definitionValue("staleリポジトリ")).toBe("1");
    expect(definitionValue("stale項目")).toBe("1");
    expect(definitionValue("マージ可能")).toBe("1");
    expect(definitionValue("レビュー待ち")).toBe("1");
    expect(currentContainer().textContent).toContain("AIを利用できなかったため");
    expect(currentContainer().textContent).toContain("JST");
    expect(currentContainer().textContent).toContain("1 日前");
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

  it("keyboard操作可能な入力とbuttonで一覧を絞り込み並び替える", () => {
    renderApp(sampleSummary);
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
    const stallSortButton = [
      ...currentContainer().querySelectorAll<HTMLButtonElement>(".sort-button"),
    ].find((button) => button.textContent?.includes("停滞時間") === true);
    assertNonNullable(stallSortButton, "停滞時間のsort buttonがありません");

    act(() => {
      stallSortButton.click();
    });
    expect(itemRowNodeIds()[0]).toBe("sample-item-engine-204");

    act(() => {
      stallSortButton.click();
    });
    expect(itemRowNodeIds()[0]).toBe("sample-item-editor-101");
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

  it("staleなリポジトリと項目を古い観測値として区別する", () => {
    renderApp(sampleSummary);

    const staleRepository = requiredElement<HTMLTableRowElement>(
      'tr[data-repository-id="sample-repository-core"]',
    );
    const staleItem = requiredElement<HTMLTableRowElement>(
      '.items-table tr[data-node-id="sample-item-core-305"]',
    );
    const freshRepository = requiredElement<HTMLTableRowElement>(
      'tr[data-repository-id="sample-repository-editor"]',
    );

    expect(staleRepository.dataset["freshness"]).toBe("stale");
    expect(staleRepository.textContent).toContain("古い観測値");
    expect(staleItem.dataset["freshness"]).toBe("stale");
    expect(staleItem.textContent).toContain("古い観測値");
    expect(freshRepository.dataset["freshness"]).toBe("fresh");
    expect(freshRepository.textContent).toContain("最新観測");
    const freshnessScrollRegion = requiredElement<HTMLElement>(
      '[role="region"][aria-label="リポジトリ鮮度表の横スクロール領域"]',
    );
    expect(freshnessScrollRegion.tabIndex).toBe(0);
  });

  it("選択項目の必須欄、GitHub上の根拠、前回との差分を表示する", async () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/?item=sample-item-engine-204#item-details",
    );
    renderApp(sampleSummary);
    await flushUi();

    const details = requiredElement<HTMLElement>(
      '.item-details-card[data-node-id="sample-item-engine-204"]',
    );
    expect(details.textContent).toContain("GitHubで項目を開く");
    expect(details.textContent).toContain("status");
    expect(details.textContent).toContain("ブロック中");
    expect(details.textContent).toContain("waitingOn");
    expect(details.textContent).toContain("sample-item-editor-103");
    expect(details.textContent).toContain("次の行動");
    expect(details.textContent).toContain("各種時刻");
    expect(details.querySelectorAll(".timestamp-grid time")).toHaveLength(8);
    expect(details.textContent).toContain("blocker一覧");
    expect(details.textContent).toContain("primary blocker");
    expect(details.textContent).toContain("全blocker");
    expect(details.textContent).toContain(
      "選定理由: 複数blockerから影響度が最も高い項目を選びました",
    );
    expect(details.textContent).toContain("VOICEVOX/sample-editor#103");
    expect(details.textContent).toContain("example/sample-distribution#42");
    expect(details.querySelectorAll(".blocker-list > li")).toHaveLength(2);
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

  it("検索、表filter、並び順、選択項目をdeep linkから再現する", async () => {
    const deepLink =
      "/voicevox_task_tracker/?q=blocked&repo=sample-engine&status=%E3%83%96%E3%83%AD%E3%83%83%E3%82%AF&sort=stall&direction=descending&item=sample-item-engine-204#item-details";
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
    expect(
      requiredElement<HTMLTableCellElement>('th[aria-sort="descending"] .sort-button').textContent,
    ).toContain("停滞時間");
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);
    expect(requiredElement<HTMLElement>(".item-details-card").dataset["nodeId"]).toBe(
      "sample-item-engine-204",
    );

    act(() => {
      render(null, currentContainer());
    });
    renderApp(sampleSummary);
    await flushUi();

    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("blocked");
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);
    expect(requiredElement<HTMLElement>(".item-details-card").dataset["nodeId"]).toBe(
      "sample-item-engine-204",
    );
  });

  it("repository clusterの選択をdeep linkから再現する", async () => {
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
    expect(new URL(window.location.href).searchParams.get("graph")).toBe("repository");
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    expect(new URL(window.location.href).searchParams.get("graph")).toBe("repository");
    expect(new URL(window.location.href).searchParams.get("cluster")).toBe(
      "sample-repository-editor",
    );
    expect(window.location.hash).toBe("#dependency-heading");

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
      "/voicevox_task_tracker/?q=first&q=second&repo=%00&sort=invalid&direction=sideways&item=missing&unexpected=value#item-details",
    );
    renderApp(sampleSummary);
    await flushUi();

    expect(currentContainer().textContent).toContain("URLに含まれる不正または未対応");
    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("");
    expect(
      requiredElement<HTMLInputElement>('input[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("");
    expect(
      requiredElement<HTMLTableCellElement>('th[aria-sort="ascending"]').textContent,
    ).toContain("リポジトリ");
    expect(currentContainer().querySelector(".item-details-card")).toBeNull();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
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
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/?item=sample-item-editor-103#item-details",
    );
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
    window.history.replaceState({}, "", `/?item=${targetNodeId}#item-details`);

    renderAppWithDetails(configuredSummary, configuredDetails);
    await flushUi();

    const details = requiredElement<HTMLElement>(".item-details-card");
    expect(details.querySelector(".confidence-estimate")).not.toBeNull();
    expect(details.querySelector(".confidence-high_estimate")).toBeNull();
    expect(details.textContent).toContain("判定: 推定");
  });

  it("keyboard focusとlink activationだけで検索結果から詳細を開いて閉じる", async () => {
    renderApp(sampleSummary);
    const search = requiredElement<HTMLInputElement>("#item-search-input");
    search.focus();
    expect(document.activeElement).toBe(search);
    await enterSearch("blocked");

    const detailsLink = requiredElement<HTMLAnchorElement>(
      '.items-table tr[data-node-id="sample-item-engine-204"] a[aria-controls="item-details"]',
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

    expect(new URL(window.location.href).searchParams.get("item")).toBe("sample-item-engine-204");
    expect(document.activeElement?.textContent).toBe("サンプル配布処理を実装する");
    const closeLink = requiredElement<HTMLAnchorElement>(".item-details-heading > a");
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
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/?item=sample-item-editor-101#item-details",
    );
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
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/?item=sample-item-engine-204#item-details",
    );
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

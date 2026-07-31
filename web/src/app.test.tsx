import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import sampleDetailsSource from "../public/data/details.json";
import sampleSummarySource from "../public/data/summary.json";
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { App, SafeGitHubLink } from "./app.js";
import {
  compareAttentionItems,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  selectAttentionItems,
  type TableColumnKey,
  type TableFilters,
} from "./model.js";

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
  render(
    <App
      loadDetails={loadSampleDetails}
      locale={LOCALE}
      now={NOW}
      summary={summary}
      title={TITLE}
    />,
    currentContainer(),
  );
}

function loadSampleDetails(): Promise<typeof sampleDetails> {
  return Promise.resolve(sampleDetails);
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

beforeEach(() => {
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
    expect(requiredElement<HTMLAnchorElement>(".items-table tbody a").rel).toBe(
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
  });
});

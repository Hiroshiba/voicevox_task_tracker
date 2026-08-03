import { describe, expect, it } from "vitest";

import sampleSummarySource from "../public/data/summary.json";
import {
  createPublicSummaryDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { waitingOnHistoryLabel, waitingOnLabel } from "./model.js";

type WaitingOnCandidate = PublicItemSummaryDto["waitingOn"][number];

const sampleSummary = createPublicSummaryDto(sampleSummarySource);

function createWaitingOnCandidate(
  kind: WaitingOnCandidate["kind"],
  role: WaitingOnCandidate["role"],
  candidateId: string,
): WaitingOnCandidate {
  return {
    kind,
    role,
    candidateId,
    reasonSummary: "表示テスト",
    sourceIds: ["source:waiting-on-label"],
    confidence: 1,
  };
}

function readSampleItem(nodeId: string): PublicItemSummaryDto {
  const item = sampleSummary.items.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(item, `sample項目 ${nodeId} がありません`);
  return item;
}

describe("waitingOn表示", () => {
  const identifiedItem: PublicItemSummaryDto = {
    ...readSampleItem("sample-item-editor-101"),
    author: {
      status: "identified",
      actor: {
        type: "human",
        nodeId: "actor:hiho",
        login: "hiho",
      },
    },
    assignees: [
      {
        type: "human",
        nodeId: "actor:hiho",
        login: "hiho",
      },
      {
        type: "human",
        nodeId: "actor:aoirint",
        login: "aoirint",
      },
    ],
  };
  const unavailableAuthorItem: PublicItemSummaryDto = {
    ...identifiedItem,
    author: {
      status: "unavailable",
      reason: "deleted_account",
    },
  };
  const unassignedItem: PublicItemSummaryDto = {
    ...identifiedItem,
    assignees: [],
  };

  it("現在値の役割と対象を一つのラベルへ統一する", () => {
    const cases: readonly Readonly<{
      candidate: WaitingOnCandidate;
      item: PublicItemSummaryDto;
      expected: string;
    }>[] = [
      {
        candidate: createWaitingOnCandidate("user", "reviewer", "hiho"),
        item: identifiedItem,
        expected: "レビュワー @hiho",
      },
      {
        candidate: createWaitingOnCandidate("team", "reviewer", "VOICEVOX/maintainers"),
        item: identifiedItem,
        expected: "レビュワー チーム VOICEVOX/maintainers",
      },
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: identifiedItem,
        expected: "作成者 @hiho",
      },
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: unavailableAuthorItem,
        expected: "作成者 アカウント削除済み",
      },
      {
        candidate: createWaitingOnCandidate("role", "assignee", "assignee"),
        item: identifiedItem,
        expected: "担当者 @hiho、@aoirint",
      },
      {
        candidate: createWaitingOnCandidate("role", "assignee", "assignee"),
        item: unassignedItem,
        expected: "担当者 未割り当て",
      },
      {
        candidate: createWaitingOnCandidate("role", "maintainer", "maintainer"),
        item: identifiedItem,
        expected: "メンテナーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "reviewer", "reviewer"),
        item: identifiedItem,
        expected: "レビュワーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "merge_decider", "merge_decider"),
        item: identifiedItem,
        expected: "マージ判断者の誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "ci", "ci"),
        item: identifiedItem,
        expected: "CI",
      },
      {
        candidate: createWaitingOnCandidate("role", "dependency", "dependency"),
        item: identifiedItem,
        expected: "依存項目",
      },
      {
        candidate: createWaitingOnCandidate("role", "unknown", "unknown"),
        item: identifiedItem,
        expected: "不明",
      },
      {
        candidate: createWaitingOnCandidate("item", "dependency", "sample-item-editor-103"),
        item: identifiedItem,
        expected: "VOICEVOX/sample-editor#103",
      },
      {
        candidate: createWaitingOnCandidate(
          "item",
          "dependency",
          "external:github:sample-distribution-42",
        ),
        item: identifiedItem,
        expected: "example/sample-distribution#42",
      },
      {
        candidate: createWaitingOnCandidate("automation", "ci", "required_checks"),
        item: identifiedItem,
        expected: "自動処理 required_checks",
      },
      {
        candidate: createWaitingOnCandidate("unknown", "unknown", "unknown"),
        item: identifiedItem,
        expected: "不明",
      },
    ];

    for (const testCase of cases) {
      expect(waitingOnLabel(testCase.candidate, testCase.item, sampleSummary)).toBe(
        testCase.expected,
      );
    }
  });

  it("履歴の役割と対象を過去時点に適したラベルへ統一する", () => {
    const cases: readonly Readonly<{
      candidate: WaitingOnCandidate;
      item: PublicItemSummaryDto;
      expected: string;
    }>[] = [
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: identifiedItem,
        expected: "作成者 @hiho",
      },
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: unavailableAuthorItem,
        expected: "作成者 アカウント削除済み",
      },
      {
        candidate: createWaitingOnCandidate("role", "assignee", "assignee"),
        item: identifiedItem,
        expected: "当時の担当者",
      },
      {
        candidate: createWaitingOnCandidate("role", "maintainer", "maintainer"),
        item: identifiedItem,
        expected: "メンテナーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "reviewer", "reviewer"),
        item: identifiedItem,
        expected: "レビュワーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "merge_decider", "maintainer"),
        item: identifiedItem,
        expected: "マージ判断者の誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "ci", "ci"),
        item: identifiedItem,
        expected: "CI",
      },
      {
        candidate: createWaitingOnCandidate("role", "dependency", "dependency"),
        item: identifiedItem,
        expected: "依存項目",
      },
      {
        candidate: createWaitingOnCandidate("role", "unknown", "unknown"),
        item: identifiedItem,
        expected: "不明",
      },
      {
        candidate: createWaitingOnCandidate("item", "dependency", "sample-item-editor-103"),
        item: identifiedItem,
        expected: "VOICEVOX/sample-editor#103",
      },
    ];

    for (const testCase of cases) {
      expect(waitingOnHistoryLabel(testCase.candidate, testCase.item, sampleSummary)).toBe(
        testCase.expected,
      );
    }
  });

  it("項目参照を解決できない場合は例外を投げる", () => {
    expect(() =>
      waitingOnLabel(
        createWaitingOnCandidate("item", "dependency", "missing-item"),
        identifiedItem,
        sampleSummary,
      ),
    ).toThrowError("waitingOn項目 missing-item がありません");

    const summaryWithoutTarget: PublicSummaryDto = {
      ...sampleSummary,
      items: sampleSummary.items.filter((item) => item.nodeId !== "sample-item-editor-103"),
    };
    expect(() =>
      waitingOnLabel(
        createWaitingOnCandidate("item", "dependency", "sample-item-editor-103"),
        identifiedItem,
        summaryWithoutTarget,
      ),
    ).toThrowError("waitingOn項目 sample-item-editor-103 の表示名がありません");
  });
});

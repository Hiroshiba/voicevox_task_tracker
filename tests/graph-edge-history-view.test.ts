import { describe, expect, it } from "vitest";

import sampleDetailsSource from "../web/public/data/details.json" with { type: "json" };
import sampleSummarySource from "../web/public/data/summary.json" with { type: "json" };
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicGraphHistoryEventDto,
} from "../src/pages/public-dto.js";
import { createComponentGraphView } from "../web/src/graph-model.js";

type EdgeHistoryValue = Extract<
  PublicGraphHistoryEventDto["after"],
  Readonly<{ state: "present" }>
>["value"];

describe("graph画面のedge履歴モデル", () => {
  it("削除済みedgeの追加、変更、削除を3 eventとして保持する", () => {
    const relationId = "sample-relation-history-removed";
    const added = {
      fromNodeId: "sample-item-editor-103",
      toNodeId: "sample-item-engine-204",
      type: "related_to",
      provenance: "ai_inference",
      confidence: 0.8,
      evidence: [],
      contradictions: [],
      firstSeenAt: "2026-07-29T00:00:00.000Z",
      lastConfirmedAt: "2026-07-29T00:00:00.000Z",
      active: true,
    } satisfies EdgeHistoryValue;
    const changed = {
      ...added,
      type: "implements",
      confidence: 0.9,
      lastConfirmedAt: "2026-07-30T00:00:00.000Z",
    } satisfies EdgeHistoryValue;
    const removed = {
      ...changed,
      active: false,
      removedAt: "2026-07-31T00:00:00.000Z",
    } satisfies EdgeHistoryValue;
    const history = [
      {
        kind: "edge_changed",
        runId: "run-edge-added",
        recordedAt: "2026-07-29T00:00:00.000Z",
        relationId,
        before: {
          state: "absent",
        },
        after: {
          state: "present",
          value: added,
        },
      },
      {
        kind: "edge_changed",
        runId: "run-edge-changed",
        recordedAt: "2026-07-30T00:00:00.000Z",
        relationId,
        before: {
          state: "present",
          value: added,
        },
        after: {
          state: "present",
          value: changed,
        },
      },
      {
        kind: "edge_changed",
        runId: "run-edge-removed",
        recordedAt: "2026-07-31T00:00:00.000Z",
        relationId,
        before: {
          state: "present",
          value: changed,
        },
        after: {
          state: "present",
          value: removed,
        },
      },
    ] satisfies readonly PublicGraphHistoryEventDto[];
    const summary = createPublicSummaryDto(sampleSummarySource);
    const details = createPublicDetailsDto({
      ...sampleDetailsSource,
      graph: {
        ...sampleDetailsSource.graph,
        history,
      },
    });

    const view = createComponentGraphView(
      summary,
      details,
      "sample-component-release",
      new Set(),
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(view.sourceEdges.map((edge) => edge.id)).not.toContain(relationId);
    expect(view.edgeHistories).toHaveLength(1);
    expect(view.edgeHistories[0]).toMatchObject({
      relationId,
      events: [
        {
          before: {
            state: "absent",
          },
          after: {
            state: "present",
            value: {
              type: "related_to",
              confidence: 0.8,
              active: true,
            },
          },
        },
        {
          after: {
            state: "present",
            value: {
              type: "implements",
              confidence: 0.9,
              active: true,
            },
          },
        },
        {
          after: {
            state: "present",
            value: {
              active: false,
            },
          },
        },
      ],
    });
  });
});

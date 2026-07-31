import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type Repository,
  type Severity,
  type Status,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  createStateHistoryRecord,
  createStateSnapshot,
  type StateHistoryRecord,
  type StateSnapshot,
} from "../src/persistence/index.js";
import {
  DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
  PUBLIC_DETAILS_FILE_NAME,
  PUBLIC_SUMMARY_FILE_NAME,
  PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  PagesPublicSafetyError,
  PublicSummarySizeError,
  generatePublicData,
  writePublicDataFiles,
  type GeneratedPublicData,
  type PublicDtoGenerationOptions,
} from "../src/pages/index.js";

const TRACKING_START_AT = "2026-07-01T00:00:00.000Z";
const CREATED_AT = "2026-07-02T00:00:00.000Z";
const FRESH_OBSERVED_AT = "2026-07-31T23:55:00.000Z";
const GENERATED_AT = "2026-08-01T00:00:00.000Z";
const STALE_OBSERVED_AT = "2026-07-30T23:55:00.000Z";
const PUBLIC_REPOSITORY_ID = "R_PUBLIC";
const STALE_REPOSITORY_ID = "R_STALE";
const PRIVATE_REPOSITORY_ID = "R_PRIVATE_SENTINEL";
const defaultGenerationOptions = Object.freeze({
  labelRules: [
    {
      repository: "VOICEVOX/*",
      namePattern: "^優先度[：:]高$",
      effects: {
        priorityWeight: 25,
      },
    },
  ],
  maxInitialGraphNodes: DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
  maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
}) satisfies PublicDtoGenerationOptions;

type RepositoryFixture =
  | Readonly<{
      id: string;
      name: string;
      observedAt: string;
      freshness: "fresh";
    }>
  | Readonly<{
      id: string;
      name: string;
      observedAt: string;
      freshness: "stale";
      failedAt: string;
    }>;

type InventoryRepositoryFixture = Readonly<{
  id: string;
  name: string;
  visibility: "public" | "private" | "internal";
}>;

type ItemFixtureOptions = Readonly<{
  nodeId: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
  status: Status;
  severity: Severity;
  waitingOnKind: WaitingOnKind;
  waitingOnRole: WaitingOnRole;
  observedAt: string;
  title: string;
}>;

type SnapshotFixtureOptions = Readonly<{
  runId: string;
  runStatus: "success" | "fallback";
  generatedAt: string;
  repositories: readonly RepositoryFixture[];
  items: readonly unknown[];
  relations: readonly unknown[];
}>;

function createInventory(
  repositories: readonly InventoryRepositoryFixture[],
): readonly Repository[] {
  return Object.freeze(
    repositories.map((repository) => ({
      id: createGitHubRepositoryId(repository.id),
      owner: "VOICEVOX",
      name: repository.name,
      visibility: repository.visibility,
      archived: false,
      disabled: false,
      observedAt: createUtcIsoDateTime(FRESH_OBSERVED_AT),
    })),
  );
}

function createItem(options: ItemFixtureOptions): unknown {
  const terminal =
    options.status === "terminal_merged" ||
    options.status === "terminal_completed" ||
    options.status === "terminal_not_planned";
  return {
    nodeId: options.nodeId,
    type: options.number % 2 === 0 ? "pull_request" : "issue",
    repositoryId: options.repositoryId,
    displayReference: `VOICEVOX/${options.repositoryName}#${options.number.toString()}`,
    number: options.number,
    url: `https://github.com/VOICEVOX/${options.repositoryName}/issues/${options.number.toString()}`,
    title: options.title,
    state: terminal ? "closed" : "open",
    status: options.status,
    waitingOn: terminal
      ? []
      : [
          {
            kind: options.waitingOnKind,
            candidateId: `candidate:${options.nodeId}`,
            role: options.waitingOnRole,
            reasonSummary: "次の担当による対応待ちです",
            sourceIds: [`fixture:${options.nodeId}`],
            confidence: 0.9,
          },
        ],
    nextAction: terminal ? "対応は完了しています" : "次の担当が確認する",
    createdAt: CREATED_AT,
    githubUpdatedAt: options.observedAt,
    lastHumanActivityAt: options.observedAt,
    lastProgressAt: options.observedAt,
    statusSince: options.observedAt,
    ownerSince: options.observedAt,
    stallSince: options.observedAt,
    observedAt: options.observedAt,
    labels: ["優先度：高"],
    assignees: [],
    reviewState: options.number % 2 === 0 ? "requested" : "not_applicable",
    checkState: options.number % 2 === 0 ? "pending" : "not_applicable",
    confidence: 0.9,
    evidence: [
      {
        sourceId: `fixture:${options.nodeId}`,
        supports: "status",
        summary: "公開用の短い判定根拠です",
      },
    ],
    uncertainties: [],
    severity: options.severity,
  };
}

function createRelation(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  type: "blocks" | "related_to",
): unknown {
  return {
    id,
    fromNodeId,
    toNodeId,
    type,
    provenance: "native",
    confidence: 1,
    evidence: [
      {
        sourceId: `fixture:${id}`,
        supports: "relation",
        summary: "公開用の短い関係根拠です",
      },
    ],
    active: true,
    firstSeenAt: FRESH_OBSERVED_AT,
    lastConfirmedAt: FRESH_OBSERVED_AT,
  };
}

function createSnapshot(options: SnapshotFixtureOptions): StateSnapshot {
  return createStateSnapshot({
    schemaVersion: "1",
    generatedAt: options.generatedAt,
    trackingStartAt: TRACKING_START_AT,
    repositories: options.repositories.map((repository) => ({
      id: repository.id,
      owner: "VOICEVOX",
      name: repository.name,
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: repository.observedAt,
      freshness: repository.freshness,
      ...(repository.freshness === "stale"
        ? {
            failedAt: repository.failedAt,
          }
        : {}),
    })),
    items: options.items,
    relations: options.relations,
    run: {
      id: options.runId,
      status: options.runStatus,
      complete: true,
    },
  });
}

function createSingleItemSnapshot(title: string): StateSnapshot {
  return createSnapshot({
    runId: "run-single",
    runStatus: "success",
    generatedAt: GENERATED_AT,
    repositories: [
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        observedAt: FRESH_OBSERVED_AT,
        freshness: "fresh",
      },
    ],
    items: [
      createItem({
        nodeId: "I_SINGLE",
        repositoryId: PUBLIC_REPOSITORY_ID,
        repositoryName: "public",
        number: 1,
        status: "new_untriaged",
        severity: "watch",
        waitingOnKind: "role",
        waitingOnRole: "maintainer",
        observedAt: FRESH_OBSERVED_AT,
        title,
      }),
    ],
    relations: [],
  });
}

function generateFixture(
  snapshot: StateSnapshot,
  historyRecords: readonly StateHistoryRecord[],
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
  options: PublicDtoGenerationOptions,
): GeneratedPublicData {
  return generatePublicData({
    snapshot,
    historyRecords,
    repositoryInventory,
    knownSecrets,
    options,
  });
}

function publicInventory(): readonly Repository[] {
  return createInventory([
    {
      id: PUBLIC_REPOSITORY_ID,
      name: "public",
      visibility: "public",
    },
  ]);
}

describe("Pages公開安全性", () => {
  it("private sentinelを含むsnapshotではDTO生成を中止する", () => {
    const snapshot = createSnapshot({
      runId: "run-private",
      runStatus: "success",
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
        {
          id: PRIVATE_REPOSITORY_ID,
          name: "private-sentinel",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: [
        createItem({
          nodeId: "I_PUBLIC",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "new_untriaged",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "公開項目",
        }),
      ],
      relations: [],
    });
    const inventory = createInventory([
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        visibility: "public",
      },
      {
        id: PRIVATE_REPOSITORY_ID,
        name: "private-sentinel",
        visibility: "private",
      },
    ]);

    expect(() => generateFixture(snapshot, [], inventory, [], defaultGenerationOptions)).toThrow(
      PagesPublicSafetyError,
    );
  });

  it("本文全文フィールドを拒否し、有効なDTOへ本文フィールドを作らない", () => {
    const fullBody = "転載してはいけないIssue本文全文";
    const snapshot = createSingleItemSnapshot("短い公開タイトル");
    const snapshotWithBody = {
      ...snapshot,
      body: fullBody,
    };

    expect(() =>
      generateFixture(snapshotWithBody, [], publicInventory(), [], defaultGenerationOptions),
    ).toThrow(PagesPublicSafetyError);

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );
    const serialized = JSON.stringify(generated);
    expect(serialized).not.toContain(fullBody);
    expect(serialized).not.toContain('"body"');
    expect(generated.details.items[0]?.evidence[0]).toMatchObject({
      sourceId: "fixture:I_SINGLE",
      sourceUrl: "https://github.com/VOICEVOX/public/issues/1",
      summary: "公開用の短い判定根拠です",
    });
  });

  it("secret patternを含む公開候補を値を露出せず拒否する", () => {
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
    const snapshot = createSingleItemSnapshot(`漏えい候補 ${secret}`);

    let caught: unknown;
    try {
      generateFixture(snapshot, [], publicInventory(), [secret], defaultGenerationOptions);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PagesPublicSafetyError);
    if (!(caught instanceof Error)) {
      throw new Error("公開安全性エラーを取得できません");
    }
    expect(caught.message).not.toContain(secret);
  });
});

describe("公開DTO生成", () => {
  it("fixtureの集計、graph、根拠、前回差分を公開DTOへ反映する", () => {
    const repository = {
      id: PUBLIC_REPOSITORY_ID,
      name: "public",
      observedAt: FRESH_OBSERVED_AT,
      freshness: "fresh",
    } satisfies RepositoryFixture;
    const previous = createSnapshot({
      runId: "run-previous",
      runStatus: "success",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositories: [
        {
          ...repository,
          observedAt: "2026-07-30T23:55:00.000Z",
        },
      ],
      items: [
        createItem({
          nodeId: "I_A",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "new_untriaged",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: "2026-07-30T23:55:00.000Z",
          title: "項目A",
        }),
        createItem({
          nodeId: "I_B",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 2,
          status: "new_untriaged",
          severity: "none",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: "2026-07-30T23:55:00.000Z",
          title: "項目B",
        }),
        createItem({
          nodeId: "I_C",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 3,
          status: "unknown",
          severity: "none",
          waitingOnKind: "unknown",
          waitingOnRole: "unknown",
          observedAt: "2026-07-30T23:55:00.000Z",
          title: "項目C",
        }),
      ],
      relations: [],
    });
    const current = createSnapshot({
      runId: "run-current",
      runStatus: "success",
      generatedAt: GENERATED_AT,
      repositories: [repository],
      items: [
        createItem({
          nodeId: "I_A",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "blocked",
          severity: "urgent",
          waitingOnKind: "item",
          waitingOnRole: "dependency",
          observedAt: FRESH_OBSERVED_AT,
          title: "項目A",
        }),
        createItem({
          nodeId: "I_B",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 2,
          status: "blocked",
          severity: "watch",
          waitingOnKind: "item",
          waitingOnRole: "dependency",
          observedAt: FRESH_OBSERVED_AT,
          title: "項目B",
        }),
        createItem({
          nodeId: "I_C",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 3,
          status: "unknown",
          severity: "none",
          waitingOnKind: "unknown",
          waitingOnRole: "unknown",
          observedAt: FRESH_OBSERVED_AT,
          title: "項目C",
        }),
      ],
      relations: [
        createRelation("rel:A-B", "I_A", "I_B", "blocks"),
        createRelation("rel:B-A", "I_B", "I_A", "blocks"),
      ],
    });
    const historyRecords = [
      createStateHistoryRecord(undefined, previous, "2026-07-31"),
      createStateHistoryRecord(previous, current, "2026-08-01"),
    ];

    const generated = generateFixture(
      current,
      historyRecords,
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(generated.summary.aggregates).toMatchObject({
      repositoryCount: 1,
      itemCount: 3,
      activeEdgeCount: 2,
      componentCount: 2,
      frontierCount: 1,
      cycleCount: 1,
      unknownItemCount: 1,
      staleRepositoryCount: 0,
      staleItemCount: 0,
      statusCounts: {
        blocked: 2,
        unknown: 1,
      },
      severityCounts: {
        none: 1,
        watch: 1,
        urgent: 1,
        critical: 0,
      },
    });
    expect(generated.summary.graph.maxNodes).toBe(DEFAULT_INITIAL_GRAPH_NODE_LIMIT);
    expect(generated.summary.graph.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeCount: 2,
          edgeCount: 2,
          frontierCount: 0,
          cycleCount: 1,
        }),
        expect.objectContaining({
          nodeCount: 1,
          edgeCount: 0,
          frontierCount: 1,
          cycleCount: 0,
        }),
      ]),
    );
    expect(generated.details.graph.frontierNodeIds).toEqual(["I_C"]);
    expect(generated.details.graph.cycles).toMatchObject([
      {
        nodeIds: ["I_A", "I_B"],
        edgeIds: ["rel:A-B", "rel:B-A"],
      },
    ]);
    expect(generated.details.graph.downstreamImpacts).toEqual([
      {
        nodeId: "I_A",
        openNodeCount: 1,
        repositoryCount: 1,
      },
      {
        nodeId: "I_B",
        openNodeCount: 1,
        repositoryCount: 1,
      },
      {
        nodeId: "I_C",
        openNodeCount: 0,
        repositoryCount: 0,
      },
    ]);
    const itemA = generated.details.items.find((item) => item.summary.nodeId === "I_A");
    expect(itemA?.summary.blockerNodeIds).toEqual(["I_B"]);
    expect(itemA?.summary.priorityWeight).toBe(25);
    expect(itemA?.history.at(-2)).toMatchObject({
      kind: "responsibility_changed",
      before: {
        state: "present",
        value: {
          status: "new_untriaged",
        },
      },
      after: {
        state: "present",
        value: {
          status: "blocked",
        },
      },
    });
    expect(itemA?.history.at(-1)).toMatchObject({
      kind: "severity_changed",
      before: {
        state: "present",
        value: "watch",
      },
      after: {
        state: "present",
        value: "urgent",
      },
    });
    expect(generated.details.graph.history).toHaveLength(2);
  });

  it("stale repositoryとAI unavailableを項目まで明示する", () => {
    const snapshot = createSnapshot({
      runId: "run-stale",
      runStatus: "fallback",
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
        {
          id: STALE_REPOSITORY_ID,
          name: "stale",
          observedAt: STALE_OBSERVED_AT,
          freshness: "stale",
          failedAt: FRESH_OBSERVED_AT,
        },
      ],
      items: [
        createItem({
          nodeId: "I_FRESH",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "new_untriaged",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "最新項目",
        }),
        createItem({
          nodeId: "I_STALE",
          repositoryId: STALE_REPOSITORY_ID,
          repositoryName: "stale",
          number: 2,
          status: "waiting_for_review",
          severity: "urgent",
          waitingOnKind: "team",
          waitingOnRole: "reviewer",
          observedAt: STALE_OBSERVED_AT,
          title: "前回値の項目",
        }),
      ],
      relations: [],
    });
    const inventory = createInventory([
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        visibility: "public",
      },
      {
        id: STALE_REPOSITORY_ID,
        name: "stale",
        visibility: "public",
      },
    ]);

    const generated = generateFixture(snapshot, [], inventory, [], defaultGenerationOptions);
    const staleRepository = generated.summary.repositories.find(
      (repository) => repository.id === STALE_REPOSITORY_ID,
    );
    const staleItem = generated.summary.items.find((item) => item.nodeId === "I_STALE");

    expect(generated.summary.aiAvailable).toBe(false);
    expect(generated.summary.observedAt).toBe(FRESH_OBSERVED_AT);
    expect(generated.summary.aggregates).toMatchObject({
      staleRepositoryCount: 1,
      staleItemCount: 1,
    });
    expect(staleRepository).toMatchObject({
      observedAt: STALE_OBSERVED_AT,
      freshness: {
        status: "stale",
        failedAt: FRESH_OBSERVED_AT,
      },
    });
    expect(staleItem).toMatchObject({
      observedAt: STALE_OBSERVED_AT,
      repositoryFreshness: "stale",
    });
  });
});

describe("公開summaryサイズと書き出し", () => {
  it("大きなfixtureを詳細DTOへ分割してsummaryをgzip 1 MiB以内に保つ", () => {
    const itemCount = 5000;
    const edgeCount = 10_000;
    const snapshot = createSnapshot({
      runId: "run-large",
      runStatus: "success",
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: Array.from({ length: itemCount }, (_, index) =>
        createItem({
          nodeId: `I_LARGE_${index.toString().padStart(4, "0")}`,
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: index + 1,
          status: index % 10 === 0 ? "waiting_for_review" : "in_progress",
          severity: index % 10 === 0 ? "urgent" : "none",
          waitingOnKind: index % 10 === 0 ? "team" : "user",
          waitingOnRole: index % 10 === 0 ? "reviewer" : "assignee",
          observedAt: FRESH_OBSERVED_AT,
          title: `大規模fixture項目 ${index.toString().padStart(4, "0")}`,
        }),
      ),
      relations: Array.from({ length: edgeCount }, (_, index) => {
        const fromIndex = index % itemCount;
        const distance = index < itemCount ? 1 : 2;
        const toIndex = (fromIndex + distance) % itemCount;
        return createRelation(
          `rel:LARGE_${index.toString().padStart(5, "0")}`,
          `I_LARGE_${fromIndex.toString().padStart(4, "0")}`,
          `I_LARGE_${toIndex.toString().padStart(4, "0")}`,
          "blocks",
        );
      }),
    });
    const options = {
      labelRules: defaultGenerationOptions.labelRules,
      maxInitialGraphNodes: 100,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
    } satisfies PublicDtoGenerationOptions;

    const generated = generateFixture(snapshot, [], publicInventory(), [], options);

    expect(generated.summary.items).toHaveLength(itemCount);
    expect(generated.summary.graph.nodes).toHaveLength(100);
    expect(generated.summary.graph.maxNodes).toBe(100);
    expect(generated.summary.graph.omittedNodeCount).toBe(4900);
    expect(generated.summarySize.gzipBytes).toBeLessThanOrEqual(PUBLIC_SUMMARY_GZIP_LIMIT_BYTES);
  }, 30_000);

  it("設定した上限を超えるfixtureではDTO生成を失敗させる", () => {
    const snapshot = createSingleItemSnapshot("gzip上限超過fixture");
    const options = {
      labelRules: defaultGenerationOptions.labelRules,
      maxInitialGraphNodes: 1,
      maxSummaryGzipBytes: 64,
    } satisfies PublicDtoGenerationOptions;

    expect(() => generateFixture(snapshot, [], publicInventory(), [], options)).toThrow(
      PublicSummarySizeError,
    );
  });

  it("薄いadapterがsummaryとdetailsを別ファイルへ書き出す", async () => {
    const generated = generateFixture(
      createSingleItemSnapshot("書き出しfixture"),
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );
    const outputDirectory = await mkdtemp(join(tmpdir(), "voicevox-pages-public-data-"));
    try {
      const result = await writePublicDataFiles(outputDirectory, generated);
      const summarySource = await readFile(join(outputDirectory, PUBLIC_SUMMARY_FILE_NAME), "utf8");
      const detailsSource = await readFile(join(outputDirectory, PUBLIC_DETAILS_FILE_NAME), "utf8");

      expect(result.summaryBytes).toBe(Buffer.byteLength(summarySource, "utf8"));
      expect(result.detailsBytes).toBe(Buffer.byteLength(detailsSource, "utf8"));
      expect(JSON.parse(summarySource)).toMatchObject({
        schemaVersion: "1",
        runId: "run-single",
      });
      expect(JSON.parse(detailsSource)).toMatchObject({
        schemaVersion: "1",
        runId: "run-single",
      });
    } finally {
      await rm(outputDirectory, {
        recursive: true,
      });
    }
  });
});

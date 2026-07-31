import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createProductionCliApplication,
  type ProductionRuntimeAdapters,
} from "../src/cli/production-runtime.js";
import { loadConfig, type Config } from "../src/config/index.js";
import { type DiscordDigestDelivery } from "../src/discord/index.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type ObservedGitHubItemState,
  type Repository,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  createGitHubBodyFingerprint,
  createPublicRepositoryAllowlist,
  GitHubRetryExhaustedError,
  type EnumeratedGitHubItem,
  type GitHubItemDetail,
  type GitHubItemDetailEventWindow,
  type GitHubIssueComment,
  type GitHubNativeDependency,
  type PublicRepository,
} from "../src/github/index.js";
import {
  createStateSnapshot,
  MemoryStateBranchAdapter,
  parseStateHistoryRecords,
  parseStateSnapshot,
  StatePersistenceSession,
  type StateSnapshot,
} from "../src/persistence/index.js";

const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "production-collection-test-key",
  "-----END PRIVATE KEY-----",
].join("\n");
const START_AT = "2026-01-01T00:00:00.000Z";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const SECOND_RUN_AT = "2026-08-02T00:00:00.000Z";
const THIRD_RUN_AT = "2026-08-04T00:00:00.000Z";
const displayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);

type IssueStateFixture =
  | Readonly<{
      state: "open";
    }>
  | Readonly<{
      state: "closed";
      closedAt: UtcIsoDateTime;
    }>;

interface RepositoryFixture {
  repository: Repository;
  openItems: EnumeratedGitHubItem[];
  individualItems: Map<string, EnumeratedGitHubItem>;
  details: Map<GitHubNodeId, GitHubItemDetail>;
  enumerationFailsWith503: boolean;
}

type DetailCall = Readonly<{
  nodeIds: readonly GitHubNodeId[];
  eventWindow: GitHubItemDetailEventWindow;
}>;

function createRepository(id: string, name: string, observedAt: string): Repository {
  return Object.freeze({
    id: createGitHubRepositoryId(id),
    owner: "VOICEVOX",
    name,
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt: createUtcIsoDateTime(observedAt),
  });
}

function requirePublicRepository(repository: Repository): PublicRepository {
  const value = createPublicRepositoryAllowlist([repository]).repositories[0];
  if (value == null) {
    throw new TypeError("公開repository fixtureを作成できません");
  }
  return value;
}

function createIssueItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    updatedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
    state: IssueStateFixture;
  }>,
): EnumeratedGitHubItem {
  const nodeId = createGitHubNodeId(`I_${options.repository.name}_${options.number.toString()}`);
  const url =
    `https://github.com/${options.repository.owner}/${options.repository.name}/issues/${options.number.toString()}` satisfies GitHubItemUrl;
  const displayReference = displayReferenceSchema.parse(
    `${options.repository.owner}/${options.repository.name}#${options.number.toString()}`,
  );
  const stateFields: ObservedGitHubItemState =
    options.state.state === "open"
      ? Object.freeze({
          state: "open",
          stateReason: null,
          closedAt: null,
        })
      : Object.freeze({
          state: "closed",
          stateReason: "completed",
          closedAt: options.state.closedAt,
        });
  return Object.freeze({
    nodeId,
    repositoryId: options.repository.id,
    displayReference,
    number: options.number,
    url,
    title: `項目${options.number.toString()}`,
    bodyFingerprint: createGitHubBodyFingerprint(`body-${options.fingerprint}`),
    bodyLocator: Object.freeze({
      kind: "github_item_body",
      repositoryId: options.repository.id,
      itemNodeId: nodeId,
      number: options.number,
    }),
    author: Object.freeze({
      kind: "account",
      account: Object.freeze({
        nodeId: createGitHubNodeId(`U_author_${options.number.toString()}`),
        login: `author-${options.number.toString()}`,
        apiType: "User",
      }),
    }),
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00.000Z"),
    updatedAt: options.updatedAt,
    assignees: Object.freeze([]),
    labels: Object.freeze([]),
    milestone: null,
    itemFingerprint: createGitHubBodyFingerprint(`item-${options.fingerprint}`),
    observedAt: options.observedAt,
    type: "issue",
    draft: "not_applicable",
    ...stateFields,
  });
}

function createDuplicateComments(
  item: EnumeratedGitHubItem,
  occurredAt: UtcIsoDateTime,
): readonly GitHubIssueComment[] {
  const nodeId = createGitHubNodeId(`IC_${item.nodeId}`);
  const comment = Object.freeze({
    sourceId: buildSourceId("github_issue_comment", nodeId),
    nodeId,
    sequence: 0,
    author: Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_commenter"),
        nodeId: createGitHubNodeId("U_commenter"),
        login: "commenter",
        apiType: "User",
      }),
    }),
    body: "overlapで重複したコメント",
    createdAt: occurredAt,
    updatedAt: occurredAt,
    url: item.url,
  } satisfies GitHubIssueComment);
  return Object.freeze([
    comment,
    Object.freeze({
      ...comment,
      sequence: 1,
    }),
  ]);
}

function createIssueDetail(
  options: Readonly<{
    item: EnumeratedGitHubItem;
    body: string;
    observedAt: UtcIsoDateTime;
    nativeDependencies: readonly GitHubNativeDependency[];
    duplicateComments: boolean;
  }>,
): GitHubItemDetail {
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", options.item.nodeId),
    nodeId: options.item.nodeId,
    repositoryId: options.item.repositoryId,
    number: options.item.number,
    type: "issue",
    bodySourceId: buildSourceId("github_item_body", options.item.nodeId),
    body: options.body,
    comments: options.duplicateComments
      ? createDuplicateComments(options.item, options.observedAt)
      : Object.freeze([]),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    nativeDependencies: Object.freeze({
      availability: "available",
      relations: options.nativeDependencies,
    }),
    nativeHierarchy: Object.freeze({
      availability: "available",
      relations: Object.freeze([]),
    }),
    observedAt: options.observedAt,
  });
}

function createNativeBlocker(
  blocked: EnumeratedGitHubItem,
  blocker: EnumeratedGitHubItem,
): GitHubNativeDependency {
  const repositoryName = new URL(blocker.url).pathname.split("/")[2];
  if (repositoryName == null || repositoryName.length === 0) {
    throw new TypeError("blocker URLからrepository名を取得できません");
  }
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocked.nodeId}:${blocker.nodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", blocker.nodeId),
      nodeId: blocker.nodeId,
      repositoryId: blocker.repositoryId,
      repositoryOwner: "VOICEVOX",
      repositoryName,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: blocker.type,
      number: blocker.number,
      url: blocker.url,
      state: blocker.state,
    }),
  });
}

function createRepositoryFixture(repository: Repository): RepositoryFixture {
  return {
    repository,
    openItems: [],
    individualItems: new Map(),
    details: new Map(),
    enumerationFailsWith503: false,
  };
}

async function createTestConfig(
  options: Readonly<{
    explicitIncludes: readonly string[];
    retentionDays: number;
    aiEnabled: boolean;
  }>,
): Promise<Config> {
  const base = await loadConfig(join(import.meta.dirname, "fixtures/config.valid.yml"));
  const team = Object.freeze({
    org: "VOICEVOX",
    slug: "production-test-team",
  });
  return Object.freeze({
    ...base,
    tracking: Object.freeze({
      ...base.tracking,
      startAt: START_AT,
      include: [...options.explicitIncludes],
      retentionDaysAfterTerminal: options.retentionDays,
    }),
    teams: Object.freeze({
      defaults: Object.freeze({
        maintainers: [team],
        reviewers: [team],
      }),
      repositories: Object.freeze({}),
    }),
    ai: Object.freeze({
      ...base.ai,
      enabled: options.aiEnabled,
    }),
    notifications: Object.freeze({
      discord: Object.freeze({
        ...base.notifications.discord,
        enabled: false,
      }),
    }),
  });
}

function requireSingleRepository(repositories: readonly PublicRepository[]): PublicRepository {
  const repository = repositories[0];
  if (repository == null || repositories.length !== 1) {
    throw new TypeError("repository単位の収集呼び出しではありません");
  }
  return repository;
}

function requireDryRunSnapshot(artifacts: readonly unknown[]): StateSnapshot {
  const artifact = artifacts.at(-1);
  if (typeof artifact !== "object" || artifact == null || !("result" in artifact)) {
    throw new TypeError("dry-run artifactがありません");
  }
  const result = artifact.result;
  if (typeof result !== "object" || result == null || !("snapshot" in result)) {
    throw new TypeError("dry-run artifactにsnapshotがありません");
  }
  return createStateSnapshot(result.snapshot);
}

function createCollectionHarness(
  options: Readonly<{
    repositories: readonly RepositoryFixture[];
    config: Config;
  }>,
) {
  const stateAdapter = new MemoryStateBranchAdapter();
  const artifacts: unknown[] = [];
  const detailCalls: DetailCall[] = [];
  const individualCalls: string[][] = [];
  let codexExecutionCount = 0;
  let currentTime = FIRST_RUN_AT;
  let inventory = options.repositories.map((fixture) => fixture.repository);
  const fixturesByRepositoryId = new Map(
    options.repositories.map((fixture) => [fixture.repository.id, fixture]),
  );
  const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
    environment: Object.freeze({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      GH_APP_INSTALLATION_ID: "456",
      HOME: "/tmp",
      OPENAI_API_KEY: "production-collection-openai-key",
      PATH: "/usr/bin",
    }),
    repositoryPath: join(import.meta.dirname, ".."),
    pagesOutputDirectory: "unused-pages",
    loadConfig: () => Promise.resolve(options.config),
    openStateSession: (adapter, configuration) =>
      StatePersistenceSession.open(adapter, configuration),
    discoverRepositoryInventory: () => Promise.resolve(Object.freeze([...inventory])),
    collectGitHubTeamDirectory: () =>
      Promise.resolve(
        Object.freeze([
          Object.freeze({
            nodeId: createGitHubNodeId("T_production_test"),
            org: "VOICEVOX",
            slug: "production-test-team",
            members: Object.freeze([]),
          }),
        ]),
      ),
    enumerateOpenGitHubItems: (input) => {
      const repository = requireSingleRepository(input.allowlist.repositories);
      const fixture = fixturesByRepositoryId.get(repository.id);
      if (fixture == null) {
        throw new TypeError(`repository fixtureがありません。対象: ${repository.id}`);
      }
      if (fixture.enumerationFailsWith503) {
        throw new GitHubRetryExhaustedError(503, 4, {
          cause: new Error("repository fixture 503"),
        });
      }
      return Promise.resolve(Object.freeze([...fixture.openItems]));
    },
    enumerateGitHubItemsByIdentifiers: (input) => {
      individualCalls.push([...input.identifiers]);
      const items = input.identifiers.map((identifier) => {
        for (const fixture of options.repositories) {
          const item =
            fixture.individualItems.get(identifier) ??
            [...fixture.individualItems.values()].find(
              (candidate) => candidate.nodeId === identifier || candidate.url === identifier,
            );
          if (item != null && input.allowlist.has(item.repositoryId)) {
            return item;
          }
        }
        throw new TypeError(`個別項目fixtureがありません。対象: ${identifier}`);
      });
      return Promise.resolve(Object.freeze(items));
    },
    collectGitHubItemDetails: (input) => {
      detailCalls.push(
        Object.freeze({
          nodeIds: Object.freeze(input.items.map((item) => item.nodeId)),
          eventWindow: input.eventWindow,
        }),
      );
      const items = input.items.map((item) => {
        const fixture = fixturesByRepositoryId.get(item.repositoryId);
        const detail = fixture?.details.get(item.nodeId);
        if (detail == null) {
          throw new TypeError(`詳細fixtureがありません。対象: ${item.nodeId}`);
        }
        return detail;
      });
      return Promise.resolve(
        Object.freeze({
          capabilities: Object.freeze({
            nativeDependencies: "available",
            nativeHierarchy: "available",
          }),
          items: Object.freeze(items),
        }),
      );
    },
    executeCodexAnalysis: () => {
      codexExecutionCount += 1;
      return Promise.reject(new TypeError("Codex失敗fixture"));
    },
    readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
    readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
    readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
    readWorkflowArtifact: () => Promise.reject(new TypeError("workflow artifactは読みません")),
    createGitHubClient: () =>
      Promise.resolve(
        Object.freeze({
          installationId: 456,
          request: () => Promise.reject(new TypeError("GitHub RESTはmock adapter内だけで使います")),
          graphql: () =>
            Promise.reject(new TypeError("GitHub GraphQLはmock adapter内だけで使います")),
          getRateLimitSnapshot: () =>
            Object.freeze({
              source: "rest",
              limit: 5000,
              remaining: 4000,
              resetAt: currentTime,
              observedAt: currentTime,
              resource: "core",
            }),
        }),
      ),
    createStateBranchAdapter: () => stateAdapter,
    codexProcessRunner: (request) => {
      if (request.arguments.length === 1 && request.arguments[0] === "--version") {
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
      }
      return Promise.reject(new TypeError("Codex subprocessは起動しません"));
    },
    discordHttpClient: Object.freeze({
      execute: () => Promise.reject(new TypeError("Discord HTTPは呼びません")),
    }),
    now: () => new Date(currentTime),
    sleep: () => Promise.resolve(),
    random: () => 0,
    writeStandardOutput: () => Promise.resolve(),
    writeJsonArtifact: (_path, value) => {
      artifacts.push(value);
      return Promise.resolve();
    },
    writeTextFile: () => Promise.resolve(),
    writePublicData: () =>
      Promise.resolve({
        summaryPath: "unused-pages/summary.json",
        detailsPath: "unused-pages/details.json",
        summaryBytes: 1,
        detailsBytes: 1,
      }),
    sendDiscord: () =>
      Promise.resolve(
        Object.freeze({
          status: "skipped",
          reason: "no_candidates",
        } satisfies DiscordDigestDelivery),
      ),
  });
  const application = createProductionCliApplication(runtimeAdapters);
  return {
    artifacts,
    detailCalls,
    individualCalls,
    stateAdapter,
    codexExecutionCount: () => codexExecutionCount,
    setInventory: (value: readonly Repository[]) => {
      inventory = [...value];
    },
    runDaily: (at: string) => {
      currentTime = at;
      return application.run([
        "daily",
        "--config",
        "unused-config.yml",
        "--report",
        "unused-report.json",
      ]);
    },
    runDry: (at: string) => {
      currentTime = at;
      return application.run([
        "dry-run",
        "--config",
        "unused-config.yml",
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
      ]);
    },
  };
}

function setIssueDetails(
  fixture: RepositoryFixture,
  items: readonly EnumeratedGitHubItem[],
  observedAt: UtcIsoDateTime,
): void {
  fixture.details = new Map(
    items.map((item) => [
      item.nodeId,
      createIssueDetail({
        item,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    ]),
  );
}

describe("本番収集の接続", () => {
  it("fingerprint変更項目とgraph隣接nodeだけをoverlap起点で詳細取得する", async () => {
    const repository = createRepository("R_incremental", "incremental", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItems = [1, 2, 3, 4].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `v1-${number.toString()}`,
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...firstItems];
    setIssueDetails(fixture, firstItems, firstObservedAt);
    const first = firstItems[0];
    const blocker = firstItems[2];
    if (first == null || blocker == null) {
      throw new TypeError("増分fixture項目がありません");
    }
    fixture.details.set(
      first.nodeId,
      createIssueDetail({
        item: first,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(first, blocker)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode).toBe(0);
    harness.detailCalls.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItems = firstItems.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint: item.number === 2 ? "v2-2" : `v1-${item.number.toString()}`,
        updatedAt: item.number === 2 ? secondObservedAt : firstObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...secondItems];
    setIssueDetails(fixture, secondItems, secondObservedAt);
    const changed = secondItems[1];
    if (changed == null) {
      throw new TypeError("変更項目fixtureがありません");
    }
    fixture.details.set(
      changed.nodeId,
      createIssueDetail({
        item: changed,
        body: "変更後本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: true,
      }),
    );

    const secondResult = await harness.runDry(SECOND_RUN_AT);

    if (secondResult.exitCode !== 0) {
      throw new TypeError(JSON.stringify(secondResult));
    }
    expect(secondResult).toMatchObject({ exitCode: 0 });
    expect(harness.detailCalls).toHaveLength(1);
    expect(harness.detailCalls[0]).toEqual({
      nodeIds: [firstItems[0]?.nodeId, changed.nodeId, blocker.nodeId],
      eventWindow: {
        mode: "incremental",
        since: "2026-07-31T23:55:00.000Z",
      },
    });
    expect(requireDryRunSnapshot(harness.artifacts).items).toHaveLength(4);
  });

  it("503のrepositoryを前回値と最終成功時刻付きstaleとして保持して通知から除外する", async () => {
    const firstRepository = createRepository("R_fresh", "fresh", FIRST_RUN_AT);
    const secondRepository = createRepository("R_stale", "stale", FIRST_RUN_AT);
    const firstFixture = createRepositoryFixture(firstRepository);
    const secondFixture = createRepositoryFixture(secondRepository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: requirePublicRepository(firstRepository),
      number: 1,
      fingerprint: "fresh-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondItem = createIssueItem({
      repository: requirePublicRepository(secondRepository),
      number: 1,
      fingerprint: "stale-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    firstFixture.openItems = [firstItem];
    secondFixture.openItems = [secondItem];
    setIssueDetails(firstFixture, [firstItem], observedAt);
    setIssueDetails(secondFixture, [secondItem], observedAt);
    secondFixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondItem, firstItem)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [firstFixture, secondFixture],
      config,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    secondFixture.enumerationFailsWith503 = true;
    harness.artifacts.length = 0;

    const result = await harness.runDry(SECOND_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const staleRepository = snapshot.repositories.find(
      (repository) => repository.id === secondRepository.id,
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(staleRepository).toEqual({
      ...requirePublicRepository(secondRepository),
      observedAt: FIRST_RUN_AT,
      freshness: "stale",
      failedAt: SECOND_RUN_AT,
    });
    expect(snapshot.items.map((item) => item.nodeId)).toContain(secondItem.nodeId);
    expect(snapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: firstItem.nodeId,
        toNodeId: secondItem.nodeId,
        active: true,
      }),
    );
    expect(harness.artifacts.at(-1)).toMatchObject({
      metrics: {
        staleRepositoryCount: 1,
      },
      result: {
        notificationSelection: {
          candidates: [],
        },
      },
    });
  });

  it("open列挙にないclosed項目を明示includeから個別取得する", async () => {
    const repository = createRepository("R_explicit", "explicit", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "closed-explicit",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    fixture.individualItems.set(item.url, item);
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [item.url],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toContainEqual([item.url]);
    expect(harness.detailCalls[0]?.nodeIds).toEqual([item.nodeId]);
    expect(snapshot.items[0]).toMatchObject({
      nodeId: item.nodeId,
      state: "closed",
      status: "terminal_completed",
    });
  });

  it("open一覧から消えた項目をterminalへ更新し保持期間後にactive datasetから外す", async () => {
    const repository = createRepository("R_terminal", "terminal", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const openItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "open",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [openItem];
    setIssueDetails(fixture, [openItem], firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 1,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const closedItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "closed",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: secondObservedAt,
      }),
    });
    fixture.openItems = [];
    fixture.individualItems.set(closedItem.url, closedItem);
    setIssueDetails(fixture, [closedItem], secondObservedAt);
    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    const filesAfterClose = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotBytesAfterClose = filesAfterClose.get("state/snapshot.json");
    if (snapshotBytesAfterClose == null) {
      throw new TypeError("terminal遷移後のsnapshotがありません");
    }
    const snapshotAfterClose = parseStateSnapshot(
      new TextDecoder().decode(snapshotBytesAfterClose),
    );
    expect(snapshotAfterClose.items[0]).toMatchObject({
      state: "closed",
      status: "terminal_completed",
    });
    harness.individualCalls.length = 0;
    harness.artifacts.length = 0;

    expect((await harness.runDry(THIRD_RUN_AT)).exitCode).toBe(0);
    expect(harness.individualCalls).toHaveLength(0);
    expect(requireDryRunSnapshot(harness.artifacts).items).toHaveLength(0);
  });

  it("未変更terminal項目の詳細取得とCodex再分析と停滞通知を抑止する", async () => {
    const repository = createRepository("R_suppression", "suppression", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const target = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "target",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const terminal = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "terminal",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [target];
    fixture.individualItems.set(terminal.url, terminal);
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      terminal.nodeId,
      createIssueDetail({
        item: terminal,
        body: `${target.url} を参照します`,
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [terminal.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstCodexExecutionCount = harness.codexExecutionCount();
    expect(firstCodexExecutionCount).toBeGreaterThan(0);
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const unchangedTarget = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "target",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const unchangedTerminal = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "terminal",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [unchangedTarget];
    fixture.individualItems.set(unchangedTerminal.url, unchangedTerminal);

    const result = await harness.runDry(SECOND_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toHaveLength(0);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(harness.artifacts.at(-1)).toMatchObject({
      result: {
        notificationSelection: {
          candidates: [],
        },
      },
    });
  });

  it("archiveで除外したrepositoryの理由を日次履歴へ残す", async () => {
    const repository = createRepository("R_archive", "archive", FIRST_RUN_AT);
    const retainedRepository = createRepository("R_retained", "retained", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const retainedFixture = createRepositoryFixture(retainedRepository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "archive-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture, retainedFixture],
      config,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.setInventory([
      retainedRepository,
      Object.freeze({
        ...repository,
        archived: true,
        observedAt: createUtcIsoDateTime(SECOND_RUN_AT),
      }),
    ]);

    const result = await harness.runDaily(SECOND_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const historyBytes = files.get("state/history/2026-08-02.jsonl");
    const snapshotBytes = files.get("state/snapshot.json");
    if (historyBytes == null || snapshotBytes == null) {
      throw new TypeError("archive除外後のstateがありません");
    }
    const records = parseStateHistoryRecords(new TextDecoder().decode(historyBytes));
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotBytes));

    expect(result.exitCode).toBe(0);
    expect(snapshot.repositories.map((entry) => entry.id)).toEqual([retainedRepository.id]);
    expect(snapshot.items).toHaveLength(0);
    expect(records[0]?.events).toContainEqual({
      kind: "repository_excluded",
      repositoryFullName: "VOICEVOX/archive",
      reason: "archived",
    });
  });
});

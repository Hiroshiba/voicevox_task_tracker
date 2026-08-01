import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createProductionCliApplication,
  type ProductionRuntimeAdapters,
} from "../src/cli/production-runtime.js";
import { createAiCacheEntry, type CodexAnalysisInput } from "../src/codex/index.js";
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
  type NotificationReasonCode,
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
  type GitHubInboundCrossReferenceCandidate,
  type GitHubIssueComment,
  type GitHubNativeDependency,
  type GitHubReferencedItem,
  type GitHubTimelineEvent,
  type PublicRepository,
} from "../src/github/index.js";
import { type RelationAssessmentVerdict } from "../src/graph/index.js";
import {
  createStateSnapshot,
  MemoryStateBranchAdapter,
  parseStateHistoryRecords,
  parseStateSnapshot,
  StatePersistenceSession,
  type StateSnapshot,
} from "../src/persistence/index.js";
import { type GeneratedPublicData } from "../src/pages/index.js";

const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "production-collection-test-key",
  "-----END PRIVATE KEY-----",
].join("\n");
const START_AT = "2026-01-01T00:00:00.000Z";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const SECOND_RUN_AT = "2026-08-02T00:00:00.000Z";
const THIRD_RUN_AT = "2026-08-04T00:00:00.000Z";
const FOURTH_RUN_AT = "2026-08-05T00:00:00.000Z";
const OLD_ITEM_AT = "2025-12-01T00:00:00.000Z";
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

function replaceCreatedAt(
  item: EnumeratedGitHubItem,
  createdAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    createdAt,
  });
}

function replaceWithAutomationDashboard(
  item: EnumeratedGitHubItem,
  title: string,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    title,
    author: Object.freeze({
      kind: "account",
      account: Object.freeze({
        nodeId: createGitHubNodeId("BOT_RENOVATE"),
        login: "renovate[bot]",
        apiType: "Bot",
      }),
    }),
  });
}

function createPullRequestItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    updatedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
  }>,
): EnumeratedGitHubItem {
  const issue = createIssueItem({
    ...options,
    state: Object.freeze({ state: "open" }),
  });
  return Object.freeze({
    ...issue,
    type: "pull_request",
    draft: false,
    url: `https://github.com/${options.repository.owner}/${options.repository.name}/pull/${options.number.toString()}`,
  } satisfies EnumeratedGitHubItem);
}

function createFailedCheckPullRequestDetail(
  item: EnumeratedGitHubItem,
  observedAt: UtcIsoDateTime,
): Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>> {
  const headSourceId = buildSourceId("github_commit", `${item.nodeId}:head`);
  const checkSourceId = buildSourceId("github_check_rollup", item.nodeId);
  const contextSourceId = buildSourceId("github_check_run", `${item.nodeId}:test`);
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "pull_request",
    bodySourceId: buildSourceId("github_item_body", item.nodeId),
    body: "required checkの失敗原因を判定する",
    comments: Object.freeze([]),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    reviews: Object.freeze([]),
    reviewThreads: Object.freeze([]),
    reviewRequests: Object.freeze({
      current: Object.freeze([]),
      history: Object.freeze([]),
    }),
    headSha: `head-${item.nodeId}`,
    headCommit: Object.freeze({
      sourceId: headSourceId,
      nodeId: createGitHubNodeId(`C_${item.nodeId}`),
      sha: `head-${item.nodeId}`,
      committedAt: observedAt,
      pushedAt: Object.freeze({
        status: "available",
        value: observedAt,
      }),
    }),
    mergeState: Object.freeze({
      mergeability: "mergeable",
      mergeState: "unstable",
      autoMerge: Object.freeze({
        status: "not_enabled",
      }),
      mergeQueue: Object.freeze({
        status: "not_queued",
      }),
      checks: Object.freeze({
        status: "configured",
        sourceId: checkSourceId,
        nodeId: createGitHubNodeId(`CHECKS_${item.nodeId}`),
        combinedState: "failure",
        contexts: Object.freeze([
          Object.freeze({
            type: "check_run",
            sourceId: contextSourceId,
            nodeId: createGitHubNodeId(`CHECK_${item.nodeId}`),
            name: "test",
            status: "completed",
            conclusion: "failure",
          }),
        ]),
      }),
    }),
    observedAt,
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
    url: `${item.url}#issuecomment-${nodeId}`,
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

function createExternalNativeBlocker(
  blocked: EnumeratedGitHubItem,
  options: Readonly<{
    state: "open" | "closed";
    repositoryArchived: boolean;
    repositoryDisabled: boolean;
  }>,
): GitHubNativeDependency {
  const externalNodeId = createGitHubNodeId("I_external_blocker");
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocked.nodeId}:${externalNodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", externalNodeId),
      nodeId: externalNodeId,
      repositoryId: createGitHubRepositoryId("R_external_public"),
      repositoryOwner: "external-owner",
      repositoryName: "external-repository",
      repositoryArchived: options.repositoryArchived,
      repositoryDisabled: options.repositoryDisabled,
      type: "issue",
      number: 42,
      url: "https://github.com/external-owner/external-repository/issues/42",
      state: options.state,
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
      ...base.notifications,
      discord: Object.freeze({
        ...base.notifications.discord,
        enabled: false,
      }),
    }),
  });
}

function configWithBudget(
  config: Config,
  maxCallsPerRun: number,
  maxEstimatedCostUsdPerRun: number,
): Config {
  return Object.freeze({
    ...config,
    ai: Object.freeze({
      ...config.ai,
      budget: Object.freeze({
        ...config.ai.budget,
        maxCallsPerRun,
        maxEstimatedCostUsdPerRun,
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

function requireCollectionItem(
  snapshot: StateSnapshot,
  nodeId: GitHubNodeId,
): StateSnapshot["collection"]["repositories"][number]["items"][number] {
  const item = snapshot.collection.repositories
    .flatMap((repository) => repository.items)
    .find((candidate) => candidate.nodeId === nodeId);
  if (item == null) {
    throw new TypeError(`snapshotの収集項目がありません。対象: ${nodeId}`);
  }
  return item;
}

function createCodexOutput(
  input: CodexAnalysisInput,
  options: Readonly<{
    status: "waiting_for_author" | "waiting_for_automation" | "in_progress" | "unknown";
    waitingOn: Readonly<{
      candidateId: string;
      kind: "user" | "team" | "role" | "item" | "automation" | "unknown";
      role:
        | "author"
        | "maintainer"
        | "reviewer"
        | "assignee"
        | "dependency"
        | "merge_decider"
        | "ci"
        | "unknown";
      sourceId: string;
    }>;
    latestMeaningfulSourceId: string | null;
    confidence: number;
    relationVerdict: RelationAssessmentVerdict;
    notification: Readonly<{
      recommended: boolean;
      reasonCode: NotificationReasonCode;
      reasonSummary: string;
    }>;
  }>,
): unknown {
  const evidenceSource = input.sources[0];
  if (evidenceSource == null) {
    throw new TypeError("Codex入力にsourceがありません");
  }
  return {
    schemaVersion: "1",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: options.status,
    waitingOn: [
      {
        kind: options.waitingOn.kind,
        candidateId: options.waitingOn.candidateId,
        role: options.waitingOn.role,
        reasonSummary: "本番経路fixtureの判定です",
        sourceIds: [options.waitingOn.sourceId],
        confidence: options.confidence,
      },
    ],
    nextAction: "本番経路fixtureの次の対応を行う",
    relations: input.candidates.relations.map((candidate) => ({
      candidateId: candidate.id,
      verdict: options.relationVerdict,
      reasonSummary: "本番経路fixtureの関係判定です",
      sourceIds: [evidenceSource.id],
      confidence: options.confidence,
    })),
    progress: {
      latestMeaningfulSourceId: options.latestMeaningfulSourceId,
      reasonSummary: "本番経路fixtureの進捗判定です",
      confidence: options.confidence,
    },
    evidence: [
      {
        sourceId: evidenceSource.id,
        supports: "status",
        summary: "本番経路fixtureの根拠です",
      },
    ],
    confidence: options.confidence,
    uncertainties: [],
    notification: options.notification,
  };
}

function createCollectionHarness(
  options: Readonly<{
    repositories: readonly RepositoryFixture[];
    config: Config;
    executeCodexAnalysis?: (input: CodexAnalysisInput) => Promise<unknown>;
  }>,
) {
  const stateAdapter = new MemoryStateBranchAdapter();
  const artifacts: unknown[] = [];
  const publicData: GeneratedPublicData[] = [];
  const discordCandidateNodeIds: GitHubNodeId[][] = [];
  const detailCalls: DetailCall[] = [];
  const individualCalls: string[][] = [];
  let codexExecutionCount = 0;
  const codexInputs: CodexAnalysisInput[] = [];
  let currentTime = FIRST_RUN_AT;
  let inventory = options.repositories.map((fixture) => fixture.repository);
  let config = options.config;
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
    loadConfig: () => Promise.resolve(config),
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
    executeCodexAnalysis: (input) => {
      codexExecutionCount += 1;
      codexInputs.push(input);
      return (
        options.executeCodexAnalysis?.(input) ?? Promise.reject(new TypeError("Codex失敗fixture"))
      );
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
    writePublicData: (_outputDirectory, data) => {
      publicData.push(data);
      return Promise.resolve({
        summaryPath: "unused-pages/summary.json",
        detailsPath: "unused-pages/details.json",
        summaryBytes: 1,
        detailsBytes: 1,
      });
    },
    sendDiscord: (input) => {
      discordCandidateNodeIds.push(input.candidates.map((candidate) => candidate.itemNodeId));
      return Promise.resolve(
        Object.freeze({
          status: "skipped",
          reason: "no_candidates",
        } satisfies DiscordDigestDelivery),
      );
    },
  });
  const application = createProductionCliApplication(runtimeAdapters);
  return {
    artifacts,
    codexInputs,
    detailCalls,
    discordCandidateNodeIds,
    individualCalls,
    stateAdapter,
    publicData,
    codexExecutionCount: () => codexExecutionCount,
    setInventory: (value: readonly Repository[]) => {
      inventory = [...value];
    },
    setConfig: (value: Config) => {
      config = value;
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

function createHistoryInputDetail(
  item: EnumeratedGitHubItem,
  occurredAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  const comment = createDuplicateComments(item, occurredAt)[0];
  if (comment == null) {
    throw new TypeError("履歴入力イベント用のコメントがありません");
  }
  const labelerNodeId = createGitHubNodeId("U_history_labeler");
  const labelEvent = Object.freeze({
    sourceId: buildSourceId("github_timeline_event", "L_history_label"),
    nodeId: createGitHubNodeId("L_history_label"),
    sequence: 1,
    occurredAt,
    actor: Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_actor", labelerNodeId),
        nodeId: labelerNodeId,
        login: "history-labeler",
        apiType: "User",
      }),
    }),
    kind: "labeled",
    label: Object.freeze({
      sourceId: buildSourceId("github_label", "LA_history"),
      nodeId: createGitHubNodeId("LA_history"),
      name: "履歴対象",
    }),
  } satisfies GitHubTimelineEvent);
  return Object.freeze({
    ...createIssueDetail({
      item,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
    comments: Object.freeze([comment]),
    timeline: Object.freeze([labelEvent]),
  });
}

describe("本番収集の接続", () => {
  it("AI無効時の有効状態と利用可否をrun成功状態から分離して保存する", async () => {
    const repository = createRepository("R_ai_disabled", "ai-disabled", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "ai-disabled-v1",
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
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(snapshot.run.status).toBe("success");
    expect(snapshot.ai).toEqual({
      enabled: false,
      available: false,
      degraded: false,
    });
  });

  it("同じupdated_atの正規化イベントをkind別に履歴へ一度だけ保存する", async () => {
    const repository = createRepository("R_history_events", "history-events", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "history-events-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstItem];
    fixture.details.set(
      firstItem.nodeId,
      createHistoryInputDetail(firstItem, firstObservedAt, firstObservedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstHistoryBytes = firstFiles.get("state/history/2026-08-01.jsonl");
    if (firstHistoryBytes == null) {
      throw new TypeError("正規化イベントの初回履歴がありません");
    }
    const firstRecords = parseStateHistoryRecords(new TextDecoder().decode(firstHistoryBytes));

    expect(firstRecords[0]?.inputEvents).toEqual([
      {
        sourceId: `github_issue_comment:IC_${firstItem.nodeId}`,
        itemNodeId: firstItem.nodeId,
        kind: "comment",
        actor: {
          type: "human",
          nodeId: "U_commenter",
          login: "commenter",
        },
        occurredAt: firstObservedAt,
      },
      {
        sourceId: "github_timeline_event:L_history_label",
        itemNodeId: firstItem.nodeId,
        kind: "label",
        actor: {
          type: "human",
          nodeId: "U_history_labeler",
          login: "history-labeler",
        },
        occurredAt: firstObservedAt,
      },
    ]);

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "history-events-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [secondItem];
    fixture.details.set(
      secondItem.nodeId,
      createHistoryInputDetail(secondItem, firstObservedAt, secondObservedAt),
    );

    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    const secondFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const secondHistoryBytes = secondFiles.get("state/history/2026-08-02.jsonl");
    if (secondHistoryBytes == null) {
      throw new TypeError("正規化イベントの二回目の履歴がありません");
    }
    const secondRecords = parseStateHistoryRecords(new TextDecoder().decode(secondHistoryBytes));

    expect(secondRecords[0]?.inputEvents).toEqual([]);
  });

  it("automation dashboardをgraphに残しつつ既定digestから除外する", async () => {
    const repository = createRepository("R_automation", "automation", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = replaceWithAutomationDashboard(
      createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "automation-dashboard",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      "依存更新ダッシュボード",
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      notifications: Object.freeze({
        ...baseConfig.notifications,
        automationNoiseTitles: ["依存更新ダッシュボード"],
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("automation dashboardのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

    expect(result.exitCode).toBe(0);
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        nodeId: item.nodeId,
        notificationClass: "automation_noise",
      }),
    );
    expect(harness.publicData[0]?.details.graph.nodes).toContainEqual(
      expect.objectContaining({
        nodeId: item.nodeId,
      }),
    );
    expect(harness.discordCandidateNodeIds).toEqual([[]]);
  });

  it("tracked項目の本文とコメントから参照された開始日前項目を追跡する", async () => {
    const repository = createRepository("R_outbound_reference", "outbound-reference", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const bodyReferenced = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "body-referenced",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const commentReferenced = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "comment-referenced",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const commentNodeId = createGitHubNodeId("IC_outbound_reference");
    const referenceComment = Object.freeze({
      sourceId: buildSourceId("github_issue_comment", commentNodeId),
      nodeId: commentNodeId,
      sequence: 0,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", "U_outbound_reference"),
          nodeId: createGitHubNodeId("U_outbound_reference"),
          login: "outbound-reference-author",
          apiType: "User",
        }),
      }),
      body: `${commentReferenced.url} をコメントから参照します`,
      createdAt: observedAt,
      updatedAt: observedAt,
      url: tracked.url,
    } satisfies GitHubIssueComment);
    fixture.openItems = [tracked, bodyReferenced, commentReferenced];
    setIssueDetails(fixture, fixture.openItems, observedAt);
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: tracked,
          body: `${bodyReferenced.url} を本文から参照します`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([referenceComment]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          referencesTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const trackedNodeIds = requireDryRunSnapshot(harness.artifacts).items.map(
      (item) => item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedNodeIds).toHaveLength(3);
    expect(trackedNodeIds).toEqual(
      expect.arrayContaining([tracked.nodeId, bodyReferenced.nodeId, commentReferenced.nodeId]),
    );
  });

  it("tracked項目へのcross-reference元である開始日前項目を追跡する", async () => {
    const repository = createRepository("R_inbound_reference", "inbound-reference", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "cross-reference-source",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const sourceItem = Object.freeze({
      sourceId: buildSourceId("github_item", source.nodeId),
      nodeId: source.nodeId,
      repositoryId: source.repositoryId,
      repositoryOwner: publicRepository.owner,
      repositoryName: publicRepository.name,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: source.type,
      number: source.number,
      url: source.url,
      state: source.state,
    } satisfies GitHubReferencedItem);
    const eventNodeId = createGitHubNodeId("CRE_inbound_reference");
    const eventSourceId = buildSourceId("github_timeline_event", eventNodeId);
    const crossReferenceEvent = Object.freeze({
      sourceId: eventSourceId,
      nodeId: eventNodeId,
      sequence: 0,
      occurredAt: observedAt,
      actor: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      kind: "cross_referenced",
      source: sourceItem,
      willCloseTarget: false,
    } satisfies GitHubTimelineEvent);
    const inboundCrossReference = Object.freeze({
      sourceId: buildSourceId("github_inbound_cross_reference", `${eventNodeId}:${source.nodeId}`),
      candidateOnly: true,
      provenance: "cross_reference",
      eventSourceId,
      sourceItem,
    } satisfies GitHubInboundCrossReferenceCandidate);
    fixture.openItems = [tracked, source];
    setIssueDetails(fixture, fixture.openItems, observedAt);
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: tracked,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        timeline: Object.freeze([crossReferenceEvent]),
        inboundCrossReferences: Object.freeze([inboundCrossReference]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          referencedByTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const trackedNodeIds = requireDryRunSnapshot(harness.artifacts).items.map(
      (item) => item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedNodeIds).toHaveLength(2);
    expect(trackedNodeIds).toEqual(expect.arrayContaining([tracked.nodeId, source.nodeId]));
  });

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

  it("未更新項目をrun時刻でwatchへ進めて通知候補にする", async () => {
    const repository = createRepository("R_elapsed_severity", "elapsed-severity", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "unchanged",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("初回のseverity snapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    expect(firstSnapshot.items[0]?.severity).toBe("none");

    fixture.openItems = [
      createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "unchanged",
        updatedAt: firstObservedAt,
        observedAt: createUtcIsoDateTime(THIRD_RUN_AT),
        state: Object.freeze({ state: "open" }),
      }),
    ];
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;

    const result = await harness.runDry(THIRD_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toHaveLength(0);
    expect(snapshot.items[0]).toMatchObject({
      nodeId: item.nodeId,
      observedAt: FIRST_RUN_AT,
      severity: "watch",
    });
    expect(harness.artifacts.at(-1)).toMatchObject({
      result: {
        notificationSelection: {
          candidates: [
            {
              itemNodeId: item.nodeId,
              reasonCode: "triage_overdue",
              severity: "watch",
            },
          ],
        },
      },
    });
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

describe("本番判定入力の接続", () => {
  it("reviewとcheckの集約状態をsnapshotと公開DTOへ保存する", async () => {
    const repository = createRepository("R_pr_aggregate", "pr-aggregate", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "aggregate-state",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        reviews: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_pull_request_review", "approved"),
            nodeId: createGitHubNodeId("V_approved"),
            sequence: 0,
            state: "approved",
            author: Object.freeze({
              status: "identified",
              account: Object.freeze({
                sourceId: buildSourceId("github_account", "U_reviewer"),
                nodeId: createGitHubNodeId("U_reviewer"),
                login: "reviewer",
                apiType: "User",
              }),
            }),
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "承認します",
            url: `${item.url}#pullrequestreview-1`,
          } satisfies (typeof detail.reviews)[number]),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotBytes = files.get("state/snapshot.json");
    if (snapshotBytes == null) {
      throw new TypeError("PR集約状態のsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotBytes));
    const snapshotItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);
    const publicItem = harness.publicData[0]?.details.items.find(
      (candidate) => candidate.summary.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(snapshotItem).toMatchObject({
      reviewState: "approved",
      checkState: "failing",
    });
    expect(publicItem).toMatchObject({
      reviewState: "approved",
      checkState: "failing",
    });
  });

  it("mentionの明示依頼とhuman commentの意味判定を状態と進捗時刻へ反映する", async () => {
    const repository = createRepository("R_codex_issue", "codex-issue", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "mention-progress",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const meaningfulAt = createUtcIsoDateTime("2026-07-31T20:00:00.000Z");
    const commentFixture = createDuplicateComments(item, meaningfulAt)[0];
    if (commentFixture == null) {
      throw new TypeError("進捗判定用commentがありません");
    }
    const meaningfulComment = Object.freeze({
      ...commentFixture,
      body: "依頼された調査へ回答し、結論を共有しました",
    });
    const chatCommentNodeId = createGitHubNodeId(`IC_chat_${item.nodeId}`);
    const chatComment = Object.freeze({
      ...commentFixture,
      sourceId: buildSourceId("github_issue_comment", chatCommentNodeId),
      nodeId: chatCommentNodeId,
      sequence: 1,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", "U_chat_commenter"),
          nodeId: createGitHubNodeId("U_chat_commenter"),
          login: "chat-commenter",
          apiType: "User",
        }),
      }),
      body: "ありがとうございます。今日は暑いですね",
      createdAt: observedAt,
      updatedAt: observedAt,
      url: `${item.url}#issuecomment-${chatCommentNodeId}`,
    } satisfies GitHubIssueComment);
    const comments = Object.freeze([meaningfulComment, chatComment]);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "@requested-user と @VOICEVOX/reviewers に対応をお願いします",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const bodySource = input.sources.find((source) => source.kind === "body");
        if (bodySource == null) {
          throw new TypeError("Codex入力にbody sourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: "requested-user",
              kind: "user",
              role: "assignee",
              sourceId: bodySource.id,
            },
            latestMeaningfulSourceId: meaningfulComment.sourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("判定追跡情報のsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));
    const input = harness.codexInputs[0];
    const trackedItem = snapshot.items[0];
    if (trackedItem?.aiAnalysis.status !== "used") {
      throw new TypeError("判定からAI cache entryを参照できません");
    }
    const cachePath = `state/ai-cache/${trackedItem.aiAnalysis.cacheKey.slice("sha256:".length)}.json`;
    const cacheSource = files.get(cachePath);
    if (cacheSource == null) {
      throw new TypeError("判定が参照するAI cache entryがありません");
    }
    const parseJson: (source: string) => unknown = JSON.parse;
    const cacheEntry = createAiCacheEntry(parseJson(new TextDecoder().decode(cacheSource)));
    const publicItem = harness.publicData[0]?.details.items.find(
      (candidate) => candidate.summary.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(input?.candidates.waitingOn.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["requested-user", "VOICEVOX/reviewers"]),
    );
    const mentionedWaitingOnCandidates = z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(["user", "team"]),
        }),
      )
      .parse(input?.deterministicSignals["mentionedWaitingOnCandidates"]);
    expect(
      mentionedWaitingOnCandidates
        .map((candidate) => ({ id: candidate.id, kind: candidate.kind }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      [
        { id: "requested-user", kind: "user" },
        { id: "VOICEVOX/reviewers", kind: "team" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(trackedItem).toMatchObject({
      status: "waiting_for_assignee",
      lastHumanActivityAt: FIRST_RUN_AT,
      lastProgressAt: meaningfulAt,
      author: {
        status: "identified",
        actor: {
          login: "author-1",
        },
      },
      latestEventActor: {
        status: "present",
        actor: {
          login: "chat-commenter",
        },
      },
      waitingOn: [
        expect.objectContaining({
          candidateId: "requested-user",
          kind: "user",
        }),
      ],
    });
    expect(cacheEntry.cacheKey).toBe(trackedItem.aiAnalysis.cacheKey);
    expect(cacheEntry.metadata).toEqual({
      deterministicRulesVersion: "daily-rules-v1",
      model: config.ai.model,
      reasoningEffort: config.ai.execution.reasoningEffort,
      backendVersion: "codex-cli-0.145.0",
      promptVersion: config.ai.promptVersion,
      schemaVersion: "1",
      inputHash: cacheEntry.metadata.inputHash,
      outputHash: cacheEntry.metadata.outputHash,
      executedAt: FIRST_RUN_AT,
    });
    expect(cacheEntry.metadata.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(cacheEntry.metadata.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(trackedItem.inputEvents).toEqual(
      expect.arrayContaining([
        {
          sourceId: meaningfulComment.sourceId,
          url: meaningfulComment.url,
        },
        {
          sourceId: chatComment.sourceId,
          url: chatComment.url,
        },
      ]),
    );
    expect(publicItem).toMatchObject({
      author: trackedItem.author,
      latestEventActor: trackedItem.latestEventActor,
      aiAnalysis: trackedItem.aiAnalysis,
      inputEvents: trackedItem.inputEvents,
    });
  });

  it("reducerの検証済み通知提案を通知選別へ渡す", async () => {
    const repository = createRepository("R_codex_notification", "codex-notification", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const recommendedItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "notification-recommended",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const notRecommendedItem = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "notification-not-recommended",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const items = [recommendedItem, notRecommendedItem];
    fixture.openItems = items;
    for (const item of items) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "@requested-user に対応をお願いします",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
    }
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources.find((candidate) => candidate.kind === "body");
        if (source == null) {
          throw new TypeError("通知提案fixtureのbody sourceがありません");
        }
        const recommended = input.item.nodeId === recommendedItem.nodeId;
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: "requested-user",
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "related",
            notification: recommended
              ? {
                  recommended: true,
                  reasonCode: "review_overdue",
                  reasonSummary: "レビュー状況の確認が必要です",
                }
              : {
                  recommended: false,
                  reasonCode: "none",
                  reasonSummary: "通知は不要です",
                },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toHaveLength(2);
    expect(harness.artifacts.at(-1)).toMatchObject({
      result: {
        notificationSelection: {
          candidates: [
            {
              itemNodeId: recommendedItem.nodeId,
              reasonCode: "review_overdue",
            },
          ],
        },
      },
    });
  });

  it("required check失敗をCodexへ渡しコード起因だけをauthor待ちにする", async () => {
    const repository = createRepository("R_codex_pr", "codex-pr", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const codeFailure = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "code-failure",
      updatedAt: observedAt,
      observedAt,
    });
    const infrastructureFailure = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "infrastructure-failure",
      updatedAt: observedAt,
      observedAt,
    });
    fixture.openItems = [codeFailure, infrastructureFailure];
    fixture.details.set(
      codeFailure.nodeId,
      createFailedCheckPullRequestDetail(codeFailure, observedAt),
    );
    fixture.details.set(
      infrastructureFailure.nodeId,
      createFailedCheckPullRequestDetail(infrastructureFailure, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const checkSource = input.sources.find((source) => source.kind === "check_run");
        if (checkSource == null) {
          throw new TypeError("Codex入力にrequired check sourceがありません");
        }
        const codeCaused = input.item.nodeId === codeFailure.nodeId;
        return Promise.resolve(
          createCodexOutput(input, {
            status: codeCaused ? "waiting_for_author" : "unknown",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: codeCaused ? "author" : "unknown",
              sourceId: checkSource.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const codeItem = snapshot.items.find((candidate) => candidate.nodeId === codeFailure.nodeId);
    const infrastructureItem = snapshot.items.find(
      (candidate) => candidate.nodeId === infrastructureFailure.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toHaveLength(2);
    for (const input of harness.codexInputs) {
      expect(input.deterministicSignals["requiredCheckFailure"]).toMatchObject({
        status: "configured",
        combinedState: "failure",
      });
      expect(input.sources.map((source) => source.kind)).toEqual(
        expect.arrayContaining(["required_check_rollup", "check_run"]),
      );
    }
    expect(codeItem).toMatchObject({
      status: "waiting_for_author",
      waitingOn: [expect.objectContaining({ role: "author" })],
    });
    expect(infrastructureItem?.status).not.toBe("waiting_for_author");
  });

  it("primary blockerと全blockerと外部ghostをstateと公開DTOへ運ぶ", async () => {
    const repository = createRepository("R_blockers", "blockers", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const items = [1, 2, 3].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `blocker-${number.toString()}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    const blocked = items[0];
    const firstBlocker = items[1];
    const secondBlocker = items[2];
    if (blocked == null || firstBlocker == null || secondBlocker == null) {
      throw new TypeError("複数blocker fixtureがありません");
    }
    fixture.openItems = [...items];
    setIssueDetails(fixture, items, observedAt);
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: "複数の依存項目があります",
        observedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(blocked, firstBlocker),
          createNativeBlocker(blocked, secondBlocker),
          createExternalNativeBlocker(blocked, {
            state: "open",
            repositoryArchived: false,
            repositoryDisabled: false,
          }),
        ]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("複数blockerのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const publicItem = harness.publicData[0]?.summary.items.find(
      (item) => item.nodeId === blocked.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedItem?.waitingOn).toHaveLength(3);
    expect(trackedItem?.primaryWaitingOn.index).toBe(0);
    expect(trackedItem?.primaryWaitingOn.selectionReason).not.toBe("");
    expect(snapshot.externalReferences).toEqual([
      expect.objectContaining({
        kind: "external_reference",
        repositoryFullName: "external-owner/external-repository",
        directNotification: "not_eligible",
      }),
    ]);
    expect(publicItem?.primaryWaitingOn).toEqual(trackedItem?.primaryWaitingOn);
    expect(new Set(publicItem?.blockerNodeIds)).toEqual(
      new Set([firstBlocker.nodeId, secondBlocker.nodeId, "external:github:I_external_blocker"]),
    );
    expect(harness.publicData[0]?.details.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "external_reference",
        displayReference: "external-owner/external-repository#42",
      }),
    );
  });

  it.each([
    {
      description: "archive済み",
      fixtureName: "archived",
      repositoryArchived: true,
      repositoryDisabled: false,
    },
    {
      description: "disabled",
      fixtureName: "disabled",
      repositoryArchived: false,
      repositoryDisabled: true,
    },
  ])(
    "Organization外の$description repositoryをstateと公開DTOへ残さない",
    async ({ fixtureName, repositoryArchived, repositoryDisabled }) => {
      const repository = createRepository(
        `R_excluded_external_${fixtureName}`,
        `excluded-external-${fixtureName}`,
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const blocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: `excluded-external-${fixtureName}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [blocked];
      fixture.details.set(
        blocked.nodeId,
        createIssueDetail({
          item: blocked,
          body: "除外対象の外部依存があります",
          observedAt,
          nativeDependencies: Object.freeze([
            createExternalNativeBlocker(blocked, {
              state: "open",
              repositoryArchived,
              repositoryDisabled,
            }),
          ]),
          duplicateComments: false,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });

      const result = await harness.runDaily(FIRST_RUN_AT);
      const files = await harness.stateAdapter.readBranchFiles("tracker-state");
      const snapshotSource = files.get("state/snapshot.json");
      if (snapshotSource == null) {
        throw new TypeError("外部repository除外後のsnapshotがありません");
      }
      const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

      expect(result.exitCode).toBe(0);
      expect(snapshot.externalReferences).toEqual([]);
      expect(snapshot.relations).toEqual([]);
      expect(harness.publicData[0]?.details.graph.nodes).not.toContainEqual(
        expect.objectContaining({
          nodeId: "external:github:I_external_blocker",
        }),
      );
      expect(harness.publicData[0]?.details.graph.edges).toEqual([]);
    },
  );

  it("inferred edge解消時に本文未変更の隣接項目を再分類する", async () => {
    const repository = createRepository("R_reclassify", "reclassify", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "blocked-unchanged",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "blocker-open",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [blocked, blocker];
    setIssueDetails(fixture, [blocked, blocker], observedAt);
    const unchangedBody = `本文は変更しません。依存候補は ${blocker.url} です`;
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: unchangedBody,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    let relationExists = true;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("隣接再分類fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict:
              input.item.nodeId === blocked.nodeId && relationExists
                ? "current_is_blocked_by_target"
                : "none",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("inferred edge作成後のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    const firstAiFingerprint = requireCollectionItem(
      firstSnapshot,
      blocked.nodeId,
    ).aiAnalysisFingerprint;
    if (firstAiFingerprint.status !== "available") {
      throw new TypeError("初回Codex分析fingerprintが保存されていません");
    }
    expect(firstSnapshot.items.find((item) => item.nodeId === blocked.nodeId)?.status).toBe(
      "blocked",
    );
    expect(firstSnapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: blocker.nodeId,
        toNodeId: blocked.nodeId,
        provenance: "explicit_text",
        active: true,
      }),
    );

    const firstCodexExecutionCount = harness.codexExecutionCount();
    harness.artifacts.length = 0;
    const unchangedResult = await harness.runDry(SECOND_RUN_AT);
    const unchangedSnapshot = requireDryRunSnapshot(harness.artifacts);
    const secondAiFingerprint = requireCollectionItem(
      unchangedSnapshot,
      blocked.nodeId,
    ).aiAnalysisFingerprint;
    const unchangedMetrics = z
      .object({
        metrics: z.object({
          aiCallCount: z.number(),
          aiCacheHitCount: z.number(),
        }),
      })
      .parse(harness.artifacts.at(-1)).metrics;

    expect(unchangedResult.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(unchangedMetrics.aiCallCount).toBe(0);
    expect(unchangedMetrics.aiCacheHitCount).toBeGreaterThan(0);
    expect(unchangedSnapshot.items.find((item) => item.nodeId === blocked.nodeId)?.status).toBe(
      "blocked",
    );
    expect(unchangedSnapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: blocker.nodeId,
        toNodeId: blocked.nodeId,
        active: true,
      }),
    );
    const blockedInputsBeforeChange = harness.codexInputs.filter(
      (input) => input.item.nodeId === blocked.nodeId,
    );
    expect(blockedInputsBeforeChange).toHaveLength(1);
    expect(secondAiFingerprint).toEqual(firstAiFingerprint);

    relationExists = false;
    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const changedBlocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "blocked-changed",
      updatedAt: thirdObservedAt,
      observedAt: thirdObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [changedBlocked, blocker];
    fixture.details.set(
      changedBlocked.nodeId,
      createIssueDetail({
        item: changedBlocked,
        body: unchangedBody,
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: true,
      }),
    );

    expect((await harness.runDaily(THIRD_RUN_AT)).exitCode).toBe(0);
    const thirdFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const thirdSnapshotSource = thirdFiles.get("state/snapshot.json");
    if (thirdSnapshotSource == null) {
      throw new TypeError("入力変更後のsnapshotがありません");
    }
    const thirdSnapshot = parseStateSnapshot(new TextDecoder().decode(thirdSnapshotSource));
    const thirdAiFingerprint = requireCollectionItem(
      thirdSnapshot,
      blocked.nodeId,
    ).aiAnalysisFingerprint;
    if (thirdAiFingerprint.status !== "available") {
      throw new TypeError("入力変更後のCodex分析fingerprintが保存されていません");
    }
    const reclassified = thirdSnapshot.items.find((item) => item.nodeId === blocked.nodeId);

    const blockedInputs = harness.codexInputs.filter(
      (input) => input.item.nodeId === blocked.nodeId,
    );
    expect(reclassified?.status).not.toBe("blocked");
    expect(reclassified?.lastProgressAt).toBe(THIRD_RUN_AT);
    expect(thirdSnapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: blocker.nodeId,
        toNodeId: blocked.nodeId,
        active: false,
      }),
    );
    expect(blockedInputs).toHaveLength(2);
    expect(thirdAiFingerprint.fingerprint.inputHash).not.toBe(
      firstAiFingerprint.fingerprint.inputHash,
    );
    expect(
      blockedInputs.map(
        (input) => input.sources.find((source) => source.kind === "body")?.["content"],
      ),
    ).toEqual([unchangedBody, unchangedBody]);
  });

  it("実入力の費用見積で上限を適用する", async () => {
    const repository = createRepository("R_cost", "cost", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "cost-limit",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "費用見積を行う項目です",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: true,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 10, 0);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: () => Promise.reject(new TypeError("費用上限を超えて実行されました")),
    });

    const result = await harness.runDry(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(0);
    expect(harness.artifacts.at(-1)).toMatchObject({
      diagnostics: [expect.stringContaining("estimated_cost_limit")],
      metrics: {
        aiCallCount: 0,
      },
    });
  });

  it("blocker変化をdownstream impactより優先し、同条件ではimpact順に予算配分する", async () => {
    const repository = createRepository("R_priority", "priority", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const items = [1, 2, 3, 4, 5].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `priority-${number.toString()}`,
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    const highImpact = items[0];
    const changedBlockerTarget = items[1];
    const downstream = items[2];
    const downstreamLeaf = items[3];
    const newBlocker = items[4];
    if (
      highImpact == null ||
      changedBlockerTarget == null ||
      downstream == null ||
      downstreamLeaf == null ||
      newBlocker == null
    ) {
      throw new TypeError("AI優先順位fixtureがありません");
    }
    fixture.openItems = [...items];
    setIssueDetails(fixture, items, firstObservedAt);
    for (const item of [highImpact, changedBlockerTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします",
          observedAt: firstObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: true,
        }),
      );
    }
    fixture.details.set(
      downstream.nodeId,
      createIssueDetail({
        item: downstream,
        body: "downstream項目です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(downstream, highImpact)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      downstreamLeaf.nodeId,
      createIssueDetail({
        item: downstreamLeaf,
        body: "downstream末端です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(downstreamLeaf, downstream)]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const executedNodeIds: string[] = [];
    const harness = createCollectionHarness({
      repositories: [fixture],
      config: configWithBudget(baseConfig, 10, 10),
      executeCodexAnalysis: (input) => {
        executedNodeIds.push(input.item.nodeId);
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("AI優先順位fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

    executedNodeIds.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItems = items.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint:
          item.number <= 2
            ? `priority-${item.number.toString()}-second`
            : `priority-${item.number.toString()}`,
        updatedAt: item.number <= 2 ? secondObservedAt : firstObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...secondItems];
    setIssueDetails(fixture, secondItems, secondObservedAt);
    const secondByNumber = new Map(secondItems.map((item) => [item.number, item]));
    const secondHighImpact = secondByNumber.get(1);
    const secondChangedTarget = secondByNumber.get(2);
    const secondDownstream = secondByNumber.get(3);
    const secondLeaf = secondByNumber.get(4);
    if (
      secondHighImpact == null ||
      secondChangedTarget == null ||
      secondDownstream == null ||
      secondLeaf == null
    ) {
      throw new TypeError("2回目のAI優先順位fixtureがありません");
    }
    for (const item of [secondHighImpact, secondChangedTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします。入力を更新しました",
          observedAt: secondObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: true,
        }),
      );
    }
    fixture.details.set(
      secondDownstream.nodeId,
      createIssueDetail({
        item: secondDownstream,
        body: "downstream項目です",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(secondDownstream, secondHighImpact),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      secondLeaf.nodeId,
      createIssueDetail({
        item: secondLeaf,
        body: "downstream末端です",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondLeaf, secondDownstream)]),
        duplicateComments: false,
      }),
    );
    harness.setConfig(configWithBudget(baseConfig, 1, 10));
    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    expect(executedNodeIds).toEqual([highImpact.nodeId]);

    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const thirdItems = items.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint:
          item.number === 2 ? "priority-2-blocker-change" : `priority-${item.number.toString()}`,
        updatedAt: item.number === 2 ? thirdObservedAt : firstObservedAt,
        observedAt: thirdObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...thirdItems];
    setIssueDetails(fixture, thirdItems, thirdObservedAt);
    const currentByNumber = new Map(thirdItems.map((item) => [item.number, item]));
    const currentHighImpact = currentByNumber.get(1);
    const currentChangedTarget = currentByNumber.get(2);
    const currentDownstream = currentByNumber.get(3);
    const currentLeaf = currentByNumber.get(4);
    const currentNewBlocker = currentByNumber.get(5);
    if (
      currentHighImpact == null ||
      currentChangedTarget == null ||
      currentDownstream == null ||
      currentLeaf == null ||
      currentNewBlocker == null
    ) {
      throw new TypeError("更新後のAI優先順位fixtureがありません");
    }
    for (const item of [currentHighImpact, currentChangedTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします",
          observedAt: thirdObservedAt,
          nativeDependencies:
            item.nodeId === currentChangedTarget.nodeId
              ? Object.freeze([
                  createExternalNativeBlocker(currentChangedTarget, {
                    state: "closed",
                    repositoryArchived: false,
                    repositoryDisabled: false,
                  }),
                ])
              : Object.freeze([]),
          duplicateComments: true,
        }),
      );
    }
    fixture.details.set(
      currentDownstream.nodeId,
      createIssueDetail({
        item: currentDownstream,
        body: "downstream項目です",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(currentDownstream, currentHighImpact),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      currentLeaf.nodeId,
      createIssueDetail({
        item: currentLeaf,
        body: "downstream末端です",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(currentLeaf, currentDownstream)]),
        duplicateComments: false,
      }),
    );
    executedNodeIds.length = 0;

    expect((await harness.runDaily(FOURTH_RUN_AT)).exitCode).toBe(0);
    expect(executedNodeIds).toEqual([changedBlockerTarget.nodeId]);
  });
});

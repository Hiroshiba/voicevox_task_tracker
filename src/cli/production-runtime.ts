import { resolve } from "node:path";

import {
  createCodexAnalysisInput,
  reduceCodexAnalysis,
  runAiAnalyses,
  type executeCodexAnalysis,
  type AiAnalysisCandidate,
  type AiAnalysisRunResult,
  type CodexAnalysisInput,
  type CodexAnalysisReduction,
  type CodexProcessRunner,
  type DeterministicCodexDecision,
  type ReducedCodexDecision,
} from "../codex/index.js";
import { type Config, type loadConfig } from "../config/index.js";
import {
  createUtcIsoDateTime,
  createGitHubNodeId,
  createGitHubBotPredicate,
  createLabelEffectsResolver,
  calculateStaleness,
  determineIssueState,
  determineMeaningfulProgress,
  determinePullRequestState,
  determineTerminalRetention,
  determineTrackedItemWork,
  isTerminalStatus,
  resolveRepositoryTeams,
  selectTrackingItems,
  type LabelRule,
  type NotificationLedgerEntry,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type IssueBlocker,
  type IssueStateDecision,
  type BlockedParentContext,
  type BlockerRanking,
  type OrganizationTrackingCandidate,
  type PullRequestStateDecision,
  type Relation,
  type Repository,
  type SourceId,
  type Severity,
  type StalenessResult,
  type TrackedItem,
  type TrackingConnection,
  type TrackedItemWorkDecision,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  selectDiscordNotifications,
  type sendDiscordDigest,
  type DiscordDigestDelivery,
  type DiscordDeliverySettings,
  type DiscordNotificationItem,
  type DiscordNotificationSelection,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
import { analyzeGoldenFixture, goldenEvalInputSchema } from "../eval/index.js";
import {
  type collectGitHubItemDetails,
  type collectGitHubTeamDirectory,
  collectRepositoriesWithStaleFallback,
  createPublicRepositoryAllowlist,
  deduplicateByStableId,
  type discoverRepositoryInventory,
  type enumerateGitHubItemsByIdentifiers,
  type enumerateOpenGitHubItems,
  markObservedGitHubItemsStale,
  normalizeObservedGitHubItems,
  planIncrementalItemCollection,
  parseGitHubAppCredentials,
  type CreateGitHubClientOptions,
  type EnumeratedGitHubItem,
  type FreshObservedGitHubItem,
  type GitHubAppCredentials,
  type GitHubClient,
  type GitHubItemDetail,
  type GitHubItemDetailEventWindow,
  type PublicRepository,
  type PublicRepositoryAllowlist,
  type PreviousItemCollection,
  type RepositoryCollectionResult,
  type StaleObservedGitHubItem,
} from "../github/index.js";
import {
  analyzeGraph,
  extractRelationCandidates,
  reconcileGraph,
  type AnalyzeGraphResult,
  type CandidateRelation,
  type PublicGitHubRelationItem,
  type ReconciledGraphEdge,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type ReconcileGraphResult,
  type RelationCandidate,
  type RelationCandidateAssessment,
  type RelationCandidateNode,
  type RelationCandidateId,
} from "../graph/index.js";
import {
  generatePublicData,
  PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  type GeneratedPublicData,
  type PublicDataWriteResult,
} from "../pages/index.js";
import {
  createStateNotificationLedger,
  createStateRunReport,
  createStateSnapshot,
  type StatePersistenceSession,
  type PersistStateTransactionResult,
  type SnapshotCollectionItem,
  type SnapshotCollectionRepository,
  type SnapshotRepository,
  type StateBranchAdapter,
  type StateNotificationLedger,
  type StateRunReport,
  type StateHistoryRecord,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import { CliApplication } from "./application.js";
import { createTrackingBackfillRequest } from "./backfill.js";
import {
  type BuildPagesCliCommand,
  type NotifyDiscordCliCommand,
  type PersistStateCliCommand,
} from "./command.js";
import { type OnlineCliCommand } from "./daily-transaction.js";
import {
  DailyTransactionRunner,
  type DailyTransactionDependencies,
  type DailyTransactionTypeMap,
  type DailyRunInvocation,
} from "./daily-transaction.js";
import { CliCredentialsError, CliExecutableError } from "./errors.js";
import {
  OfflineRunRunner,
  type readGoldenFixtureFiles,
  type readReplayFixtureFile,
  type readReplayStateFile,
  type OfflineAnalysisMetrics,
  type OfflineAnalysisResult,
  type ReplayFixture,
} from "./offline-runner.js";
import { writeRunReport, type RunMetrics } from "./run-report.js";
import {
  assertWorkflowArtifactPublicSafety,
  createWorkflowArtifact,
  type readWorkflowArtifactFile,
  workflowArtifactRepositoryInventory,
  type WorkflowArtifact,
} from "./workflow-artifact.js";
import { WorkflowStageRunner } from "./workflow-stage.js";

const CODEX_CLI_VERSION = "0.145.0";
const CODEX_BACKEND_VERSION = `codex-cli-${CODEX_CLI_VERSION}`;
const CODEX_SCHEMA_VERSION = "1";
const PAGES_BASE_URL = "https://voicevox.github.io";
const INCREMENTAL_COLLECTION_OVERLAP_MILLISECONDS = 5 * 60 * 1000;

type RuntimeCredentials = Readonly<{
  github: GitHubAppCredentials;
  openAiApiKey: string;
  knownSecrets: readonly string[];
}>;

type RuntimeConfiguration = Readonly<{
  config: Config;
  credentials: RuntimeCredentials;
}>;

type RuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  notificationLedger: StateNotificationLedger;
}>;

type RepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
  teams: Awaited<ReturnType<typeof collectGitHubTeamDirectory>>;
}>;

type CollectedItems = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  staleItems: readonly StaleObservedGitHubItem<SnapshotCollectionItem>[];
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  relationCandidates: readonly RelationCandidate[];
  repositoryResults: readonly RepositoryCollectionResult<SnapshotCollectionRepository>[];
  collectionRepositories: readonly SnapshotCollectionRepository[];
}>;

type FreshRepositoryRuntimeCollection = Readonly<{
  state: SnapshotCollectionRepository;
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  changedNodeIds: readonly GitHubNodeId[];
}>;

type RuntimeTrackingSelection = Readonly<{
  result: ReturnType<typeof selectTrackingItems>;
  workByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemWorkDecision>;
}>;

type DeterministicItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: IssueStateDecision | PullRequestStateDecision;
  relationCandidates: readonly RelationCandidate[];
}>;

type DeterministicAnalysis = Readonly<{
  items: readonly DeterministicItemAnalysis[];
  state: RuntimeState;
  inventory: RepositoryInventory;
}>;

type CodexAnalysis = Readonly<{
  run: AiAnalysisRunResult | undefined;
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
}>;

type ReducedItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: ReducedCodexDecision;
  staleness: StalenessResult;
}>;

type ReducedAnalysis = Readonly<{
  items: readonly TrackedItem[];
  currentItems: readonly ReducedItemAnalysis[];
  relationAssessments: readonly RelationCandidateAssessment[];
  runStatus: "success" | "fallback";
}>;

type GraphResult = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  analysis: AnalyzeGraphResult;
  previousAnalysis:
    | Readonly<{
        availability: "unavailable";
      }>
    | Readonly<{
        availability: "available";
        value: AnalyzeGraphResult;
      }>;
}>;

type ValidatedRun = Readonly<{
  snapshot: StateSnapshot;
  notificationLedger: StateNotificationLedger;
  notificationSelection: DiscordNotificationSelection;
}>;

type PersistedRun = Readonly<{
  result: PersistStateTransactionResult;
  historyRecords: readonly StateHistoryRecord[];
}>;

type PagesResult = Readonly<{
  data: GeneratedPublicData;
  output: PublicDataWriteResult;
  pagesUrl: string;
}>;

type DiscordResult = Readonly<{
  delivery: DiscordDigestDelivery;
}>;

export type ProductionTypes = DailyTransactionTypeMap &
  Readonly<{
    configuration: RuntimeConfiguration;
    state: RuntimeState;
    authentication: GitHubClient;
    repositoryInventory: RepositoryInventory;
    collection: CollectedItems;
    deterministicAnalysis: DeterministicAnalysis;
    codexAnalysis: CodexAnalysis;
    reduction: ReducedAnalysis;
    graph: GraphResult;
    validated: ValidatedRun;
    persisted: PersistedRun;
    pages: PagesResult;
    discord: DiscordResult;
  }>;

/** 日次実行配線へ注入する外部接続、時刻、永続化の境界。 */
export type ProductionRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: Config["state"],
  ) => Promise<StatePersistenceSession>;
  discoverRepositoryInventory: typeof discoverRepositoryInventory;
  collectGitHubTeamDirectory: typeof collectGitHubTeamDirectory;
  enumerateGitHubItemsByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  enumerateOpenGitHubItems: typeof enumerateOpenGitHubItems;
  collectGitHubItemDetails: typeof collectGitHubItemDetails;
  executeCodexAnalysis: typeof executeCodexAnalysis;
  readReplayFixture: typeof readReplayFixtureFile;
  readReplayState: typeof readReplayStateFile;
  readGoldenFixtures: typeof readGoldenFixtureFiles;
  readWorkflowArtifact: typeof readWorkflowArtifactFile;
  createGitHubClient: (options: CreateGitHubClientOptions) => Promise<GitHubClient>;
  createStateBranchAdapter: () => StateBranchAdapter;
  codexProcessRunner: CodexProcessRunner;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  writeStandardOutput: (source: string) => Promise<void>;
  writeJsonArtifact: (path: string, value: unknown) => Promise<void>;
  writeTextFile: (path: string, source: string) => Promise<void>;
  writePublicData: (
    outputDirectory: string,
    data: GeneratedPublicData,
  ) => Promise<PublicDataWriteResult>;
  sendDiscord: typeof sendDiscordDigest;
}>;

function requireEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableName: string,
): string {
  const value = environment[variableName];
  if (value == null || value.trim().length === 0) {
    throw new CliCredentialsError([variableName], {});
  }
  return value;
}

function requireEnvironmentVariables(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableNames: readonly string[],
): void {
  const missingVariableNames = variableNames.filter((variableName) => {
    const value = environment[variableName];
    return value == null || value.trim().length === 0;
  });
  if (missingVariableNames.length > 0) {
    throw new CliCredentialsError(missingVariableNames, {});
  }
}

function readRuntimeCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
  config: Config,
  command: OnlineCliCommand,
): RuntimeCredentials {
  requireEnvironmentVariables(environment, ["GH_APP_ID", "GH_APP_PRIVATE_KEY"]);
  let github: GitHubAppCredentials;
  try {
    github = parseGitHubAppCredentials(environment);
  } catch (error: unknown) {
    const variableNames =
      error instanceof Error &&
      "variableNames" in error &&
      Array.isArray(error.variableNames) &&
      error.variableNames.every((value) => typeof value === "string")
        ? error.variableNames
        : ["GH_APP_ID", "GH_APP_PRIVATE_KEY"];
    throw new CliCredentialsError(variableNames, { cause: error });
  }
  const openAiApiKey = config.ai.enabled
    ? requireEnvironmentValue(environment, "OPENAI_API_KEY")
    : "";
  const knownSecrets = [github.privateKey];
  if (openAiApiKey.length > 0) {
    knownSecrets.push(openAiApiKey);
  }
  if (
    command.kind !== "dry-run" &&
    command.kind !== "collect-analyze" &&
    config.notifications.discord.enabled
  ) {
    knownSecrets.push(
      requireEnvironmentValue(environment, config.notifications.discord.webhookSecretName),
    );
  }
  return Object.freeze({
    github,
    openAiApiKey,
    knownSecrets: Object.freeze(knownSecrets),
  });
}

function normalizeLabelRules(config: Config): readonly LabelRule[] {
  return Object.freeze(
    config.labels.rules.map((rule) => {
      const effects: {
        priorityWeight?: number;
        severityLift?: number;
        requiresMaintainerDecision?: boolean;
        suppressNotifications?: boolean;
        countsAsProgress?: boolean;
      } = {};
      if (rule.effects.priorityWeight != null) {
        effects.priorityWeight = rule.effects.priorityWeight;
      }
      if (rule.effects.severityLift != null) {
        effects.severityLift = rule.effects.severityLift;
      }
      if (rule.effects.requiresMaintainerDecision != null) {
        effects.requiresMaintainerDecision = rule.effects.requiresMaintainerDecision;
      }
      if (rule.effects.suppressNotifications != null) {
        effects.suppressNotifications = rule.effects.suppressNotifications;
      }
      if (rule.effects.countsAsProgress != null) {
        effects.countsAsProgress = rule.effects.countsAsProgress;
      }
      return Object.freeze({
        repository: rule.repository,
        namePattern: rule.namePattern,
        effects: Object.freeze(effects),
      });
    }),
  );
}

function isolatedCodexEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  openAiApiKey: string,
): NodeJS.ProcessEnv {
  return {
    HOME: requireEnvironmentValue(environment, "HOME"),
    OPENAI_API_KEY: openAiApiKey,
    PATH: requireEnvironmentValue(environment, "PATH"),
  };
}

async function assertCodexCliAvailable(
  adapters: ProductionRuntimeAdapters,
  openAiApiKey: string,
): Promise<void> {
  let result: Awaited<ReturnType<CodexProcessRunner>>;
  try {
    result = await adapters.codexProcessRunner({
      command: "codex",
      arguments: ["--version"],
      workingDirectory: adapters.repositoryPath,
      environment: {
        HOME: requireEnvironmentValue(adapters.environment, "HOME"),
        OPENAI_API_KEY: openAiApiKey,
        PATH: requireEnvironmentValue(adapters.environment, "PATH"),
      },
      standardInput: "",
      timeoutMilliseconds: 10_000,
    });
  } catch (error: unknown) {
    throw new CliExecutableError("codex", { cause: error });
  }
  if (result.timedOut || result.exitCode !== 0 || result.signal != null) {
    throw new CliExecutableError("codex", {
      cause: new Error("Codex CLIのversion確認が正常終了しませんでした"),
    });
  }
}

function githubApiRemaining(client: GitHubClient): number {
  return client.getRateLimitSnapshot()?.remaining ?? 0;
}

function previousSnapshot(state: RuntimeState): StateSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot.snapshot : undefined;
}

function normalizeTrackingIdentifier(identifier: string): string {
  if (identifier.includes("://") && identifier.endsWith("/")) {
    return identifier.slice(0, -1);
  }
  return identifier;
}

function previousCollectionRepository(
  state: RuntimeState,
  repositoryId: GitHubRepositoryId,
): SnapshotCollectionRepository | undefined {
  return previousSnapshot(state)?.collection.repositories.find(
    (repository) => repository.repositoryId === repositoryId,
  );
}

function previousCollectionItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotCollectionItem> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item] as const),
    ),
  );
}

function createSnapshotCollectionItem(item: EnumeratedGitHubItem): SnapshotCollectionItem {
  if (item.state === "open") {
    return Object.freeze({
      freshness: "fresh",
      nodeId: item.nodeId,
      repositoryId: item.repositoryId,
      itemFingerprint: item.itemFingerprint,
      observedAt: item.observedAt,
      state: "open",
      terminalAt: null,
    });
  }
  return Object.freeze({
    freshness: "fresh",
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    itemFingerprint: item.itemFingerprint,
    observedAt: item.observedAt,
    state: "closed",
    terminalAt: item.closedAt,
  });
}

function createSnapshotCollectionRepository(
  repository: PublicRepository,
  successfulAt: UtcIsoDateTime,
  items: readonly EnumeratedGitHubItem[],
): SnapshotCollectionRepository {
  return Object.freeze({
    repositoryId: repository.id,
    successfulAt,
    items: Object.freeze(items.map(createSnapshotCollectionItem)),
  });
}

function previousItemCollection(
  state: RuntimeState,
  repository: PublicRepository,
): PreviousItemCollection {
  const previous = previousCollectionRepository(state, repository.id);
  if (previous == null) {
    return Object.freeze({
      status: "none",
    });
  }
  return Object.freeze({
    status: "successful",
    completedAt: previous.successfulAt,
    itemFingerprints: new Map(previous.items.map((item) => [item.nodeId, item.itemFingerprint])),
  });
}

function previousGraphAdjacentNodeIds(state: RuntimeState): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  for (const relation of previousSnapshot(state)?.relations ?? []) {
    if (!relation.active) {
      continue;
    }
    nodeIds.add(createGitHubNodeId(relation.fromNodeId));
    nodeIds.add(createGitHubNodeId(relation.toNodeId));
  }
  return nodeIds;
}

function detailEventWindow(
  plan: ReturnType<typeof planIncrementalItemCollection>,
): GitHubItemDetailEventWindow {
  if (plan.mode === "initial") {
    return Object.freeze({
      mode: "initial",
    });
  }
  return Object.freeze({
    mode: "incremental",
    since: plan.since,
  });
}

function explicitIdentifierMatchesItem(
  explicitIncludes: readonly string[],
  item: Readonly<{ nodeId: GitHubNodeId; url: string }>,
): boolean {
  return explicitIncludes
    .map(normalizeTrackingIdentifier)
    .some((identifier) => identifier === item.nodeId || identifier === item.url);
}

function shouldObservePreviousTrackedItem(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  item: TrackedItem,
  collectionItem: SnapshotCollectionItem,
): boolean {
  if (explicitIdentifierMatchesItem(configuration.config.tracking.include, item)) {
    return true;
  }
  const retention = determineTerminalRetention({
    item:
      collectionItem.state === "open"
        ? Object.freeze({ state: "open" })
        : Object.freeze({
            state: "closed",
            terminalAt: collectionItem.terminalAt,
          }),
    evaluatedAt: invocation.startedAt,
    retentionDays: configuration.config.tracking.retentionDaysAfterTerminal,
  });
  return retention.dataset === "active";
}

function previousTrackedItemIdentifiers(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  repository: PublicRepository,
): readonly string[] {
  const collectionItemsByNodeId = previousCollectionItemsByNodeId(state);
  const identifiers: string[] = [];
  for (const item of previousSnapshot(state)?.items ?? []) {
    if (item.repositoryId !== repository.id) {
      continue;
    }
    const collectionItem = collectionItemsByNodeId.get(item.nodeId);
    assertNonNullable(collectionItem, `既存追跡項目の収集stateがありません。対象: ${item.nodeId}`);
    if (shouldObservePreviousTrackedItem(invocation, configuration, item, collectionItem)) {
      identifiers.push(item.nodeId);
    }
  }
  return Object.freeze(identifiers);
}

function configuredUrlIdentifiersForRepository(
  config: Config,
  repository: PublicRepository,
): readonly string[] {
  const expectedPrefix = `https://github.com/${repository.owner}/${repository.name}/`.toLowerCase();
  return Object.freeze(
    config.tracking.include
      .map(normalizeTrackingIdentifier)
      .filter(
        (identifier) =>
          identifier.includes("://") && identifier.toLowerCase().startsWith(expectedPrefix),
      ),
  );
}

function missingIdentifiers(
  identifiers: readonly string[],
  currentItems: readonly EnumeratedGitHubItem[],
): readonly string[] {
  return Object.freeze(
    [...new Set(identifiers.map(normalizeTrackingIdentifier))].filter(
      (identifier) =>
        !currentItems.some((item) => item.nodeId === identifier || item.url === identifier),
    ),
  );
}

function repositoryFullName(repository: PublicRepository): string {
  return `${repository.owner}/${repository.name}`;
}

function findRepository(
  inventory: RepositoryInventory,
  repositoryId: FreshObservedGitHubItem["repositoryId"],
): PublicRepository {
  return inventory.allowlist.require(repositoryId);
}

function findDetail(collection: CollectedItems, nodeId: GitHubNodeId): GitHubItemDetail {
  const detail = collection.details.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(detail, `GitHub詳細取得結果がありません。対象: ${nodeId}`);
  return detail;
}

function createPublicRelationItem(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
): PublicGitHubRelationItem {
  return Object.freeze({
    nodeId: item.nodeId,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: item.type,
    number: item.number,
    url: item.url,
    state: item.state,
  });
}

function extractAllRelationCandidates(
  config: Config,
  allowlist: PublicRepositoryAllowlist,
  items: readonly EnumeratedGitHubItem[],
  details: readonly GitHubItemDetail[],
): readonly RelationCandidate[] {
  const knownItems = items.map((item) =>
    createPublicRelationItem(item, allowlist.require(item.repositoryId)),
  );
  const itemByNodeId = new Map(knownItems.map((item) => [item.nodeId, item]));
  const candidates: RelationCandidate[] = [];
  for (const detail of details) {
    const item = itemByNodeId.get(detail.nodeId);
    assertNonNullable(item, `関係候補抽出対象がありません。対象: ${detail.nodeId}`);
    candidates.push(
      ...extractRelationCandidates({
        organization: config.organization,
        item: {
          ...item,
          body: {
            sourceId: detail.bodySourceId,
            markdown: detail.body,
          },
          comments: detail.comments.map((comment) => ({
            sourceId: comment.sourceId,
            markdown: comment.body,
          })),
          crossReferences: detail.inboundCrossReferences.map((reference) => ({
            sourceId: reference.eventSourceId,
            sourceItem: reference.sourceItem,
            willCloseTarget: false,
          })),
          nativeDependencies:
            detail.type === "issue" && detail.nativeDependencies.availability === "available"
              ? detail.nativeDependencies.relations
              : [],
          nativeHierarchy:
            detail.type === "issue" && detail.nativeHierarchy.availability === "available"
              ? detail.nativeHierarchy.relations
              : [],
        },
        knownItems,
      }),
    );
  }
  return Object.freeze(candidates);
}

function relationNodes(
  relation: CandidateRelation,
): readonly [RelationCandidateNode, RelationCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return Object.freeze([relation.blocker, relation.blocked]);
    case "parent_of":
      return Object.freeze([relation.parent, relation.subtask]);
    case "implements":
      return Object.freeze([relation.implementation, relation.target]);
    case "unclassified":
      return Object.freeze([relation.referencing, relation.referenced]);
  }
}

function createTrackingConnections(
  candidates: readonly RelationCandidate[],
): readonly TrackingConnection[] {
  const connections: TrackingConnection[] = [];
  for (const candidate of candidates) {
    if (candidate.authority !== "authoritative") {
      continue;
    }
    const sourceId = candidate.sourceIds[0];
    assertNonNullable(sourceId, `関係候補 ${candidate.id}のsource IDがありません`);
    if (candidate.relation.type === "blocks") {
      connections.push(
        Object.freeze({
          kind: "native_dependency",
          sourceId,
          blockerNodeId: candidate.relation.blocker.nodeId,
          blockedNodeId: candidate.relation.blocked.nodeId,
        }),
      );
    } else {
      connections.push(
        Object.freeze({
          kind: "native_sub_issue",
          sourceId,
          parentNodeId: candidate.relation.parent.nodeId,
          subIssueNodeId: candidate.relation.subtask.nodeId,
        }),
      );
    }
  }
  return Object.freeze(connections);
}

function trackingStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  invocation: DailyRunInvocation,
): UtcIsoDateTime {
  const configured = configuration.config.tracking.startAt;
  if (configured != null) {
    return createUtcIsoDateTime(configured);
  }
  return previousSnapshot(state)?.trackingStartAt ?? invocation.startedAt;
}

function authorType(item: FreshObservedGitHubItem): "human" | "bot" | "unknown" {
  if (item.author.status === "unavailable") {
    return "unknown";
  }
  return item.author.actor.type;
}

function enumeratedAuthorType(
  item: EnumeratedGitHubItem,
  isBot: ReturnType<typeof createGitHubBotPredicate>,
): "human" | "bot" | "unknown" {
  if (item.author.kind === "deleted_account") {
    return "unknown";
  }
  return item.author.account.apiType === "Bot" || isBot(item.author.account) ? "bot" : "human";
}

function collectTrackingCandidates(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  observedItems: readonly FreshObservedGitHubItem[],
  relationCandidates: readonly RelationCandidate[],
): RuntimeTrackingSelection {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const previousItems = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const observedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const currentNodeIds = new Set(enumeratedItems.map((item) => item.nodeId));
  const isBot = createGitHubBotPredicate(configuration.config.actors.bots);
  const candidates: OrganizationTrackingCandidate[] = enumeratedItems.map((item) => {
    const repository = findRepository(inventory, item.repositoryId);
    const previous = previousItems.get(item.nodeId);
    const observed = observedItemsByNodeId.get(item.nodeId);
    const activity =
      observed == null
        ? previous == null
          ? undefined
          : Object.freeze({
              lastHumanActivityAt: previous.lastHumanActivityAt,
              lastProgressAt: previous.lastProgressAt,
            })
        : determineMeaningfulProgress({
            createdAt: observed.createdAt,
            evaluatedAt: invocation.startedAt,
            events: observed.events,
            dependencyResolutions: [],
            naturalLanguageAssessments: [],
            minimumAiConfidence: configuration.config.ai.confidence.medium,
            previousActivity:
              previous == null
                ? {
                    status: "not_available",
                  }
                : {
                    status: "available",
                    lastProgressAt: previous.lastProgressAt,
                    lastHumanActivityAt: previous.lastHumanActivityAt,
                  },
            repositoryFullName: repositoryFullName(repository),
            resolveLabelEffects,
          });
    assertNonNullable(
      activity,
      `詳細未取得の新規項目を追跡候補へ変換できません。対象: ${item.nodeId}`,
    );
    if (item.state === "open") {
      return Object.freeze({
        scope: "organization",
        nodeId: item.nodeId,
        repositoryFullName: repositoryFullName(repository),
        number: item.number,
        url: item.url,
        title: item.title,
        createdAt: item.createdAt,
        activity: Object.freeze({
          lastHumanActivityAt: activity.lastHumanActivityAt,
          lastProgressAt: activity.lastProgressAt,
        }),
        authorType: enumeratedAuthorType(item, isBot),
        notificationClass: "standard",
        state: "open",
      });
    }
    return Object.freeze({
      scope: "organization",
      nodeId: item.nodeId,
      repositoryFullName: repositoryFullName(repository),
      number: item.number,
      url: item.url,
      title: item.title,
      createdAt: item.createdAt,
      activity: Object.freeze({
        lastHumanActivityAt: activity.lastHumanActivityAt,
        lastProgressAt: activity.lastProgressAt,
      }),
      authorType: enumeratedAuthorType(item, isBot),
      notificationClass: "standard",
      state: "closed",
      terminalAt: item.closedAt,
    });
  });
  const result = selectTrackingItems({
    startAt: trackingStartAt(configuration, state, invocation),
    evaluatedAt: invocation.startedAt,
    candidates,
    connections: createTrackingConnections(relationCandidates),
    previouslyTrackedNodeIds: Object.freeze(
      [...previousItems.keys()].filter((nodeId) => currentNodeIds.has(nodeId)),
    ),
    explicitIncludes: configuration.config.tracking.include
      .map(normalizeTrackingIdentifier)
      .filter((identifier) =>
        candidates.some(
          (candidate) => candidate.nodeId === identifier || candidate.url === identifier,
        ),
      ),
    autoInclude: configuration.config.tracking.autoInclude,
    backfill: createTrackingBackfillRequest(
      invocation.command,
      Object.freeze({
        status: "start",
      }),
    ),
    maxBackfillItemsPerRun: configuration.config.tracking.backfill.maxItemsPerRun,
  });
  const previousCollectionItems = previousCollectionItemsByNodeId(state);
  const enumeratedItemsByNodeId = new Map(enumeratedItems.map((item) => [item.nodeId, item]));
  const workByNodeId = new Map<GitHubNodeId, TrackedItemWorkDecision>();
  for (const selected of result.trackedItems) {
    const item = enumeratedItemsByNodeId.get(selected.item.nodeId);
    assertNonNullable(item, `追跡対象の列挙値がありません。対象: ${selected.item.nodeId}`);
    const previousCollectionItem = previousCollectionItems.get(item.nodeId);
    workByNodeId.set(
      item.nodeId,
      determineTrackedItemWork({
        state: item.state,
        analysisInputFingerprint: item.itemFingerprint,
        previousObservation:
          previousCollectionItem == null
            ? Object.freeze({ status: "not_available" })
            : Object.freeze({
                status: "available",
                state: previousCollectionItem.state,
                analysisInputFingerprint: previousCollectionItem.itemFingerprint,
              }),
      }),
    );
  }
  return Object.freeze({
    result,
    workByNodeId,
  });
}

function candidatesForNode(
  nodeId: GitHubNodeId,
  candidates: readonly RelationCandidate[],
): readonly RelationCandidate[] {
  return Object.freeze(
    candidates.filter((candidate) =>
      relationNodes(candidate.relation).some((node) => node.nodeId === nodeId),
    ),
  );
}

function createNativeBlockers(
  item: FreshObservedGitHubItem,
  candidates: readonly RelationCandidate[],
): readonly IssueBlocker[] {
  const blockers: IssueBlocker[] = [];
  for (const candidate of candidates) {
    if (
      candidate.authority !== "authoritative" ||
      candidate.relation.type !== "blocks" ||
      candidate.relation.blocked.nodeId !== item.nodeId
    ) {
      continue;
    }
    blockers.push(
      Object.freeze({
        candidateId: candidate.relation.blocker.nodeId,
        state: candidate.relation.blocker.state,
        authority: "authoritative",
        confidence: 1,
        sourceIds: candidate.sourceIds,
        becameBlockingAt: item.observedAt,
      }),
    );
  }
  return Object.freeze(blockers);
}

function createIssueRequestCandidates(
  item: Extract<FreshObservedGitHubItem, { type: "issue" }>,
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
): readonly Readonly<{ sourceId: SourceId; occurredAt: UtcIsoDateTime }>[] {
  const candidates: Readonly<{ sourceId: SourceId; occurredAt: UtcIsoDateTime }>[] = [];
  if (detail.body.trim().length > 0) {
    candidates.push(
      Object.freeze({
        sourceId: detail.bodySourceId,
        occurredAt: item.createdAt,
      }),
    );
  }
  const humanCommentSourceIds = new Set(
    item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) => event.sourceId),
  );
  for (const comment of detail.comments) {
    if (comment.body.trim().length > 0 && humanCommentSourceIds.has(comment.sourceId)) {
      candidates.push(
        Object.freeze({
          sourceId: comment.sourceId,
          occurredAt: comment.createdAt,
        }),
      );
    }
  }
  return deduplicateByStableId(candidates, (candidate) => candidate.sourceId);
}

function applyDeterministicAnalysis(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
): DeterministicAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const items: DeterministicItemAnalysis[] = [];
  for (const item of collection.observedItems) {
    if (!collection.analysisNodeIds.has(item.nodeId)) {
      continue;
    }
    const repository = findRepository(inventory, item.repositoryId);
    const teams = resolveRepositoryTeams(
      repositoryFullName(repository),
      configuration.config.teams,
      inventory.teams,
    );
    const detail = findDetail(collection, item.nodeId);
    const relationCandidates = candidatesForNode(item.nodeId, collection.relationCandidates);
    const blockers = createNativeBlockers(item, relationCandidates);
    if (item.type === "issue" && detail.type === "issue") {
      const decision = determineIssueState({
        issue: item,
        blockers,
        explicitRequestCandidates: createIssueRequestCandidates(item, detail),
        explicitRequestAssessment: {
          status: "not_assessed",
        },
        teams,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: invocation.startedAt,
      });
      items.push(
        Object.freeze({
          item,
          detail,
          decision,
          relationCandidates,
        }),
      );
      continue;
    }
    if (item.type === "pull_request" && detail.type === "pull_request") {
      const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
      const decision = determinePullRequestState({
        pullRequest: item,
        blockers,
        checkFailureAssessment: {
          cause: "not_assessed",
        },
        labelEffects,
        teams,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: invocation.startedAt,
      });
      items.push(
        Object.freeze({
          item,
          detail,
          decision,
          relationCandidates,
        }),
      );
      continue;
    }
    throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${item.nodeId}`);
  }
  return Object.freeze({
    items: Object.freeze(items),
    state,
    inventory,
  });
}

function codexActorType(item: FreshObservedGitHubItem): "human" | "bot" | "system" {
  const type = authorType(item);
  return type === "unknown" ? "system" : type;
}

function codexAuthorCandidateId(item: FreshObservedGitHubItem): string {
  return item.author.status === "identified"
    ? item.author.actor.nodeId
    : `deleted-account:${item.nodeId}`;
}

function relationTargetUrl(
  nodeId: GitHubNodeId,
  candidate: RelationCandidate,
): PublicGitHubRelationItem["url"] {
  const nodes = relationNodes(candidate.relation);
  const target = nodes.find((node) => node.nodeId !== nodeId);
  assertNonNullable(target, `関係候補 ${candidate.id}の相手項目がありません`);
  return target.url;
}

function createCodexInput(
  invocation: DailyRunInvocation,
  analysis: DeterministicItemAnalysis,
): CodexAnalysisInput {
  const waitingOnCandidateIds = new Set(
    analysis.decision.waitingOn.map((waitingOn) => waitingOn.candidateId),
  );
  waitingOnCandidateIds.add(codexAuthorCandidateId(analysis.item));
  const sourceRecords = new Map<string, unknown>();
  sourceRecords.set(
    analysis.item.sourceId,
    Object.freeze({
      id: analysis.item.sourceId,
      kind: "item",
      actorType: codexActorType(analysis.item),
      createdAt: analysis.item.createdAt,
    }),
  );
  for (const event of analysis.item.events) {
    sourceRecords.set(
      event.sourceId,
      Object.freeze({
        id: event.sourceId,
        kind: event.kind,
        actorType: event.actor.type,
        createdAt: event.occurredAt,
      }),
    );
  }
  sourceRecords.set(
    analysis.detail.bodySourceId,
    Object.freeze({
      id: analysis.detail.bodySourceId,
      kind: "body",
      actorType: codexActorType(analysis.item),
      createdAt: analysis.item.createdAt,
      content: analysis.detail.body,
    }),
  );
  for (const comment of analysis.detail.comments) {
    const event = analysis.item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    sourceRecords.set(
      comment.sourceId,
      Object.freeze({
        id: comment.sourceId,
        kind: "comment",
        actorType: event?.actor.type ?? "system",
        createdAt: comment.createdAt,
        content: comment.body,
      }),
    );
  }
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: invocation.startedAt,
    item: {
      nodeId: analysis.item.nodeId,
      url: analysis.item.url,
      type: analysis.item.type,
      title: analysis.item.title,
      authorCandidateId: codexAuthorCandidateId(analysis.item),
      ...(analysis.item.type === "pull_request"
        ? {
            headSha: analysis.item.headSha,
          }
        : {}),
    },
    candidates: {
      waitingOn: [...waitingOnCandidateIds].map((id) => ({ id })),
      relations: analysis.relationCandidates.map((candidate) => ({
        id: candidate.id,
        targetUrl: relationTargetUrl(analysis.item.nodeId, candidate),
      })),
    },
    sources: [...sourceRecords.values()],
    deterministicSignals: {
      status: analysis.decision.status,
      waitingOn: analysis.decision.waitingOn,
      relationCandidateIds: analysis.relationCandidates.map((candidate) => candidate.id),
      uncertainties: analysis.decision.uncertainties,
    },
    priorAnalysis: null,
  });
}

function createAiCandidates(
  invocation: DailyRunInvocation,
  deterministicAnalysis: DeterministicAnalysis,
): Readonly<{
  candidates: readonly AiAnalysisCandidate[];
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
}> {
  const inputByNodeId = new Map<GitHubNodeId, CodexAnalysisInput>();
  const candidates = deterministicAnalysis.items.map((analysis) => {
    const input = createCodexInput(invocation, analysis);
    inputByNodeId.set(analysis.item.nodeId, input);
    return Object.freeze({
      id: analysis.item.nodeId,
      deterministicResolution:
        analysis.decision.determination === "determined" &&
        analysis.relationCandidates.every((candidate) => candidate.authority === "authoritative")
          ? "high_confidence"
          : "ambiguous",
      input,
      graphNeighborhood: Object.freeze(
        analysis.relationCandidates.map((candidate) => candidate.id),
      ),
      previousFingerprint: Object.freeze({
        status: "unavailable",
      }),
      priority: Object.freeze({
        severityCandidate: analysis.decision.determination === "codex_candidate",
        ownerUnknown: analysis.decision.waitingOn.some((waitingOn) => waitingOn.kind === "unknown"),
        changedBlocker: false,
        downstreamImpact: Object.freeze({
          openNodeCount: 0,
          repositoryCount: 0,
        }),
      }),
      estimatedCostUsd: 0,
    } satisfies AiAnalysisCandidate);
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    inputByNodeId,
  });
}

async function analyzeCodex(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  deterministicAnalysis: DeterministicAnalysis,
): Promise<
  Readonly<{
    stage: CodexAnalysis;
    status: "success" | "fallback";
    aiCallCount: number;
    aiCacheHitCount: number;
    estimatedInputTokens: number;
    diagnostics: readonly string[];
  }>
> {
  const prepared = createAiCandidates(invocation, deterministicAnalysis);
  if (!configuration.config.ai.enabled) {
    return Object.freeze({
      stage: Object.freeze({
        run: undefined,
        inputByNodeId: prepared.inputByNodeId,
      }),
      status: "success",
      aiCallCount: 0,
      aiCacheHitCount: 0,
      estimatedInputTokens: 0,
      diagnostics: Object.freeze([]),
    });
  }
  const run = await runAiAnalyses(
    prepared.candidates,
    {
      identity: {
        deterministicRulesVersion: "daily-rules-v1",
        model: configuration.config.ai.model,
        backendVersion: CODEX_BACKEND_VERSION,
        promptVersion: configuration.config.ai.promptVersion,
        schemaVersion: CODEX_SCHEMA_VERSION,
      },
      budget: configuration.config.ai.budget,
    },
    {
      cache: state.session.aiCache,
      execute: (input) =>
        adapters.executeCodexAnalysis(
          input,
          {
            model: configuration.config.ai.model,
            execution: configuration.config.ai.execution,
          },
          {
            environment: isolatedCodexEnvironment(
              adapters.environment,
              configuration.credentials.openAiApiKey,
            ),
            processRunner: adapters.codexProcessRunner,
          },
        ),
      executedAt: () => invocation.startedAt,
    },
  );
  const fallback = run.failures.length > 0 || run.deferred.length > 0;
  return Object.freeze({
    stage: Object.freeze({
      run,
      inputByNodeId: prepared.inputByNodeId,
    }),
    status: fallback ? "fallback" : "success",
    aiCallCount: run.usage.calls,
    aiCacheHitCount: run.results.filter((result) => result.origin === "cache").length,
    estimatedInputTokens: Math.ceil(run.usage.inputCharacters / 4),
    diagnostics: Object.freeze([
      ...run.failures.map(
        (failure) =>
          `codex_fallback item=${failure.candidateId} reason=${failure.reason} errorType=${failure.errorType}`,
      ),
      ...run.deferred.map(
        (deferred) => `codex_deferred item=${deferred.candidateId} reason=${deferred.reason}`,
      ),
    ]),
  });
}

function deterministicCodexDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): DeterministicCodexDecision {
  return Object.freeze({
    determination: decision.determination,
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

function reducedDeterministicDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): ReducedCodexDecision {
  return Object.freeze({
    origin: "deterministic",
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

function reductionForAnalysis(
  configuration: RuntimeConfiguration,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): CodexAnalysisReduction | undefined {
  const run = codexAnalysis.run;
  if (run == null) {
    return undefined;
  }
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
  const result = run.results.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (result != null) {
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "validated",
        output: result.output,
      },
      configuration.config.ai.confidence,
    );
  }
  const failure = run.failures.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (failure != null) {
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "unavailable",
        reason: failure.reason,
        errorType: failure.errorType,
      },
      configuration.config.ai.confidence,
    );
  }
  const deferred = run.deferred.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (deferred != null) {
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "unavailable",
        reason: "execution_failed",
        errorType: `CodexBudgetDeferred:${deferred.reason}`,
      },
      configuration.config.ai.confidence,
    );
  }
  return undefined;
}

function transitionBasisForDecision(
  invocation: DailyRunInvocation,
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
): Readonly<{
  statusBasis: IssueStateDecision["statusBasis"];
  responsibilityBasis: IssueStateDecision["responsibilityBasis"];
}> {
  if (decision.origin === "deterministic") {
    return Object.freeze({
      statusBasis: analysis.decision.statusBasis,
      responsibilityBasis: analysis.decision.responsibilityBasis,
    });
  }
  const sourceId = decision.evidence[0]?.sourceId ?? analysis.item.sourceId;
  const basis = Object.freeze({
    sourceIds: Object.freeze([sourceId] satisfies [SourceId]),
    occurredAt: invocation.startedAt,
    precision: "inferred",
  });
  return Object.freeze({
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function previousStalenessState(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): Parameters<typeof calculateStaleness>[0]["previousState"] {
  const previous = previousSnapshot(state)?.items.find((item) => item.nodeId === nodeId);
  if (previous == null) {
    return Object.freeze({
      availability: "not_available",
    });
  }
  return Object.freeze({
    availability: "available",
    value: Object.freeze({
      status: previous.status,
      waitingOn: previous.waitingOn,
      statusSince: previous.statusSince,
      ownerSince: previous.ownerSince,
      stallSince: previous.stallSince,
      lastProgressAt: previous.lastProgressAt,
      lastHumanActivityAt: previous.lastHumanActivityAt,
    }),
  });
}

function trackedItemState(
  item: FreshObservedGitHubItem,
  decision: ReducedCodexDecision,
): TrackedItem["state"] {
  if (decision.status === "terminal_merged") {
    return "merged";
  }
  return item.state;
}

function createTrackedItem(
  invocation: DailyRunInvocation,
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
  staleness: StalenessResult,
): TrackedItem {
  const commonFields = {
    nodeId: analysis.item.nodeId,
    type: analysis.item.type,
    repositoryId: analysis.item.repositoryId,
    displayReference: analysis.item.displayReference,
    number: analysis.item.number,
    url: analysis.item.url,
    title: analysis.item.title,
    state: trackedItemState(analysis.item, decision),
    nextAction: decision.nextAction,
    createdAt: analysis.item.createdAt,
    githubUpdatedAt: analysis.item.githubUpdatedAt,
    lastHumanActivityAt: staleness.lastHumanActivityAt,
    lastProgressAt: staleness.lastProgressAt,
    statusSince: staleness.statusSince,
    ownerSince: staleness.ownerSince,
    stallSince: staleness.stallSince,
    observedAt: invocation.startedAt,
    labels: analysis.item.labels,
    assignees: analysis.item.assignees,
    reviewState: analysis.item.type === "issue" ? "not_applicable" : "unknown",
    checkState: analysis.item.type === "issue" ? "not_applicable" : "unknown",
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  } satisfies Omit<TrackedItem, "status" | "waitingOn">;
  if (isTerminalStatus(decision.status)) {
    return Object.freeze({
      ...commonFields,
      status: decision.status,
      waitingOn: Object.freeze([] satisfies []),
    });
  }
  return Object.freeze({
    ...commonFields,
    status: decision.status,
    waitingOn: decision.waitingOn,
  });
}

function blockedParentContext(
  state: RuntimeState,
  decision: ReducedCodexDecision,
): BlockedParentContext {
  if (decision.status !== "blocked") {
    return Object.freeze({
      status: "not_applicable",
    });
  }
  const firstWaitingOn = decision.waitingOn[0];
  assertNonNullable(firstWaitingOn, "blocked項目にwaitingOnがありません");
  const previousSeverityByNodeId = new Map<string, Severity>(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item.severity]),
  );
  const createRanking = (waitingOn: ReducedCodexDecision["waitingOn"][number]): BlockerRanking =>
    Object.freeze({
      candidateId: waitingOn.candidateId,
      severity: previousSeverityByNodeId.get(waitingOn.candidateId) ?? "none",
      downstreamImpact: 0,
    });
  const blockers: [BlockerRanking, ...BlockerRanking[]] = [
    createRanking(firstWaitingOn),
    ...decision.waitingOn.slice(1).map(createRanking),
  ];
  return Object.freeze({
    status: "available",
    blockers: Object.freeze(blockers),
  });
}

function reduceAllAnalyses(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
): ReducedAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentItems: ReducedItemAnalysis[] = [];
  const items: TrackedItem[] = [];
  const relationAssessments: RelationCandidateAssessment[] = [];
  let runStatus: ReducedAnalysis["runStatus"] = "success";
  for (const analysis of deterministicAnalysis.items) {
    const reduction = reductionForAnalysis(configuration, analysis, codexAnalysis);
    const decision = reduction?.decision ?? reducedDeterministicDecision(analysis.decision);
    if (reduction?.ai.status === "unavailable") {
      runStatus = "fallback";
    }
    relationAssessments.push(...(reduction?.relationAssessments ?? []));
    const basis = transitionBasisForDecision(invocation, analysis, decision);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const staleness = calculateStaleness({
      createdAt: analysis.item.createdAt,
      evaluatedAt: invocation.startedAt,
      currentDecision: {
        status: decision.status,
        waitingOn: decision.waitingOn,
        confidence: decision.confidence,
        statusBasis: basis.statusBasis,
        responsibilityBasis: basis.responsibilityBasis,
      },
      previousState: previousStalenessState(state, analysis.item.nodeId),
      events: analysis.item.events,
      dependencyResolutions: [],
      naturalLanguageAssessments: [],
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      repositoryFullName: repositoryFullName(repository),
      currentLabels: analysis.item.labels,
      resolveLabelEffects,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      blockedParentContext: blockedParentContext(state, decision),
    });
    currentItems.push(
      Object.freeze({
        item: analysis.item,
        detail: analysis.detail,
        decision,
        staleness,
      }),
    );
    items.push(createTrackedItem(invocation, analysis, decision, staleness));
  }
  const currentNodeIds = new Set(items.map((item) => item.nodeId));
  const currentRepositoryIds = new Set<string>(
    inventory.allowlist.repositories.map((repository) => repository.id),
  );
  for (const previousItem of previousSnapshot(state)?.items ?? []) {
    if (
      !currentNodeIds.has(previousItem.nodeId) &&
      collection.trackedNodeIds.has(previousItem.nodeId) &&
      currentRepositoryIds.has(previousItem.repositoryId)
    ) {
      items.push(previousItem);
    }
  }
  return Object.freeze({
    items: Object.freeze(items),
    currentItems: Object.freeze(currentItems),
    relationAssessments: Object.freeze(relationAssessments),
    runStatus,
  });
}

function graphAnalysisNode(item: TrackedItem): GraphAnalysisNode {
  return Object.freeze({
    kind: item.type,
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    state: item.state,
    directNotification: "eligible",
  });
}

function persistedRelationCandidateId(value: string): RelationCandidateId {
  if (!value.startsWith("rel:") || value.length === "rel:".length) {
    throw new TypeError(`永続化済みrelation IDの形式が不正です。対象: ${value}`);
  }
  return `rel:${value.slice("rel:".length)}`;
}

function previousGraphEdge(relation: Relation): ReconciledGraphEdge {
  const fields = {
    id: persistedRelationCandidateId(relation.id),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: Object.freeze([]),
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: relation.removedAt,
  });
}

function previousGraphSnapshot(state: RuntimeState): GraphAnalysisSnapshot | undefined {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return undefined;
  }
  return Object.freeze({
    nodes: Object.freeze(snapshot.items.map(graphAnalysisNode)),
    edges: Object.freeze(snapshot.relations.map(previousGraphEdge)),
  });
}

function preserveStaleGraphEdges(
  collection: CollectedItems,
  previousEdges: readonly ReconciledGraphEdge[],
  reconciledEdges: readonly ReconciledGraphEdge[],
): readonly ReconciledGraphEdge[] {
  const staleNodeIds = new Set<string>(collection.staleItems.map((item) => item.nodeId));
  const preservedEdges = new Map(
    previousEdges
      .filter((edge) => staleNodeIds.has(edge.fromNodeId) || staleNodeIds.has(edge.toNodeId))
      .map((edge) => [edge.id, edge]),
  );
  const result = reconciledEdges.map((edge) => preservedEdges.get(edge.id) ?? edge);
  const resultIds = new Set(result.map((edge) => edge.id));
  for (const edgeId of preservedEdges.keys()) {
    if (!resultIds.has(edgeId)) {
      throw new TypeError(`stale repositoryの前回edgeがありません。対象: ${edgeId}`);
    }
  }
  return Object.freeze(result);
}

function reconcileCurrentGraph(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
): GraphResult {
  const previous = previousGraphSnapshot(state);
  const nodeIds = new Set(reduction.items.map((item) => item.nodeId));
  const candidates = collection.relationCandidates.filter((candidate) =>
    relationNodes(candidate.relation).every(
      (node) => node.scope === "organization" && nodeIds.has(node.nodeId),
    ),
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const reconciled: ReconcileGraphResult = reconcileGraph({
    previousGraph: {
      edges: previous?.edges ?? [],
      historyEvents: [],
    },
    candidates,
    assessments: reduction.relationAssessments.filter((assessment) =>
      candidateIds.has(assessment.candidateId),
    ),
    minimumInferredConfidence: configuration.config.ai.confidence.medium,
    reconciledAt: invocation.startedAt,
  });
  const edges = preserveStaleGraphEdges(collection, previous?.edges ?? [], reconciled.edges);
  const graphNodes = reduction.items.map(graphAnalysisNode);
  const analysis = analyzeGraph({
    current: {
      nodes: graphNodes,
      edges,
    },
    previous:
      previous == null
        ? {
            availability: "unavailable",
          }
        : {
            availability: "available",
            snapshot: previous,
          },
  });
  return Object.freeze({
    edges,
    analysis,
    previousAnalysis:
      previous == null
        ? Object.freeze({
            availability: "unavailable",
          })
        : Object.freeze({
            availability: "available",
            value: analyzeGraph({
              current: previous,
              previous: {
                availability: "unavailable",
              },
            }),
          }),
  });
}

function toStateRelation(edge: ReconciledGraphEdge): Relation {
  const fields = {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
  };
  if (edge.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: edge.removedAt,
  });
}

function snapshotRepositories(collection: CollectedItems): readonly SnapshotRepository[] {
  return Object.freeze(
    collection.repositoryResults.map((result) => {
      if (result.freshness === "fresh") {
        return Object.freeze({
          ...result.repository,
          observedAt: result.observedAt,
          freshness: "fresh",
        });
      }
      return Object.freeze({
        ...result.repository,
        observedAt: result.lastSuccessfulAt,
        freshness: "stale",
        failedAt: result.failedAt,
      });
    }),
  );
}

function notificationLedgerEntries(
  state: RuntimeState,
  items: readonly TrackedItem[],
): readonly NotificationLedgerEntry[] {
  const itemsByNodeId = new Map<string, TrackedItem>(items.map((item) => [item.nodeId, item]));
  const entries: NotificationLedgerEntry[] = [];
  for (const entry of state.notificationLedger.entries) {
    const item = itemsByNodeId.get(entry.itemNodeId);
    if (item == null) {
      continue;
    }
    const fields = {
      notificationKey: entry.notificationKey,
      itemNodeId: item.nodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: createUtcIsoDateTime(entry.reservedAt),
      cooldownUntil: createUtcIsoDateTime(entry.cooldownUntil),
    };
    if (entry.status === "reserved") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "reserved",
        }),
      );
    } else {
      entries.push(
        Object.freeze({
          ...fields,
          status: "sent",
          sentAt: createUtcIsoDateTime(entry.sentAt),
          discordMessageId: entry.discordMessageId,
        }),
      );
    }
  }
  return Object.freeze(entries);
}

function notificationLatestChange(
  current: ReducedItemAnalysis,
  previous: TrackedItem | undefined,
): DiscordNotificationItem["latestChange"] {
  if (previous == null || current.item.githubUpdatedAt === previous.githubUpdatedAt) {
    return "none";
  }
  return current.item.events.some(
    (event) => event.actor.type === "human" && event.occurredAt > previous.observedAt,
  )
    ? "human"
    : "bot_only";
}

function notificationItem(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  graph: GraphResult,
  current: ReducedItemAnalysis,
): DiscordNotificationItem {
  const item = current.item;
  const repository = findRepository(inventory, item.repositoryId);
  const previous = previousSnapshot(state)?.items.find(
    (candidate) => candidate.nodeId === item.nodeId,
  );
  const downstreamImpact = graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === item.nodeId,
  );
  assertNonNullable(downstreamImpact, `通知対象 ${item.nodeId}のdownstream impactがありません`);
  const labelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config))(
    repositoryFullName(repository),
    item.labels,
  );
  const cycleIds = graph.analysis.dependencyCycles
    .filter((cycle) => cycle.nodeIds.includes(item.nodeId))
    .map((cycle) => cycle.id);
  const previousDependencyCycles: DiscordNotificationItem["graph"]["previousDependencyCycles"] =
    graph.previousAnalysis.availability === "unavailable"
      ? Object.freeze({
          availability: "not_available",
        })
      : Object.freeze({
          availability: "available",
          cycleIds: Object.freeze(
            graph.previousAnalysis.value.dependencyCycles
              .filter((cycle) => cycle.nodeIds.includes(item.nodeId))
              .map((cycle) => cycle.id),
          ),
        });
  return Object.freeze({
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    draftState:
      item.type === "issue" ? "not_applicable" : item.draft ? "draft" : "ready_for_review",
    repositoryFreshness: "fresh",
    notificationClass: "standard",
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
    latestChange: notificationLatestChange(current, previous),
    decisionBasis:
      current.decision.origin === "deterministic"
        ? Object.freeze({
            source: "deterministic",
          })
        : Object.freeze({
            source: "ai_only",
            confidence: current.decision.confidence,
          }),
    priorityWeight: labelEffects.priorityWeight,
    current: {
      status: current.decision.status,
      waitingOn: current.decision.waitingOn,
      severity: current.staleness.severity,
      waitClass: current.staleness.waitClass,
      statusSince: current.staleness.statusSince,
      ownerSince: current.staleness.ownerSince,
      stallSince: current.staleness.stallSince,
      lastProgressAt: current.staleness.lastProgressAt,
    },
    previous:
      previous == null
        ? Object.freeze({
            availability: "not_available",
          })
        : Object.freeze({
            availability: "available",
            value: Object.freeze({
              status: previous.status,
              waitingOn: previous.waitingOn,
              severity: previous.severity,
              stallSince: previous.stallSince,
              observedAt: previous.observedAt,
            }),
          }),
    graph: Object.freeze({
      downstreamImpact,
      newlyUnblocked: graph.analysis.newlyUnblockedNodeIds.includes(item.nodeId),
      currentDependencyCycleIds: cycleIds,
      previousDependencyCycles,
    }),
  });
}

function mergeNotificationLedger(
  state: RuntimeState,
  selection: DiscordNotificationSelection,
): StateNotificationLedger {
  const entries = new Map(
    state.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  for (const reservation of selection.ledgerReservations) {
    entries.set(reservation.notificationKey, reservation);
  }
  return createStateNotificationLedger({
    schemaVersion: "1",
    entries: [...entries.values()],
    operationsAlerts: state.notificationLedger.operationsAlerts,
  });
}

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): ValidatedRun {
  const severityByNodeId = new Map(
    reduction.currentItems.map((item) => [item.item.nodeId, item.staleness.severity]),
  );
  const previousSeverityByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item.severity]),
  );
  const snapshot = createStateSnapshot({
    schemaVersion: "1",
    generatedAt: invocation.startedAt,
    trackingStartAt: trackingStartAt(configuration, state, invocation),
    collection: {
      repositories: collection.collectionRepositories,
    },
    repositories: snapshotRepositories(collection),
    items: reduction.items.map((item) => {
      const severity =
        severityByNodeId.get(item.nodeId) ?? previousSeverityByNodeId.get(item.nodeId);
      assertNonNullable(severity, `追跡項目 ${item.nodeId}のseverityがありません`);
      return {
        ...item,
        severity,
      };
    }),
    relations: graph.edges.map(toStateRelation),
    run: {
      id: invocation.runId,
      status: reduction.runStatus,
      complete: true,
    },
  });
  const notificationSelection = selectDiscordNotifications({
    evaluatedAt: invocation.startedAt,
    items: reduction.currentItems.map((item) =>
      notificationItem(configuration, state, inventory, graph, item),
    ),
    ledger: notificationLedgerEntries(state, reduction.items),
    settings: {
      maxItemsPerDigest: configuration.config.notifications.discord.maxItemsPerDigest,
      cooldownDays: configuration.config.notifications.discord.cooldownDays,
      recentProgressGraceHours: configuration.config.staleness.recentProgressGraceHours,
      minimumAiConfidence: configuration.config.ai.confidence.medium,
    },
  });
  return Object.freeze({
    snapshot,
    notificationLedger: mergeNotificationLedger(state, notificationSelection),
    notificationSelection,
  });
}

function persistedMetrics(metrics: RunMetrics, validated: ValidatedRun): RunMetrics {
  return Object.freeze({
    ...metrics,
    repositoryCount: validated.snapshot.repositories.length,
    itemCount: validated.snapshot.items.length,
    activeEdgeCount: validated.snapshot.relations.filter((relation) => relation.active).length,
    staleRepositoryCount: validated.snapshot.repositories.filter(
      (repository) => repository.freshness === "stale",
    ).length,
    durationMilliseconds: 0,
  });
}

function createPersistedRunReport(
  invocation: DailyRunInvocation,
  validated: ValidatedRun,
  metrics: RunMetrics,
  status: "success" | "fallback",
  diagnostics: readonly string[],
): StateRunReport {
  return createStateRunReport({
    schemaVersion: "1",
    runId: invocation.runId,
    date: invocation.startedAt.slice(0, 10),
    status,
    complete: true,
    scheduledFor: invocation.scheduledFor,
    startedAt: invocation.startedAt,
    finishedAt: invocation.startedAt,
    metrics: persistedMetrics(metrics, validated),
    diagnostics,
  });
}

function discordDeliverySettings(config: Config): DiscordDeliverySettings {
  return Object.freeze({
    enabled: config.notifications.discord.enabled,
    webhookSecretName: config.notifications.discord.webhookSecretName,
    operationsWebhookSecretName: config.notifications.discord.operationsWebhookSecretName,
    mentions: config.notifications.discord.mentions,
    retry: config.operations.retry,
  });
}

function createCollectAnalyzeArtifact(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  validated: ValidatedRun,
  metrics: RunMetrics,
  status: "success" | "fallback",
  diagnostics: readonly string[],
): WorkflowArtifact {
  const artifact = createWorkflowArtifact({
    schemaVersion: "1",
    kind: "validated_public_run",
    snapshot: validated.snapshot,
    notificationLedger: validated.notificationLedger,
    notificationSelection: validated.notificationSelection,
    stateRunReport: createPersistedRunReport(invocation, validated, metrics, status, diagnostics),
    aiCacheEntries: state.session.pendingAiCacheEntries(),
    pagesUrl: pagesUrl(configuration.config),
    discordSettings: discordDeliverySettings(configuration.config),
  });
  assertWorkflowArtifactPublicSafety(
    artifact,
    inventory.inventory,
    configuration.credentials.knownSecrets,
  );
  return artifact;
}

async function persistValidatedRun(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  validated: ValidatedRun,
  metrics: RunMetrics,
  status: "success" | "fallback",
  diagnostics: readonly string[],
): Promise<PersistedRun> {
  const result = await state.session.persist({
    snapshot: validated.snapshot,
    notificationLedger: validated.notificationLedger,
    runReport: createPersistedRunReport(invocation, validated, metrics, status, diagnostics),
    repositoryInventory: inventory.inventory,
    knownSecrets: configuration.credentials.knownSecrets,
  });
  const historyRecords = await state.session.loadHistoryRecords();
  return Object.freeze({
    result,
    historyRecords,
  });
}

function pagesUrl(config: Config): string {
  return new URL(config.web.basePath, PAGES_BASE_URL).href;
}

async function buildPublicPages(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  inventory: readonly Repository[],
  validated: ValidatedRun,
  historyRecords: readonly StateHistoryRecord[],
  outputDirectory: string,
  knownSecrets: readonly string[],
): Promise<PagesResult> {
  const data = generatePublicData({
    snapshot: validated.snapshot,
    historyRecords,
    repositoryInventory: inventory,
    knownSecrets,
    options: {
      confidenceThresholds: config.ai.confidence,
      labelRules: normalizeLabelRules(config),
      maxInitialGraphNodes: config.web.graph.maxInitialNodes,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
    },
  });
  const output = await adapters.writePublicData(outputDirectory, data);
  return Object.freeze({
    data,
    output,
    pagesUrl: pagesUrl(config),
  });
}

function environmentSecretProvider(
  environment: Readonly<NodeJS.ProcessEnv>,
): DiscordSecretProvider {
  return Object.freeze({
    read: (name) => requireEnvironmentValue(environment, name),
  });
}

async function deliverDiscord(
  adapters: ProductionRuntimeAdapters,
  settings: DiscordDeliverySettings,
  validated: ValidatedRun,
  deployedPagesUrl: string,
): Promise<
  Readonly<{
    value: DiscordResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const sentNotificationEntries: NotificationLedgerEntry[] = [];
  const knownOperationsAlerts = new Set(
    validated.notificationLedger.operationsAlerts.map((entry) => entry.alertKey),
  );
  const delivery = await adapters.sendDiscord({
    candidates: validated.notificationSelection.candidates,
    ledgerReservations: validated.notificationSelection.ledgerReservations,
    items: validated.snapshot.items,
    generatedAt: validated.snapshot.generatedAt,
    pagesDeployment: {
      status: "succeeded",
      pagesUrl: deployedPagesUrl,
    },
    settings,
    dependencies: {
      secretProvider: environmentSecretProvider(adapters.environment),
      httpClient: adapters.discordHttpClient,
      runtime: {
        now: adapters.now,
        sleep: adapters.sleep,
        random: adapters.random,
      },
      ledger: {
        hasOperationsAlert: (alertKey) => Promise.resolve(knownOperationsAlerts.has(alertKey)),
        recordNotifications: (entries) => {
          sentNotificationEntries.push(...entries);
          return Promise.resolve();
        },
        recordOperationsAlert: (entry) => {
          knownOperationsAlerts.add(entry.alertKey);
          return Promise.resolve();
        },
      },
    },
  });
  let sentAt: UtcIsoDateTime | null = null;
  if (delivery.status === "sent") {
    const entries = delivery.ledgerEntries.filter((entry) => entry.status === "sent");
    const firstEntry = entries[0];
    assertNonNullable(firstEntry, "Discord送信結果に送信済みledger entryがありません");
    sentAt = entries.reduce(
      (latest, entry) => (entry.sentAt > latest ? entry.sentAt : latest),
      firstEntry.sentAt,
    );
  }
  return Object.freeze({
    value: Object.freeze({
      delivery,
    }),
    notificationCount: sentNotificationEntries.length,
    discordSentAt: sentAt,
  });
}

function configuredNodeIdentifiers(config: Config): readonly string[] {
  return Object.freeze(config.tracking.include.filter((identifier) => !identifier.includes("://")));
}

function previousRepositoryValues(state: RuntimeState): ReadonlyMap<
  GitHubRepositoryId,
  Readonly<{
    value: SnapshotCollectionRepository;
    observedAt: UtcIsoDateTime;
  }>
> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).map((repository) => [
      repository.repositoryId,
      Object.freeze({
        value: repository,
        observedAt: repository.successfulAt,
      }),
    ]),
  );
}

async function collectFreshRepositoryItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  explicitNodeItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
): Promise<FreshRepositoryRuntimeCollection> {
  const allowlist = createPublicRepositoryAllowlist([repository]);
  const openItems = await adapters.enumerateOpenGitHubItems({
    allowlist,
    observedAt: invocation.startedAt,
    request: authentication.request,
  });
  const resolvedNodeItems = explicitNodeItems.filter((item) => item.repositoryId === repository.id);
  const identifiers = missingIdentifiers(
    [
      ...configuredUrlIdentifiersForRepository(configuration.config, repository),
      ...previousTrackedItemIdentifiers(invocation, configuration, state, repository),
    ],
    [...openItems, ...resolvedNodeItems],
  );
  const individuallyEnumeratedItems =
    identifiers.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist,
          identifiers,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  const enumeratedItems = deduplicateByStableId(
    [...openItems, ...resolvedNodeItems, ...individuallyEnumeratedItems],
    (item) => item.nodeId,
  );
  const currentNodeIds = new Set(enumeratedItems.map((item) => item.nodeId));
  const plan = planIncrementalItemCollection({
    items: enumeratedItems,
    previous: previousItemCollection(state, repository),
    adjacentItemNodeIds: new Set(
      [...adjacentNodeIds].filter((nodeId) => currentNodeIds.has(nodeId)),
    ),
    overlapMilliseconds: INCREMENTAL_COLLECTION_OVERLAP_MILLISECONDS,
  });
  const detailNodeIds = new Set(plan.detailItemNodeIds);
  const detailTargets = enumeratedItems.filter((item) => detailNodeIds.has(item.nodeId));
  const details =
    detailTargets.length === 0
      ? Object.freeze([])
      : (
          await adapters.collectGitHubItemDetails({
            allowlist,
            items: detailTargets,
            observedAt: invocation.startedAt,
            eventWindow: detailEventWindow(plan),
            graphql: authentication.graphql,
          })
        ).items;
  const observedItems = normalizeObservedGitHubItems({
    items: detailTargets,
    details,
    isBot: createGitHubBotPredicate(configuration.config.actors.bots),
  });
  return Object.freeze({
    state: createSnapshotCollectionRepository(repository, invocation.startedAt, enumeratedItems),
    enumeratedItems,
    details,
    observedItems,
    changedNodeIds: plan.changedItemNodeIds,
  });
}

async function collectProductionItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repositoryInventory: RepositoryInventory,
): Promise<
  Readonly<{
    value: CollectedItems;
    changedItemCount: number;
    staleRepositoryCount: number;
    diagnostics: readonly string[];
  }>
> {
  const nodeIdentifiers = configuredNodeIdentifiers(configuration.config);
  const explicitNodeItems =
    nodeIdentifiers.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist: repositoryInventory.allowlist,
          identifiers: nodeIdentifiers,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  const adjacentNodeIds = previousGraphAdjacentNodeIds(state);
  const freshCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const repositoryResults = await collectRepositoriesWithStaleFallback({
    allowlist: repositoryInventory.allowlist,
    observedAt: invocation.startedAt,
    previousValues: previousRepositoryValues(state),
    collect: async (repository) => {
      const collected = await collectFreshRepositoryItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        explicitNodeItems,
        adjacentNodeIds,
      );
      freshCollectionsByRepositoryId.set(repository.id, collected);
      return collected.state;
    },
  });

  const enumeratedItems: EnumeratedGitHubItem[] = [];
  const details: GitHubItemDetail[] = [];
  const observedItems: FreshObservedGitHubItem[] = [];
  const staleItems: StaleObservedGitHubItem<SnapshotCollectionItem>[] = [];
  const changedNodeIds = new Set<GitHubNodeId>();
  const collectionRepositories: SnapshotCollectionRepository[] = [];
  const staleRepositoryIds = new Set<GitHubRepositoryId>();
  const diagnostics: string[] = [];
  for (const result of repositoryResults) {
    if (result.freshness === "fresh") {
      const collected = freshCollectionsByRepositoryId.get(result.repository.id);
      assertNonNullable(
        collected,
        `最新repository収集結果がありません。対象: ${result.repository.id}`,
      );
      enumeratedItems.push(...collected.enumeratedItems);
      details.push(...collected.details);
      observedItems.push(...collected.observedItems);
      for (const nodeId of collected.changedNodeIds) {
        changedNodeIds.add(nodeId);
      }
      collectionRepositories.push(result.value);
      continue;
    }
    staleRepositoryIds.add(result.repository.id);
    collectionRepositories.push(result.previousValue);
    staleItems.push(
      ...markObservedGitHubItemsStale({
        previousItems: result.previousValue.items,
        failedAt: result.failedAt,
        diagnostic: result.diagnostic,
      }),
    );
    diagnostics.push(result.diagnostic.message);
  }

  const uniqueEnumeratedItems = deduplicateByStableId(enumeratedItems, (item) => item.nodeId);
  const uniqueDetails = deduplicateByStableId(details, (detail) => detail.nodeId);
  const uniqueObservedItems = deduplicateByStableId(observedItems, (item) => item.nodeId);
  const relationCandidates = extractAllRelationCandidates(
    configuration.config,
    repositoryInventory.allowlist,
    uniqueEnumeratedItems,
    uniqueDetails,
  );
  const tracking = collectTrackingCandidates(
    invocation,
    configuration,
    state,
    repositoryInventory,
    uniqueEnumeratedItems,
    uniqueObservedItems,
    relationCandidates,
  );
  const trackedNodeIds = new Set(
    tracking.result.trackedItems.map((selected) => selected.item.nodeId),
  );
  for (const previousItem of previousSnapshot(state)?.items ?? []) {
    if (staleRepositoryIds.has(previousItem.repositoryId)) {
      trackedNodeIds.add(previousItem.nodeId);
    }
  }
  const observedNodeIds = new Set(uniqueObservedItems.map((item) => item.nodeId));
  const analysisNodeIds = new Set<GitHubNodeId>();
  for (const [nodeId, work] of tracking.workByNodeId) {
    if (work.codexAnalysis.action === "analyze" && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    value: Object.freeze({
      enumeratedItems: uniqueEnumeratedItems,
      details: uniqueDetails,
      observedItems: uniqueObservedItems,
      staleItems: Object.freeze(staleItems),
      trackedNodeIds,
      analysisNodeIds,
      changedNodeIds,
      relationCandidates,
      repositoryResults,
      collectionRepositories: Object.freeze(collectionRepositories),
    }),
    changedItemCount: [...changedNodeIds].filter((nodeId) => trackedNodeIds.has(nodeId)).length,
    staleRepositoryCount: staleRepositoryIds.size,
    diagnostics: Object.freeze(diagnostics),
  });
}

function createDailyDependencies(
  adapters: ProductionRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes> {
  return Object.freeze({
    validateConfiguration: async ({ invocation, configPath }) => {
      requireEnvironmentVariables(adapters.environment, ["GH_APP_ID", "GH_APP_PRIVATE_KEY"]);
      const config = await adapters.loadConfig(resolve(adapters.repositoryPath, configPath));
      const credentials = readRuntimeCredentials(adapters.environment, config, invocation.command);
      if (config.ai.enabled) {
        await assertCodexCliAvailable(adapters, credentials.openAiApiKey);
      }
      return Object.freeze({
        config,
        credentials,
      });
    },
    loadState: async ({ configuration }) => {
      const session = await adapters.openStateSession(
        adapters.createStateBranchAdapter(),
        configuration.config.state,
      );
      const [snapshot, notificationLedger] = await Promise.all([
        session.loadSnapshot(),
        session.loadNotificationLedger(),
      ]);
      return Object.freeze({
        session,
        snapshot,
        notificationLedger,
      });
    },
    authenticateGitHub: ({ configuration }) =>
      adapters.createGitHubClient({
        organization: configuration.config.organization,
        credentials: configuration.credentials.github,
        operations: configuration.config.operations,
      }),
    collectRepositoryInventory: async ({ invocation, configuration, authentication }) => {
      const inventory = await adapters.discoverRepositoryInventory({
        organization: configuration.config.organization,
        observedAt: invocation.startedAt,
        request: authentication.request,
      });
      const allowlist = createPublicRepositoryAllowlist(inventory);
      const teams = await adapters.collectGitHubTeamDirectory({
        teams: configuration.config.teams,
        request: authentication.request,
      });
      return Object.freeze({
        value: Object.freeze({
          inventory,
          allowlist,
          teams,
        }),
        repositoryCount: allowlist.repositories.length,
        githubApiRemaining: githubApiRemaining(authentication),
      });
    },
    collectIncrementalItems: async ({
      invocation,
      configuration,
      state,
      authentication,
      repositoryInventory,
    }) => {
      const collection = await collectProductionItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repositoryInventory,
      );
      return Object.freeze({
        value: collection.value,
        itemCount: collection.value.trackedNodeIds.size,
        changedItemCount: collection.changedItemCount,
        githubApiRemaining: githubApiRemaining(authentication),
        staleRepositoryCount: collection.staleRepositoryCount,
        diagnostics: collection.diagnostics,
      });
    },
    applyDeterministicRules: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      collection,
    }) =>
      Promise.resolve(
        applyDeterministicAnalysis(
          invocation,
          configuration,
          state,
          repositoryInventory,
          collection,
        ),
      ),
    analyzeWithCodex: async ({ invocation, configuration, state, deterministicAnalysis }) => {
      const analysis = await analyzeCodex(
        adapters,
        invocation,
        configuration,
        state,
        deterministicAnalysis,
      );
      return Object.freeze({
        status: analysis.status,
        value: analysis.stage,
        aiCallCount: analysis.aiCallCount,
        aiCacheHitCount: analysis.aiCacheHitCount,
        estimatedInputTokens: analysis.estimatedInputTokens,
        diagnostics: analysis.diagnostics,
      });
    },
    reduceAnalysis: ({
      invocation,
      configuration,
      collection,
      deterministicAnalysis,
      codexAnalysis,
    }) =>
      Promise.resolve(
        reduceAllAnalyses(
          invocation,
          configuration,
          deterministicAnalysis.state,
          deterministicAnalysis.inventory,
          collection,
          deterministicAnalysis,
          codexAnalysis,
        ),
      ),
    reconcileGraph: ({ invocation, configuration, state, collection, reduction }) => {
      const graph = reconcileCurrentGraph(invocation, configuration, state, collection, reduction);
      return Promise.resolve(
        Object.freeze({
          value: graph,
          activeEdgeCount: graph.edges.filter((edge) => edge.active).length,
        }),
      );
    },
    validateCompleteness: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      collection,
      reduction,
      graph,
    }) =>
      Promise.resolve(
        Object.freeze({
          status: "complete",
          value: validateRunCompleteness(
            invocation,
            configuration,
            state,
            repositoryInventory,
            collection,
            reduction,
            graph,
          ),
          diagnostics: Object.freeze([]),
        }),
      ),
    persistState: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      validated,
      metrics,
      status,
      diagnostics,
    }) =>
      persistValidatedRun(
        invocation,
        configuration,
        state,
        repositoryInventory,
        validated,
        metrics,
        status,
        diagnostics,
      ),
    buildPages: ({ configuration, repositoryInventory, validated, persisted }) =>
      buildPublicPages(
        adapters,
        configuration.config,
        repositoryInventory.inventory,
        validated,
        persisted.historyRecords,
        adapters.pagesOutputDirectory,
        configuration.credentials.knownSecrets,
      ),
    sendDiscord: async ({ configuration, validated, pages }) => {
      const result = await deliverDiscord(
        adapters,
        discordDeliverySettings(configuration.config),
        validated,
        pages.pagesUrl,
      );
      return Object.freeze({
        value: result.value,
        notificationCount: result.notificationCount,
        discordSentAt: result.discordSentAt,
      });
    },
    writeDryRunArtifact: (path, artifact) => adapters.writeJsonArtifact(path, artifact),
    writeCollectAnalyzeArtifact: (path, input) =>
      adapters.writeJsonArtifact(
        path,
        createCollectAnalyzeArtifact(
          input.invocation,
          input.configuration,
          input.state,
          input.repositoryInventory,
          input.validated,
          input.metrics,
          input.status,
          input.diagnostics,
        ),
      ),
    writeReport: (path, report) => writeRunReport(path, report, adapters.writeTextFile),
  });
}

function validatedRunFromArtifact(artifact: WorkflowArtifact): ValidatedRun {
  return Object.freeze({
    snapshot: artifact.snapshot,
    notificationLedger: artifact.notificationLedger,
    notificationSelection: artifact.notificationSelection,
  });
}

async function persistWorkflowState(
  adapters: ProductionRuntimeAdapters,
  command: PersistStateCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  for (const entry of artifact.aiCacheEntries) {
    await session.aiCache.write(entry);
  }
  await session.persist({
    snapshot: artifact.snapshot,
    notificationLedger: artifact.notificationLedger,
    runReport: artifact.stateRunReport,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    knownSecrets: [],
  });
}

async function buildWorkflowPages(
  adapters: ProductionRuntimeAdapters,
  command: BuildPagesCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  if (pagesUrl(config) !== artifact.pagesUrl) {
    throw new TypeError("workflow artifactと現在の設定でPages URLが一致しません");
  }
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (
    persistedSnapshot.status === "missing_branch" ||
    persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id
  ) {
    throw new TypeError("Pages生成対象のrunがtracker-state branchにありません");
  }
  const historyRecords = await session.loadHistoryRecords();
  await buildPublicPages(
    adapters,
    config,
    workflowArtifactRepositoryInventory(artifact),
    validatedRunFromArtifact(artifact),
    historyRecords,
    resolve(adapters.repositoryPath, command.outputDirectory),
    [],
  );
}

async function notifyWorkflowDiscord(
  adapters: ProductionRuntimeAdapters,
  command: NotifyDiscordCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  await deliverDiscord(
    adapters,
    artifact.discordSettings,
    validatedRunFromArtifact(artifact),
    command.pagesUrl,
  );
}

function createWorkflowStageRunner(adapters: ProductionRuntimeAdapters): WorkflowStageRunner {
  return new WorkflowStageRunner({
    persistState: (command) => persistWorkflowState(adapters, command),
    buildPages: (command) => buildWorkflowPages(adapters, command),
    notifyDiscord: (command) => notifyWorkflowDiscord(adapters, command),
  });
}

function emptyOfflineMetrics(): OfflineAnalysisMetrics {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    estimatedInputTokens: 0,
    staleRepositoryCount: 0,
  });
}

function createOfflineRunner(adapters: ProductionRuntimeAdapters): OfflineRunRunner {
  return new OfflineRunRunner(
    {
      engine: {
        replayFixture: (fixture: ReplayFixture): Promise<OfflineAnalysisResult> => {
          const goldenInput = goldenEvalInputSchema.safeParse(fixture.input);
          if (!goldenInput.success) {
            return Promise.resolve(
              Object.freeze({
                status: "success",
                output: fixture.input,
                metrics: emptyOfflineMetrics(),
                diagnostics: Object.freeze([]),
              }),
            );
          }
          const analysis = analyzeGoldenFixture(goldenInput.data);
          return Promise.resolve(
            Object.freeze({
              status: "success",
              output: analysis.output,
              metrics: analysis.metrics,
              diagnostics: analysis.diagnostics,
            }),
          );
        },
        replayState: (state): Promise<OfflineAnalysisResult> =>
          Promise.resolve(
            Object.freeze({
              status: "success",
              output: state,
              metrics: Object.freeze({
                ...emptyOfflineMetrics(),
                repositoryCount: state.repositories.length,
                itemCount: state.items.length,
                activeEdgeCount: state.relations.filter((relation) => relation.active).length,
                staleRepositoryCount: state.repositories.filter(
                  (repository) => repository.freshness === "stale",
                ).length,
              }),
              diagnostics: Object.freeze([]),
            }),
          ),
      },
      readReplayFixture: adapters.readReplayFixture,
      readState: adapters.readReplayState,
      readGoldenFixtures: adapters.readGoldenFixtures,
      writeArtifact: adapters.writeJsonArtifact,
      writeReport: (path, report) => writeRunReport(path, report, adapters.writeTextFile),
    },
    {
      now: adapters.now,
    },
  );
}

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createProductionCliApplication(
  adapters: ProductionRuntimeAdapters,
): CliApplication<ProductionTypes> {
  return new CliApplication({
    dailyRunner: new DailyTransactionRunner(createDailyDependencies(adapters), {
      now: adapters.now,
    }),
    workflowStageRunner: createWorkflowStageRunner(adapters),
    offlineRunner: createOfflineRunner(adapters),
    writeStandardOutput: adapters.writeStandardOutput,
  });
}

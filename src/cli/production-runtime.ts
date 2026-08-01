import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createCodexEnvironment,
  createCodexAnalysisInput,
  estimateAiInputCost,
  getCodexEnvironmentVariableAllowlist,
  reduceCodexAnalysis,
  runAiAnalyses,
  serializeCanonicalJson,
  type executeCodexAnalysis,
  type AiAnalysisCandidate,
  type AiAnalysisRunResult,
  type CodexAnalysisInput,
  type CodexAnalysisReduction,
  type CodexProcessRunner,
  type DeterministicCodexDecision,
  type ReducedCodexDecision,
  type ValidatedCodexAnalysisOutput,
} from "../codex/index.js";
import { type Config, type loadConfig } from "../config/index.js";
import {
  createUtcIsoDateTime,
  createGitHubNodeId,
  createGitHubBotPredicate,
  createLabelEffectsResolver,
  calculateStaleness,
  recalculateStalenessSeverity,
  determineIssueState,
  determineMeaningfulProgress,
  determinePullRequestState,
  determineTerminalRetention,
  determineTrackedItemWork,
  isTerminalStatus,
  resolveTrackingStartAt,
  resolveRepositoryTeams,
  selectTrackingItems,
  type LabelRule,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type GraphNodeId,
  type IssueBlocker,
  type IssueExplicitRequestAssessment,
  type IssueExplicitRequestTarget,
  type IssueStateDecision,
  type BlockedParentContext,
  type BlockerRanking,
  type OrganizationTrackingCandidate,
  type TrackingCandidate,
  type PullRequestStateDecision,
  type PullRequestCheckFailureAssessment,
  type PrimaryWaitingOn,
  type Relation,
  type Repository,
  type SourceId,
  type Severity,
  type StalenessSeverityContext,
  type StalenessWaitClass,
  type StalenessResult,
  type NaturalLanguageProgressAssessment,
  type DependencyResolutionProgress,
  type ExternalGhostNode,
  type TrackedItem,
  type TrackingConnection,
  type TrackingRunCompletion,
  type TrackingStartAtState,
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
  type DiscordOperationsIncident,
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
  type PagesPublicSafetyInput,
} from "../pages/index.js";
import {
  createStateNotificationLedger,
  createStateRunReport,
  createStateSnapshot,
  type StatePersistenceSession,
  type PersistStateTransactionResult,
  type SnapshotAiState,
  type SnapshotCollectionItem,
  type SnapshotCollectionRepository,
  type SnapshotRepository,
  type SnapshotTrackedItem,
  type StateBranchAdapter,
  type StateNotificationLedger,
  type StateRunReport,
  type StateHistoryRecord,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { CliApplication } from "./application.js";
import { createTrackingBackfillRequest } from "./backfill.js";
import {
  type BuildPagesCliCommand,
  type NotifyDiscordCliCommand,
  type NotifyOperationsCliCommand,
  type PersistStateCliCommand,
} from "./command.js";
import { type OnlineCliCommand } from "./daily-transaction.js";
import {
  DailyTransactionRunner,
  type DailyTransactionDependencies,
  type DailyTransactionTypeMap,
  type DailyRunInvocation,
} from "./daily-transaction.js";
import { CliCodexAuthenticationError, CliCredentialsError, CliExecutableError } from "./errors.js";
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
const GITHUB_MENTION_PATTERN =
  /(?<![A-Za-z0-9-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99})))?/gu;

type EnabledCodexCredentials = Readonly<{
  enabled: true;
  authentication: Config["ai"]["authentication"];
  environment: Readonly<Record<string, string>>;
}>;

type RuntimeCodexCredentials =
  | Readonly<{
      enabled: false;
    }>
  | EnabledCodexCredentials;

type RuntimeCredentials = Readonly<{
  github: GitHubAppCredentials;
  codex: RuntimeCodexCredentials;
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
  externalReferences: readonly ExternalGhostNode[];
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

type MentionedWaitingOnCandidate = Readonly<{
  id: string;
  kind: "user" | "team";
  sourceIds: readonly [SourceId, ...SourceId[]];
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
  primaryWaitingOn: PrimaryWaitingOn;
  staleness: StalenessResult;
}>;

type TrackedItemStaleness = Readonly<{
  severity: Severity;
  waitClass: StalenessWaitClass;
  severityContext: StalenessSeverityContext;
}>;

type ReducedAnalysis = Readonly<{
  items: readonly TrackedItem[];
  currentItems: readonly ReducedItemAnalysis[];
  stalenessByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemStaleness>;
  relationAssessments: readonly RelationCandidateAssessment[];
  runStatus: "success" | "fallback";
}>;

type GraphResult = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  externalReferences: readonly ExternalGhostNode[];
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

function readCodexCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
  config: Config,
): RuntimeCodexCredentials {
  if (!config.ai.enabled) {
    return Object.freeze({
      enabled: false,
    });
  }
  const authentication = config.ai.authentication;
  requireEnvironmentVariables(environment, getCodexEnvironmentVariableAllowlist(authentication));
  return Object.freeze({
    enabled: true,
    authentication,
    environment: createCodexEnvironment(authentication, environment),
  });
}

function codexKnownSecrets(credentials: RuntimeCodexCredentials): readonly string[] {
  if (!credentials.enabled) {
    return Object.freeze([]);
  }
  switch (credentials.authentication) {
    case "api-key": {
      const openAiApiKey = credentials.environment["OPENAI_API_KEY"];
      assertNonNullable(openAiApiKey, "組み立て済みCodex環境にOPENAI_API_KEYがありません");
      return Object.freeze([openAiApiKey]);
    }
    case "auth-json":
      return Object.freeze([]);
    default:
      throw new UnreachableError(credentials.authentication);
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
  const codex = readCodexCredentials(environment, config);
  const knownSecrets = [github.privateKey, ...codexKnownSecrets(codex)];
  if (
    command.kind !== "dry-run" &&
    command.kind !== "collect-analyze" &&
    config.notifications.discord.enabled
  ) {
    knownSecrets.push(
      requireEnvironmentValue(environment, config.notifications.discord.webhookSecretName),
      requireEnvironmentValue(
        environment,
        config.notifications.discord.operationsWebhookSecretName,
      ),
    );
  }
  return Object.freeze({
    github,
    codex,
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

async function assertCodexAuthenticationAvailable(
  credentials: EnabledCodexCredentials,
): Promise<void> {
  switch (credentials.authentication) {
    case "api-key":
      return;
    case "auth-json": {
      const codexHome = credentials.environment["CODEX_HOME"];
      assertNonNullable(codexHome, "組み立て済みCodex環境にCODEX_HOMEがありません");
      try {
        const authJsonStat = await stat(join(codexHome, "auth.json"));
        if (!authJsonStat.isFile()) {
          throw new TypeError("CODEX_HOME直下のauth.jsonがファイルではありません");
        }
      } catch (error: unknown) {
        throw new CliCodexAuthenticationError({ cause: error });
      }
      return;
    }
    default:
      throw new UnreachableError(credentials.authentication);
  }
}

async function assertCodexCliAvailable(
  adapters: ProductionRuntimeAdapters,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  let result: Awaited<ReturnType<CodexProcessRunner>>;
  try {
    result = await adapters.codexProcessRunner({
      command: "codex",
      arguments: ["--version"],
      workingDirectory: adapters.repositoryPath,
      environment,
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
      aiAnalysisFingerprint: Object.freeze({
        status: "unavailable",
      }),
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
    aiAnalysisFingerprint: Object.freeze({
      status: "unavailable",
    }),
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
  const snapshot = previousSnapshot(state);
  const trackedNodeIds = new Set<string>(snapshot?.items.map((item) => item.nodeId) ?? []);
  for (const relation of snapshot?.relations ?? []) {
    if (!relation.active) {
      continue;
    }
    if (trackedNodeIds.has(relation.fromNodeId)) {
      nodeIds.add(createGitHubNodeId(relation.fromNodeId));
    }
    if (trackedNodeIds.has(relation.toNodeId)) {
      nodeIds.add(createGitHubNodeId(relation.toNodeId));
    }
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
  repositoryId: GitHubRepositoryId,
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
    const sourceId = candidate.sourceIds[0];
    assertNonNullable(sourceId, `関係候補 ${candidate.id}のsource IDがありません`);
    switch (candidate.relation.type) {
      case "blocks":
        connections.push(
          Object.freeze({
            kind: "native_dependency",
            sourceId,
            blockerNodeId: candidate.relation.blocker.nodeId,
            blockedNodeId: candidate.relation.blocked.nodeId,
          }),
        );
        break;
      case "parent_of":
        if (candidate.authority === "authoritative") {
          connections.push(
            Object.freeze({
              kind: "native_sub_issue",
              sourceId,
              parentNodeId: candidate.relation.parent.nodeId,
              subIssueNodeId: candidate.relation.subtask.nodeId,
            }),
          );
          break;
        }
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.parent.nodeId,
            referencedNodeId: candidate.relation.subtask.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "parent_of",
            }),
          }),
        );
        break;
      case "implements":
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.implementation.nodeId,
            referencedNodeId: candidate.relation.target.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "implements",
            }),
          }),
        );
        break;
      case "unclassified":
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.referencing.nodeId,
            referencedNodeId: candidate.relation.referenced.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "related_to",
            }),
          }),
        );
        break;
      default:
        throw new UnreachableError(candidate.relation);
    }
  }
  return Object.freeze(connections);
}

function resolveProductionTrackingStartAt(
  config: Config,
  previousState: TrackingStartAtState,
  run: TrackingRunCompletion,
): TrackingStartAtState {
  const configured = config.tracking.startAt;
  return resolveTrackingStartAt({
    configuredStartAt:
      configured == null
        ? Object.freeze({
            status: "not_configured",
          })
        : Object.freeze({
            status: "configured",
            value: createUtcIsoDateTime(configured),
          }),
    previousState,
    run,
  });
}

function trackingSelectionStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  invocation: DailyRunInvocation,
): UtcIsoDateTime {
  const resolved = resolveProductionTrackingStartAt(
    configuration.config,
    previousSnapshot(state)?.trackingStartAt ??
      Object.freeze({
        status: "not_fixed",
      }),
    Object.freeze({
      outcome: "incomplete",
      finishedAt: invocation.startedAt,
    }),
  );
  if (resolved.status === "not_fixed") {
    return invocation.startedAt;
  }
  return resolved.value;
}

function pendingSnapshotTrackingStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  invocation: DailyRunInvocation,
): TrackingStartAtState {
  return resolveProductionTrackingStartAt(
    configuration.config,
    previousSnapshot(state)?.trackingStartAt ??
      Object.freeze({
        status: "not_fixed",
      }),
    Object.freeze({
      outcome: "incomplete",
      finishedAt: invocation.startedAt,
    }),
  );
}

function completedSnapshotTrackingStartAt(
  config: Config,
  snapshot: StateSnapshot,
  completedAt: UtcIsoDateTime,
): TrackingStartAtState {
  const resolved = resolveProductionTrackingStartAt(
    config,
    snapshot.trackingStartAt,
    Object.freeze({
      outcome: "complete_success",
      finishedAt: completedAt,
    }),
  );
  if (resolved.status !== "fixed") {
    throw new TypeError("完全成功したrunでtracking.startAtを確定できませんでした");
  }
  return resolved;
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
  const organizationCandidates: OrganizationTrackingCandidate[] = enumeratedItems.map((item) => {
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
  const externalCandidates = deduplicateByStableId(
    relationCandidates.flatMap((candidate) =>
      relationNodes(candidate.relation).flatMap((node) =>
        node.scope === "external_public"
          ? [
              Object.freeze({
                scope: "external_public",
                nodeId: node.nodeId,
                repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                number: node.number,
                url: node.url,
                title: `${node.repositoryOwner}/${node.repositoryName}#${node.number.toString()}`,
                state: node.state,
              } satisfies TrackingCandidate),
            ]
          : [],
      ),
    ),
    (candidate) => candidate.nodeId,
  );
  const candidates: readonly TrackingCandidate[] = Object.freeze([
    ...organizationCandidates,
    ...externalCandidates,
  ]);
  const result = selectTrackingItems({
    startAt: trackingSelectionStartAt(configuration, state, invocation),
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

function mentionedCandidatesInSource(
  sourceId: SourceId,
  content: string,
): readonly MentionedWaitingOnCandidate[] {
  const candidates = new Map<string, MentionedWaitingOnCandidate>();
  for (const match of content.matchAll(GITHUB_MENTION_PATTERN)) {
    const accountOrOrganization = match[1];
    assertNonNullable(accountOrOrganization, "GitHub mentionのaccountを取得できませんでした");
    const teamSlug = match[2];
    const kind = teamSlug == null ? "user" : "team";
    const id = teamSlug == null ? accountOrOrganization : `${accountOrOrganization}/${teamSlug}`;
    candidates.set(
      `${kind}:${id.toLowerCase()}`,
      Object.freeze({
        id,
        kind,
        sourceIds: Object.freeze([sourceId] satisfies [SourceId]),
      }),
    );
  }
  return Object.freeze([...candidates.values()]);
}

function createMentionedWaitingOnCandidates(
  detail: GitHubItemDetail,
): readonly MentionedWaitingOnCandidate[] {
  const sourceCandidates = [
    ...mentionedCandidatesInSource(detail.bodySourceId, detail.body),
    ...detail.comments.flatMap((comment) =>
      mentionedCandidatesInSource(comment.sourceId, comment.body),
    ),
  ];
  const grouped = new Map<
    string,
    Readonly<{
      id: string;
      kind: MentionedWaitingOnCandidate["kind"];
      sourceIds: Set<SourceId>;
    }>
  >();
  for (const candidate of sourceCandidates) {
    const key = `${candidate.kind}:${candidate.id.toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(
        key,
        Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          sourceIds: new Set(candidate.sourceIds),
        }),
      );
      continue;
    }
    for (const sourceId of candidate.sourceIds) {
      existing.sourceIds.add(sourceId);
    }
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((candidate) => {
        const sourceIds = [...candidate.sourceIds].sort();
        const firstSourceId = sourceIds[0];
        assertNonNullable(firstSourceId, `mention候補 ${candidate.id}のsource IDがありません`);
        return Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          sourceIds: Object.freeze([firstSourceId, ...sourceIds.slice(1)] satisfies [
            SourceId,
            ...SourceId[],
          ]),
        } satisfies MentionedWaitingOnCandidate);
      }),
  );
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

function relationAssessmentOwnerNodeId(candidate: RelationCandidate): GraphNodeId {
  switch (candidate.relation.type) {
    case "blocks":
      return candidate.relation.blocked.nodeId;
    case "parent_of":
      return candidate.relation.parent.nodeId;
    case "implements":
      return candidate.relation.implementation.nodeId;
    case "unclassified":
      return candidate.relation.referencing.nodeId;
  }
}

function createCodexInput(
  invocation: DailyRunInvocation,
  analysis: DeterministicItemAnalysis,
): CodexAnalysisInput {
  const relationCandidates = deduplicateByStableId(
    analysis.relationCandidates.filter(
      (candidate) => relationAssessmentOwnerNodeId(candidate) === analysis.item.nodeId,
    ),
    (candidate) => candidate.id,
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(analysis.detail);
  const waitingOnCandidates = new Map(
    analysis.decision.waitingOn.map((waitingOn) => [
      waitingOn.candidateId,
      Object.freeze({
        id: waitingOn.candidateId,
        kind: waitingOn.kind,
        sourceIds: waitingOn.sourceIds,
      }),
    ]),
  );
  const authorCandidateId = codexAuthorCandidateId(analysis.item);
  waitingOnCandidates.set(
    authorCandidateId,
    Object.freeze({
      id: authorCandidateId,
      kind: "user",
      sourceIds: Object.freeze([analysis.item.sourceId] satisfies [SourceId]),
    }),
  );
  for (const candidate of mentionedCandidates) {
    waitingOnCandidates.set(candidate.id, candidate);
  }
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
  if (
    analysis.detail.type === "pull_request" &&
    analysis.detail.mergeState.checks.status === "configured"
  ) {
    const checks = analysis.detail.mergeState.checks;
    sourceRecords.set(
      checks.sourceId,
      Object.freeze({
        id: checks.sourceId,
        kind: "required_check_rollup",
        actorType: "system",
        createdAt: analysis.item.observedAt,
        combinedState: checks.combinedState,
      }),
    );
    for (const context of checks.contexts) {
      sourceRecords.set(
        context.sourceId,
        Object.freeze({
          id: context.sourceId,
          kind: context.type,
          actorType: "system",
          createdAt:
            context.type === "commit_status" ? context.createdAt : analysis.item.observedAt,
          ...(context.type === "check_run"
            ? {
                name: context.name,
                status: context.status,
                conclusion: context.conclusion,
              }
            : {
                context: context.context,
                state: context.state,
              }),
        }),
      );
    }
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
      waitingOn: [...waitingOnCandidates.values()],
      relations: relationCandidates.map((candidate) => ({
        id: candidate.id,
        targetUrl: relationTargetUrl(analysis.item.nodeId, candidate),
      })),
    },
    sources: [...sourceRecords.values()],
    deterministicSignals: {
      status: analysis.decision.status,
      waitingOn: analysis.decision.waitingOn,
      relationCandidateIds: relationCandidates.map((candidate) => candidate.id),
      mentionedWaitingOnCandidates: mentionedCandidates,
      requiredCheckFailure:
        analysis.detail.type === "pull_request" &&
        analysis.detail.mergeState.checks.status === "configured" &&
        (analysis.detail.mergeState.checks.combinedState === "failure" ||
          analysis.detail.mergeState.checks.combinedState === "error")
          ? analysis.detail.mergeState.checks
          : null,
      uncertainties: analysis.decision.uncertainties,
    },
    priorAnalysis: null,
  });
}

function createAiCandidates(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
): Readonly<{
  candidates: readonly AiAnalysisCandidate[];
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
}> {
  const inputByNodeId = new Map<GitHubNodeId, CodexAnalysisInput>();
  const previousGraph = previousGraphSnapshot(state);
  const previousGraphAnalysis =
    previousGraph == null
      ? undefined
      : analyzeGraph({
          current: previousGraph,
          previous: {
            availability: "unavailable",
          },
        });
  const previousImpactByNodeId = new Map(
    (previousGraphAnalysis?.downstreamImpacts ?? []).map((impact) => [impact.nodeId, impact]),
  );
  const previousRelations = previousSnapshot(state)?.relations ?? [];
  const previousAiFingerprintByNodeId = new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item.aiAnalysisFingerprint] as const),
    ),
  );
  const candidates = deterministicAnalysis.items.map((analysis) => {
    const input = createCodexInput(invocation, analysis);
    inputByNodeId.set(analysis.item.nodeId, input);
    const naturalLanguageProgressCandidate = analysis.item.events.some(
      (event) => event.kind === "comment" && event.actor.type === "human",
    );
    const previousIncomingBlockers = new Set<string>(
      previousRelations
        .filter(
          (relation) =>
            relation.active &&
            relation.type === "blocks" &&
            relation.toNodeId === analysis.item.nodeId,
        )
        .map((relation) => relation.id),
    );
    const currentPotentialBlockers = new Set<string>(
      analysis.relationCandidates
        .filter((candidate) => {
          if (candidate.relation.type === "blocks") {
            return candidate.relation.blocked.nodeId === analysis.item.nodeId;
          }
          return candidate.authority === "inferred";
        })
        .map((candidate) => candidate.id),
    );
    const relatedNodeChanged = analysis.relationCandidates.some((candidate) =>
      relationNodes(candidate.relation).some(
        (node) =>
          node.nodeId !== analysis.item.nodeId &&
          node.scope === "organization" &&
          collection.changedNodeIds.has(node.nodeId),
      ),
    );
    const changedBlocker =
      relatedNodeChanged ||
      previousIncomingBlockers.size !== currentPotentialBlockers.size ||
      [...previousIncomingBlockers].some((id) => !currentPotentialBlockers.has(id));
    const previousImpact = previousImpactByNodeId.get(analysis.item.nodeId);
    const estimatedCost = estimateAiInputCost(
      `${serializeCanonicalJson(input)}\n`,
      configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
    );
    return Object.freeze({
      id: analysis.item.nodeId,
      deterministicResolution:
        analysis.decision.determination === "determined" &&
        !naturalLanguageProgressCandidate &&
        analysis.relationCandidates.every((candidate) => candidate.authority === "authoritative")
          ? "high_confidence"
          : "ambiguous",
      input,
      graphNeighborhood: Object.freeze(
        analysis.relationCandidates.map((candidate) => candidate.id),
      ),
      previousFingerprint:
        previousAiFingerprintByNodeId.get(analysis.item.nodeId) ??
        Object.freeze({
          status: "unavailable",
        }),
      priority: Object.freeze({
        severityCandidate: analysis.decision.determination === "codex_candidate",
        ownerUnknown: analysis.decision.waitingOn.some((waitingOn) => waitingOn.kind === "unknown"),
        changedBlocker,
        downstreamImpact: Object.freeze({
          openNodeCount: previousImpact?.openNodeCount ?? 0,
          repositoryCount: previousImpact?.repositoryCount ?? 0,
        }),
      }),
      estimatedCostUsd: estimatedCost.estimatedCostUsd,
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
  collection: CollectedItems,
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
  const prepared = createAiCandidates(
    invocation,
    configuration,
    state,
    collection,
    deterministicAnalysis,
  );
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
  const codexCredentials = configuration.credentials.codex;
  if (!codexCredentials.enabled) {
    throw new TypeError("AIが有効ですがCodex認証情報がありません");
  }
  const run = await runAiAnalyses(
    prepared.candidates,
    {
      identity: {
        deterministicRulesVersion: "daily-rules-v1",
        model: configuration.config.ai.model,
        reasoningEffort: configuration.config.ai.execution.reasoningEffort,
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
            authentication: configuration.config.ai.authentication,
            model: configuration.config.ai.model,
            execution: configuration.config.ai.execution,
            retry: {
              initialDelaySeconds: configuration.config.operations.retry.initialDelaySeconds,
              maxDelaySeconds: configuration.config.operations.retry.maxDelaySeconds,
            },
          },
          {
            environment: codexCredentials.environment,
            processRunner: adapters.codexProcessRunner,
            runtime: {
              sleep: adapters.sleep,
              random: adapters.random,
            },
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

function codexOutputForAnalysis(
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): ValidatedCodexAnalysisOutput | undefined {
  return codexAnalysis.run?.results.find(
    (candidate) => candidate.candidateId === analysis.item.nodeId,
  )?.output;
}

function nonEmptySourceIds(
  sourceIds: readonly SourceId[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort();
  const firstSourceId = uniqueSourceIds[0];
  assertNonNullable(firstSourceId, `${context}のsource IDがありません`);
  return Object.freeze([firstSourceId, ...uniqueSourceIds.slice(1)]);
}

function explicitRequestAssessment(
  item: Extract<FreshObservedGitHubItem, Readonly<{ type: "issue" }>>,
  detail: Extract<GitHubItemDetail, Readonly<{ type: "issue" }>>,
  output: ValidatedCodexAnalysisOutput | undefined,
): IssueExplicitRequestAssessment {
  const candidates = createIssueRequestCandidates(item, detail);
  if (output == null || candidates.length === 0) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const candidateSourceIds = nonEmptySourceIds(
    candidates.map((candidate) => candidate.sourceId),
    "明示依頼候補",
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(detail);
  const mentionedByKey = new Map(
    mentionedCandidates.map((candidate) => [
      `${candidate.kind}:${candidate.id.toLowerCase()}`,
      candidate,
    ]),
  );
  const targets: IssueExplicitRequestTarget[] = output.waitingOn.flatMap((waitingOn) => {
    if (waitingOn.kind !== "user" && waitingOn.kind !== "team") {
      return [];
    }
    const mentioned = mentionedByKey.get(
      `${waitingOn.kind}:${waitingOn.candidateId.toLowerCase()}`,
    );
    if (
      mentioned == null ||
      !waitingOn.sourceIds.some((sourceId) => mentioned.sourceIds.includes(sourceId))
    ) {
      return [];
    }
    const role =
      waitingOn.role === "dependency" ||
      waitingOn.role === "merge_decider" ||
      waitingOn.role === "ci"
        ? "unknown"
        : waitingOn.role;
    return [
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role,
        sourceIds: waitingOn.sourceIds,
        confidence: Math.min(output.confidence, waitingOn.confidence),
      }),
    ];
  });
  if (targets.length === 0) {
    return Object.freeze({
      status: "assessed",
      candidateSourceIds,
      verdict: "no_unanswered_request",
      confidence: output.confidence,
      sourceIds: candidateSourceIds,
    });
  }
  const requestCandidate = [...candidates]
    .filter((candidate) => targets.some((target) => target.sourceIds.includes(candidate.sourceId)))
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt > right.occurredAt ? -1 : 1;
      }
      return left.sourceId.localeCompare(right.sourceId);
    })[0];
  assertNonNullable(requestCandidate, "未回答の明示依頼に対応する候補がありません");
  const latestTargets = targets.filter((target) =>
    target.sourceIds.includes(requestCandidate.sourceId),
  );
  const firstTarget = latestTargets[0];
  assertNonNullable(firstTarget, "最新の明示依頼先がありません");
  return Object.freeze({
    status: "assessed",
    candidateSourceIds,
    verdict: "unanswered_request",
    requestSourceId: requestCandidate.sourceId,
    targets: Object.freeze([firstTarget, ...latestTargets.slice(1)] satisfies [
      IssueExplicitRequestTarget,
      ...IssueExplicitRequestTarget[],
    ]),
    confidence: Math.min(output.confidence, ...latestTargets.map((target) => target.confidence)),
    sourceIds: nonEmptySourceIds(
      latestTargets.flatMap((target) => target.sourceIds),
      "未回答の明示依頼判定",
    ),
  });
}

function checkFailureSourceIds(
  detail: Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>>,
): readonly [SourceId, ...SourceId[]] | undefined {
  if (
    detail.mergeState.checks.status !== "configured" ||
    (detail.mergeState.checks.combinedState !== "failure" &&
      detail.mergeState.checks.combinedState !== "error")
  ) {
    return undefined;
  }
  const failingContextSourceIds = detail.mergeState.checks.contexts.flatMap((context) => {
    if (context.type === "commit_status") {
      return context.state === "failure" || context.state === "error" ? [context.sourceId] : [];
    }
    return context.conclusion === "failure" ||
      context.conclusion === "timed_out" ||
      context.conclusion === "startup_failure" ||
      context.conclusion === "action_required"
      ? [context.sourceId]
      : [];
  });
  return nonEmptySourceIds(
    [detail.mergeState.checks.sourceId, ...failingContextSourceIds],
    "required check失敗",
  );
}

function checkFailureAssessment(
  detail: Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>>,
  output: ValidatedCodexAnalysisOutput | undefined,
): PullRequestCheckFailureAssessment {
  const sourceIds = checkFailureSourceIds(detail);
  if (sourceIds == null || output == null) {
    return Object.freeze({
      cause: "not_assessed",
    });
  }
  const effectiveConfidence = Math.min(
    output.confidence,
    ...output.waitingOn.map((waitingOn) => waitingOn.confidence),
  );
  const authorAction =
    output.status === "waiting_for_author" ||
    output.waitingOn.some((waitingOn) => waitingOn.role === "author");
  if (authorAction) {
    return Object.freeze({
      cause: "pull_request_change",
      confidence: effectiveConfidence,
      sourceIds,
    });
  }
  const infrastructureOrFlaky =
    output.status === "waiting_for_automation" ||
    output.status === "needs_maintainer_decision" ||
    output.status === "unknown" ||
    output.waitingOn.some(
      (waitingOn) =>
        waitingOn.kind === "automation" ||
        waitingOn.kind === "unknown" ||
        waitingOn.role === "ci" ||
        waitingOn.role === "maintainer" ||
        waitingOn.role === "unknown",
    );
  return Object.freeze({
    cause: infrastructureOrFlaky ? "infrastructure_or_flaky" : "ambiguous",
    confidence: effectiveConfidence,
    sourceIds,
  });
}

function naturalLanguageProgressAssessments(
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput | undefined,
): readonly NaturalLanguageProgressAssessment[] {
  if (output == null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    analysis.item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) =>
        Object.freeze({
          candidateSourceId: event.sourceId,
          verdict:
            output.progress.latestMeaningfulSourceId === event.sourceId
              ? "meaningful_progress"
              : "not_meaningful_progress",
          confidence: Math.min(output.confidence, output.progress.confidence),
          sourceIds: Object.freeze([event.sourceId] satisfies [SourceId]),
        }),
      ),
  );
}

function graphNodeState(
  state: RuntimeState,
  deterministicAnalysis: DeterministicAnalysis,
  graph: GraphResult,
  nodeId: GraphNodeId,
): TrackedItem["state"] {
  const currentItem = deterministicAnalysis.items.find(
    (analysis) => analysis.item.nodeId === nodeId,
  )?.item;
  if (currentItem != null) {
    return currentItem.state;
  }
  const externalReference = graph.externalReferences.find(
    (reference) => reference.nodeId === nodeId,
  );
  if (externalReference != null) {
    return externalReference.state;
  }
  const previousItem = previousSnapshot(state)?.items.find((item) => item.nodeId === nodeId);
  assertNonNullable(previousItem, `blocker ${nodeId}の状態がありません`);
  return previousItem.state;
}

function graphBlockers(
  state: RuntimeState,
  deterministicAnalysis: DeterministicAnalysis,
  graph: GraphResult,
  nodeId: GitHubNodeId,
): readonly IssueBlocker[] {
  return Object.freeze(
    graph.edges
      .filter((edge) => edge.active && edge.type === "blocks" && edge.toNodeId === nodeId)
      .map((edge) =>
        Object.freeze({
          candidateId: edge.fromNodeId,
          state: graphNodeState(state, deterministicAnalysis, graph, edge.fromNodeId),
          authority: edge.authoritative ? "authoritative" : "inferred",
          confidence: edge.confidence,
          sourceIds: nonEmptySourceIds(
            edge.evidence.map((evidence) => evidence.sourceId),
            `blocker edge ${edge.id}`,
          ),
          becameBlockingAt: edge.firstSeenAt,
        }),
      ),
  );
}

function reassessDeterministicAnalysis(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  deterministicAnalysis: DeterministicAnalysis,
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput | undefined,
  graph: GraphResult | undefined,
): DeterministicItemAnalysis {
  const repository = findRepository(inventory, analysis.item.repositoryId);
  const teams = resolveRepositoryTeams(
    repositoryFullName(repository),
    configuration.config.teams,
    inventory.teams,
  );
  const blockers =
    graph == null
      ? createNativeBlockers(analysis.item, analysis.relationCandidates)
      : graphBlockers(state, deterministicAnalysis, graph, analysis.item.nodeId);
  if (analysis.item.type === "issue" && analysis.detail.type === "issue") {
    return Object.freeze({
      ...analysis,
      decision: determineIssueState({
        issue: analysis.item,
        blockers,
        explicitRequestCandidates: createIssueRequestCandidates(analysis.item, analysis.detail),
        explicitRequestAssessment: explicitRequestAssessment(
          analysis.item,
          analysis.detail,
          output,
        ),
        teams,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: invocation.startedAt,
      }),
    });
  }
  if (analysis.item.type === "pull_request" && analysis.detail.type === "pull_request") {
    const resolveLabelEffects = createLabelEffectsResolver(
      normalizeLabelRules(configuration.config),
    );
    return Object.freeze({
      ...analysis,
      decision: determinePullRequestState({
        pullRequest: analysis.item,
        blockers,
        checkFailureAssessment: checkFailureAssessment(analysis.detail, output),
        labelEffects: resolveLabelEffects(repositoryFullName(repository), analysis.item.labels),
        teams,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: invocation.startedAt,
      }),
    });
  }
  throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${analysis.item.nodeId}`);
}

function dependencyResolutions(
  invocation: DailyRunInvocation,
  state: RuntimeState,
  graph: GraphResult | undefined,
  nodeId: GitHubNodeId,
): readonly DependencyResolutionProgress[] {
  if (graph?.analysis.newlyUnblockedNodeIds.includes(nodeId) !== true) {
    return Object.freeze([]);
  }
  const sourceIds = [...(previousSnapshot(state)?.relations ?? []), ...graph.edges]
    .filter((edge) => edge.type === "blocks" && edge.toNodeId === nodeId)
    .flatMap((edge) => edge.evidence.map((evidence) => evidence.sourceId));
  if (sourceIds.length === 0) {
    throw new TypeError(`newly unblocked項目 ${nodeId}の依存解消根拠がありません`);
  }
  return Object.freeze([
    Object.freeze({
      occurredAt: invocation.startedAt,
      sourceIds: nonEmptySourceIds(sourceIds, `newly unblocked項目 ${nodeId}`),
    }),
  ]);
}

function primaryWaitingOnForDecision(
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
): PrimaryWaitingOn {
  if (decision.origin === "deterministic") {
    return deterministicDecision.primaryWaitingOn;
  }
  if (decision.waitingOn.length === 0) {
    return Object.freeze({
      index: "not_applicable",
      selectionReason: "Codex判定にwaitingOnがないためprimaryはありません",
    });
  }
  return Object.freeze({
    index: 0,
    selectionReason: "Codexが返したwaitingOnの優先順でprimaryを選定しました",
  });
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
  primaryWaitingOn: PrimaryWaitingOn,
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
    primaryWaitingOn,
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
  graph: GraphResult | undefined,
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
  const previousGraph = previousGraphSnapshot(state);
  const previousImpact =
    previousGraph == null
      ? Object.freeze([])
      : analyzeGraph({
          current: previousGraph,
          previous: {
            availability: "unavailable",
          },
        }).downstreamImpacts;
  const downstreamImpactByNodeId = new Map<string, number>(
    (graph?.analysis.downstreamImpacts ?? previousImpact).map((impact) => [
      impact.nodeId,
      impact.openNodeCount,
    ]),
  );
  const createRanking = (waitingOn: ReducedCodexDecision["waitingOn"][number]): BlockerRanking =>
    Object.freeze({
      candidateId: waitingOn.candidateId,
      severity: previousSeverityByNodeId.get(waitingOn.candidateId) ?? "none",
      downstreamImpact: downstreamImpactByNodeId.get(waitingOn.candidateId) ?? 0,
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

function trackedItemStaleness(staleness: StalenessResult): TrackedItemStaleness {
  return Object.freeze({
    severity: staleness.severity,
    waitClass: staleness.waitClass,
    severityContext: staleness.severityContext,
  });
}

function recalculateTrackedItemStaleness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  item: SnapshotTrackedItem,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
): TrackedItemStaleness {
  const repository = findRepository(inventory, item.repositoryId);
  const recalculated = recalculateStalenessSeverity({
    evaluatedAt: invocation.startedAt,
    stallSince: item.stallSince,
    confidence: item.confidence,
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    repositoryFullName: repositoryFullName(repository),
    currentLabels: item.labels,
    resolveLabelEffects,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    severityContext: item.severityContext,
  });
  return Object.freeze({
    severity: recalculated.severity,
    waitClass: recalculated.waitClass,
    severityContext: recalculated.severityContext,
  });
}

function reduceAnalysisPass(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  graph: GraphResult | undefined,
): ReducedAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentItems: ReducedItemAnalysis[] = [];
  const items: TrackedItem[] = [];
  const stalenessByNodeId = new Map<GitHubNodeId, TrackedItemStaleness>();
  const relationAssessments: RelationCandidateAssessment[] = [];
  let runStatus: ReducedAnalysis["runStatus"] = "success";
  for (const originalAnalysis of deterministicAnalysis.items) {
    const output = codexOutputForAnalysis(originalAnalysis, codexAnalysis);
    const analysis = reassessDeterministicAnalysis(
      invocation,
      configuration,
      state,
      inventory,
      deterministicAnalysis,
      originalAnalysis,
      output,
      graph,
    );
    const reduction = reductionForAnalysis(configuration, analysis, codexAnalysis);
    const decision = reduction?.decision ?? reducedDeterministicDecision(analysis.decision);
    const primaryWaitingOn = primaryWaitingOnForDecision(analysis.decision, decision);
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
      dependencyResolutions: dependencyResolutions(invocation, state, graph, analysis.item.nodeId),
      naturalLanguageAssessments: naturalLanguageProgressAssessments(analysis, output),
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      repositoryFullName: repositoryFullName(repository),
      currentLabels: analysis.item.labels,
      resolveLabelEffects,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      blockedParentContext: blockedParentContext(state, decision, graph),
    });
    currentItems.push(
      Object.freeze({
        item: analysis.item,
        detail: analysis.detail,
        decision,
        primaryWaitingOn,
        staleness,
      }),
    );
    stalenessByNodeId.set(analysis.item.nodeId, trackedItemStaleness(staleness));
    items.push(createTrackedItem(invocation, analysis, decision, primaryWaitingOn, staleness));
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
      stalenessByNodeId.set(
        previousItem.nodeId,
        recalculateTrackedItemStaleness(
          invocation,
          configuration,
          inventory,
          previousItem,
          resolveLabelEffects,
        ),
      );
    }
  }
  if (stalenessByNodeId.size !== items.length) {
    throw new TypeError("全追跡項目のseverityを再計算できませんでした");
  }
  return Object.freeze({
    items: Object.freeze(items),
    currentItems: Object.freeze(currentItems),
    stalenessByNodeId,
    relationAssessments: Object.freeze(relationAssessments),
    runStatus,
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
  const initialReduction = reduceAnalysisPass(
    invocation,
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    undefined,
  );
  const provisionalGraph = reconcileCurrentGraph(
    invocation,
    configuration,
    state,
    collection,
    initialReduction,
  );
  return reduceAnalysisPass(
    invocation,
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    provisionalGraph,
  );
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

function externalGraphAnalysisNode(reference: ExternalGhostNode): GraphAnalysisNode {
  return Object.freeze({
    kind: reference.kind,
    nodeId: reference.nodeId,
    repositoryFullName: reference.repositoryFullName,
    state: reference.state,
    directNotification: reference.directNotification,
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
    nodes: Object.freeze([
      ...snapshot.items.map(graphAnalysisNode),
      ...snapshot.externalReferences.map(externalGraphAnalysisNode),
    ]),
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
  const candidates = collection.relationCandidates.filter((candidate) => {
    const nodes = relationNodes(candidate.relation);
    return (
      nodes.some((node) => node.scope === "organization" && nodeIds.has(node.nodeId)) &&
      nodes.every((node) => node.scope === "external_public" || nodeIds.has(node.nodeId))
    );
  });
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
  const referencedNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const externalReferencesByNodeId = new Map(
    [
      ...(previousSnapshot(state)?.externalReferences ?? []),
      ...collection.externalReferences,
      ...candidates.flatMap((candidate) =>
        relationNodes(candidate.relation).flatMap((node) =>
          node.scope === "external_public"
            ? [
                Object.freeze({
                  kind: "external_reference",
                  nodeId: node.nodeId,
                  repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                  number: node.number,
                  url: node.url,
                  title: `${node.repositoryOwner}/${node.repositoryName}#${node.number.toString()}`,
                  state: node.state,
                  recursiveTracking: "not_allowed",
                  directNotification: "not_eligible",
                } satisfies ExternalGhostNode),
              ]
            : [],
        ),
      ),
    ].map((reference) => [reference.nodeId, reference]),
  );
  const externalReferences = Object.freeze(
    [...externalReferencesByNodeId.values()]
      .filter((reference) => referencedNodeIds.has(reference.nodeId))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
  const graphNodes = [
    ...reduction.items.map(graphAnalysisNode),
    ...externalReferences.map(externalGraphAnalysisNode),
  ];
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
    externalReferences,
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
          expiresAt: createUtcIsoDateTime(entry.expiresAt),
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

type NotificationAnalysisState =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: ReducedItemAnalysis;
    }>;

function notificationDecisionBasis(
  item: TrackedItem,
  staleness: TrackedItemStaleness,
  analysisState: NotificationAnalysisState,
): DiscordNotificationItem["decisionBasis"] {
  if (analysisState.availability === "available") {
    return analysisState.value.decision.origin === "deterministic"
      ? Object.freeze({
          source: "deterministic",
        })
      : Object.freeze({
          source: "ai_only",
          confidence: analysisState.value.decision.confidence,
        });
  }
  return staleness.severityContext.decisionBasis === "deterministic"
    ? Object.freeze({
        source: "deterministic",
      })
    : Object.freeze({
        source: "ai_only",
        confidence: item.confidence,
      });
}

function notificationDraftState(
  item: TrackedItem,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
): DiscordNotificationItem["draftState"] {
  const observed = enumeratedItemsByNodeId.get(item.nodeId);
  assertNonNullable(observed, `通知対象 ${item.nodeId}の列挙値がありません`);
  if (observed.type !== item.type) {
    throw new TypeError(`通知対象 ${item.nodeId}の項目種別が前回値と一致しません`);
  }
  return observed.type === "issue"
    ? "not_applicable"
    : observed.draft
      ? "draft"
      : "ready_for_review";
}

function notificationItem(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  graph: GraphResult,
  item: TrackedItem,
  staleness: TrackedItemStaleness,
  analysisState: NotificationAnalysisState,
): DiscordNotificationItem {
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
    draftState: notificationDraftState(item, enumeratedItemsByNodeId),
    repositoryFreshness: "fresh",
    notificationClass: "standard",
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
    latestChange:
      analysisState.availability === "available"
        ? notificationLatestChange(analysisState.value, previous)
        : "none",
    decisionBasis: notificationDecisionBasis(item, staleness, analysisState),
    priorityWeight: labelEffects.priorityWeight,
    current: {
      status: item.status,
      waitingOn: item.waitingOn,
      severity: staleness.severity,
      waitClass: staleness.waitClass,
      statusSince: item.statusSince,
      ownerSince: item.ownerSince,
      stallSince: item.stallSince,
      lastProgressAt: item.lastProgressAt,
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

function notificationItems(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): readonly DiscordNotificationItem[] {
  const staleRepositoryIds = new Set<GitHubRepositoryId>(
    collection.repositoryResults
      .filter((result) => result.freshness === "stale")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    reduction.currentItems.map((current) => [current.item.nodeId, current]),
  );
  const enumeratedItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    reduction.items.flatMap((item) => {
      if (staleRepositoryIds.has(item.repositoryId)) {
        return [];
      }
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `通知対象 ${item.nodeId}のseverity再計算結果がありません`);
      const current = currentItemsByNodeId.get(item.nodeId);
      return [
        notificationItem(
          configuration,
          state,
          inventory,
          enumeratedItemsByNodeId,
          graph,
          item,
          staleness,
          current == null
            ? Object.freeze({
                availability: "not_available",
              })
            : Object.freeze({
                availability: "available",
                value: current,
              }),
        ),
      ];
    }),
  );
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

function snapshotAiState(config: Config, codexAnalysis: CodexAnalysis): SnapshotAiState {
  if (!config.ai.enabled) {
    if (codexAnalysis.run != null) {
      throw new TypeError("AIが無効ですがCodex分析結果があります");
    }
    return Object.freeze({
      enabled: false,
      available: false,
      degraded: false,
    });
  }
  const run = codexAnalysis.run;
  assertNonNullable(run, "AIが有効ですがCodex分析結果がありません");
  const degraded = run.failures.length > 0 || run.deferred.length > 0;
  if (run.failures.length === 0) {
    return Object.freeze({
      enabled: true,
      available: true,
      degraded,
    });
  }
  return Object.freeze({
    enabled: true,
    available: false,
    degraded: true,
  });
}

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): ValidatedRun {
  const previousCollectionItems = previousCollectionItemsByNodeId(state);
  const aiFingerprintByNodeId = new Map(
    (codexAnalysis.run?.results ?? []).map((result) => [
      result.candidateId,
      Object.freeze({
        status: "available",
        fingerprint: result.fingerprint,
      }),
    ]),
  );
  const persistedAiFingerprintNodeIds = new Set<string>();
  const snapshot = createStateSnapshot({
    schemaVersion: "1",
    generatedAt: invocation.startedAt,
    trackingStartAt: pendingSnapshotTrackingStartAt(configuration, state, invocation),
    ai: snapshotAiState(configuration.config, codexAnalysis),
    collection: {
      repositories: collection.collectionRepositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => {
          const currentFingerprint = aiFingerprintByNodeId.get(item.nodeId);
          if (currentFingerprint != null) {
            persistedAiFingerprintNodeIds.add(item.nodeId);
            return {
              ...item,
              aiAnalysisFingerprint: currentFingerprint,
            };
          }
          const previousItem = previousCollectionItems.get(item.nodeId);
          return {
            ...item,
            aiAnalysisFingerprint:
              previousItem == null
                ? item.aiAnalysisFingerprint
                : previousItem.aiAnalysisFingerprint,
          };
        }),
      })),
    },
    repositories: snapshotRepositories(collection),
    items: reduction.items.map((item) => {
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `追跡項目 ${item.nodeId}のseverity再計算結果がありません`);
      return {
        ...item,
        severity: staleness.severity,
        severityContext: staleness.severityContext,
      };
    }),
    externalReferences: graph.externalReferences,
    relations: graph.edges.map(toStateRelation),
    run: {
      id: invocation.runId,
      status: reduction.runStatus,
      complete: true,
    },
  });
  for (const nodeId of aiFingerprintByNodeId.keys()) {
    if (!persistedAiFingerprintNodeIds.has(nodeId)) {
      throw new TypeError(`AI分析fingerprintの保存対象項目がありません。対象: ${nodeId}`);
    }
  }
  const notificationSelection = selectDiscordNotifications({
    evaluatedAt: invocation.startedAt,
    items: notificationItems(configuration, state, inventory, collection, reduction, graph),
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
    repositoryAllowlist: inventory.allowlist.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
    })),
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
  repositoryAllowlist: PagesPublicSafetyInput["repositoryAllowlist"],
  validated: ValidatedRun,
  historyRecords: readonly StateHistoryRecord[],
  outputDirectory: string,
  knownSecrets: readonly string[],
): Promise<PagesResult> {
  const data = generatePublicData({
    snapshot: validated.snapshot,
    historyRecords,
    repositoryAllowlist,
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

function operationsAlertLedgerEntry(
  entry: StateNotificationLedger["operationsAlerts"][number],
): OperationsAlertLedgerEntry {
  return Object.freeze({
    ...entry,
    occurredAt: createUtcIsoDateTime(entry.occurredAt),
    sentAt: createUtcIsoDateTime(entry.sentAt),
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
    notificationLedger: StateNotificationLedger;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const sentNotificationEntries: NotificationLedgerEntry[] = [];
  const notificationEntriesByKey = new Map(
    validated.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    validated.notificationLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
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
        hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
        recordNotifications: (entries) => {
          sentNotificationEntries.push(...entries);
          for (const entry of entries) {
            notificationEntriesByKey.set(entry.notificationKey, entry);
          }
          return Promise.resolve();
        },
        recordOperationsAlert: (entry) => {
          operationsAlertsByKey.set(entry.alertKey, entry);
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
    notificationLedger: createStateNotificationLedger({
      schemaVersion: "1",
      entries: [...notificationEntriesByKey.values()],
      operationsAlerts: [...operationsAlertsByKey.values()],
    }),
    notificationCount: sentNotificationEntries.length,
    discordSentAt: sentAt,
  });
}

async function persistSuccessfulRunCompletion(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  state: RuntimeState,
  validated: ValidatedRun,
  delivery: Awaited<ReturnType<typeof deliverDiscord>>,
  knownSecrets: readonly string[],
): Promise<void> {
  const completedAt = createUtcIsoDateTime(adapters.now().toISOString());
  const trackingStartAt = completedSnapshotTrackingStartAt(config, validated.snapshot, completedAt);
  if (validated.snapshot.trackingStartAt.status === "not_fixed") {
    await state.session.persistRunCompletion({
      snapshot: createStateSnapshot({
        ...validated.snapshot,
        trackingStartAt,
      }),
      notificationLedger: delivery.notificationLedger,
      completedAt,
      knownSecrets,
    });
    return;
  }
  if (delivery.notificationCount > 0) {
    assertNonNullable(delivery.discordSentAt, "Discord通知の送信時刻がありません");
    await state.session.persistNotificationLedger({
      notificationLedger: delivery.notificationLedger,
      committedAt: delivery.discordSentAt,
      knownSecrets,
    });
  }
}

async function deliverOperationsAlert(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  knownSecrets: readonly string[],
  state: RuntimeState,
  incident: DiscordOperationsIncident,
): Promise<
  Readonly<{
    value: DiscordResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const notificationEntriesByKey = new Map(
    state.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    state.notificationLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  const delivery = await adapters.sendDiscord({
    candidates: [],
    ledgerReservations: [],
    items: previousSnapshot(state)?.items ?? [],
    generatedAt: incident.occurredAt,
    pagesDeployment: {
      status: "failed",
      incidentId: incident.incidentId,
      kind: incident.kind,
      failedAt: incident.occurredAt,
      retryAttempts: incident.retryAttempts,
    },
    settings: discordDeliverySettings(config),
    dependencies: {
      secretProvider: environmentSecretProvider(adapters.environment),
      httpClient: adapters.discordHttpClient,
      runtime: {
        now: adapters.now,
        sleep: adapters.sleep,
        random: adapters.random,
      },
      ledger: {
        hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
        recordNotifications: (entries) => {
          for (const entry of entries) {
            notificationEntriesByKey.set(entry.notificationKey, entry);
          }
          return Promise.resolve();
        },
        recordOperationsAlert: (entry) => {
          operationsAlertsByKey.set(entry.alertKey, entry);
          return Promise.resolve();
        },
      },
    },
  });
  if (delivery.status !== "skipped" || delivery.reason !== "pages_deployment_failed") {
    return Object.freeze({
      value: Object.freeze({ delivery }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const operationsDelivery = delivery.operationsAlert;
  if (operationsDelivery.status !== "sent") {
    return Object.freeze({
      value: Object.freeze({ delivery }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: "1",
    entries: [...notificationEntriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
  });
  const persistenceInput = Object.freeze({
    notificationLedger,
    committedAt: operationsDelivery.ledgerEntry.sentAt,
    knownSecrets,
  });
  if (state.snapshot.status === "missing_branch") {
    await state.session.persistInitialOperationsNotificationLedger(persistenceInput);
  } else {
    await state.session.persistNotificationLedger(persistenceInput);
  }
  return Object.freeze({
    value: Object.freeze({ delivery }),
    notificationCount: 1,
    discordSentAt: operationsDelivery.ledgerEntry.sentAt,
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
      externalReferences: tracking.result.ghostNodes,
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
      if (credentials.codex.enabled) {
        await assertCodexAuthenticationAvailable(credentials.codex);
        await assertCodexCliAvailable(adapters, credentials.codex.environment);
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
    analyzeWithCodex: async ({
      invocation,
      configuration,
      state,
      collection,
      deterministicAnalysis,
    }) => {
      const analysis = await analyzeCodex(
        adapters,
        invocation,
        configuration,
        state,
        collection,
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
      codexAnalysis,
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
            codexAnalysis,
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
        repositoryInventory.allowlist.repositories,
        validated,
        persisted.historyRecords,
        adapters.pagesOutputDirectory,
        configuration.credentials.knownSecrets,
      ),
    sendDiscord: async ({ configuration, state, validated, pages }) => {
      const result = await deliverDiscord(
        adapters,
        discordDeliverySettings(configuration.config),
        validated,
        pages.pagesUrl,
      );
      await persistSuccessfulRunCompletion(
        adapters,
        configuration.config,
        state,
        validated,
        result,
        configuration.credentials.knownSecrets,
      );
      return Object.freeze({
        value: result.value,
        notificationCount: result.notificationCount,
        discordSentAt: result.discordSentAt,
      });
    },
    sendOperationsAlert: ({ invocation, configuration, state, kind, retryAttempts }) =>
      deliverOperationsAlert(
        adapters,
        configuration.config,
        configuration.credentials.knownSecrets,
        state,
        {
          incidentId: `${invocation.runId}:${kind}`,
          kind,
          occurredAt: invocation.startedAt,
          retryAttempts,
        },
      ),
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
    persistedSnapshot.status !== "available" ||
    persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id
  ) {
    throw new TypeError("Pages生成対象のrunがtracker-state branchにありません");
  }
  const historyRecords = await session.loadHistoryRecords();
  await buildPublicPages(
    adapters,
    config,
    workflowArtifactRepositoryInventory(artifact),
    artifact.repositoryAllowlist,
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
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord通知対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id) {
    throw new TypeError(
      "Discord通知対象のworkflow artifactとtracker-state branchでrunが一致しません",
    );
  }
  const state = Object.freeze({
    session,
    snapshot: persistedSnapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const result = await deliverDiscord(
    adapters,
    artifact.discordSettings,
    Object.freeze({
      snapshot: artifact.snapshot,
      notificationLedger: state.notificationLedger,
      notificationSelection: artifact.notificationSelection,
    }),
    command.pagesUrl,
  );
  await persistSuccessfulRunCompletion(
    adapters,
    config,
    state,
    validatedRunFromArtifact(artifact),
    result,
    [],
  );
}

async function notifyWorkflowOperations(
  adapters: ProductionRuntimeAdapters,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const snapshot = await session.loadSnapshot();
  const state = Object.freeze({
    session,
    snapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const knownSecrets = config.notifications.discord.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          adapters.environment,
          config.notifications.discord.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  await deliverOperationsAlert(adapters, config, knownSecrets, state, {
    incidentId: command.incidentId,
    kind: command.incidentKind,
    occurredAt: command.occurredAt,
    retryAttempts: command.retryAttempts,
  });
}

function createWorkflowStageRunner(adapters: ProductionRuntimeAdapters): WorkflowStageRunner {
  return new WorkflowStageRunner({
    persistState: (command) => persistWorkflowState(adapters, command),
    buildPages: (command) => buildWorkflowPages(adapters, command),
    notifyDiscord: (command) => notifyWorkflowDiscord(adapters, command),
    notifyOperations: (command) => notifyWorkflowOperations(adapters, command),
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

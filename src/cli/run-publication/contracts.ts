import type { Config, loadConfig } from "../../config/index.js";
import type { DiagnosticsJsonlRecorder } from "../../diagnostics/recorder.js";
import type { AiCacheEntry, PersonalReminderAiCacheEntry } from "../../codex/index.js";
import type { ValidatedRun as TrackingValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import type { PublicationPlannedRun } from "../../publication/publication-plan-contracts.js";
import type { BoundPublicationCheckpoint } from "../publication-checkpoint-binding.js";
import type { Sha256Hash } from "../../canonical-json/sha256.js";
import type { Repository } from "../../domain/index.js";
import type {
  DiscordDigestDelivery,
  DiscordNotificationSelection,
  DiscordWebhookHttpClient,
  sendDiscordDigest,
} from "../../discord/index.js";
import type { PublicRepositoryAllowlist } from "../../github/index.js";
import type { GeneratedPublicData, PublicDataWriteResult } from "../../pages/index.js";
import type { RunMetrics } from "../run-report.js";
import type { NotificationSettlementOutcome } from "../notification-settlement.js";
import type {
  StateBranchAdapter,
  StateHistoryInputEvent,
  StateHistoryNotificationEvent,
  StateNotificationLedger,
  StatePersistenceConfiguration,
  StatePersistenceSession,
  StateSnapshot,
  StateSnapshotReadResult,
} from "../../persistence/index.js";
import type { InitialStateCommitResult } from "../initial-state-commit.js";
import type {
  PagesContentManifest,
  PagesDeploymentIntent,
} from "../../application/tracking-run/pages-build-contracts.js";
import type { PagesBuildReceipt } from "../../application/tracking-run/receipt-schema.js";
import type {
  InitialPagesDeploymentOutcome,
  SequentialPagesResult,
} from "../initial-pages-deployment.js";
import type {
  DailyTransactionDependencies,
  DailyTransactionTypeMap,
} from "../daily-transaction.js";
import type { RuntimeCredentials, RuntimeExecutionTarget } from "../production-runtime-setup.js";

/** 完全性検証を通過し、公開処理へ渡してよいrun。 */
export type ValidatedRun = TrackingValidatedRun<
  StateSnapshot,
  readonly StateHistoryInputEvent[],
  readonly AiCacheEntry[],
  readonly PersonalReminderAiCacheEntry[],
  StateNotificationLedger,
  DiscordNotificationSelection,
  RunMetrics
>;

/** 初期保存後にPages生成へ渡す値。 */
export type PersistedRun = Readonly<{
  result: InitialStateCommitResult;
  notificationLedger: StateNotificationLedger;
  session: StatePersistenceSession;
  bound: BoundPublicationCheckpoint;
}>;

/** Pages生成と書込みの結果。 */
export type InitialPagesPreparedRun = Readonly<{
  data: GeneratedPublicData;
  output: PublicDataWriteResult;
  pagesUrl: string;
  manifest: PagesContentManifest;
  intent: PagesDeploymentIntent;
  receipt: PagesBuildReceipt;
}>;

/** deploy receiptと保存候補証拠を持つ初回Pages公開結果。 */
export type InitialPagesPublishedRun = Readonly<{
  prepared: InitialPagesPreparedRun;
  deployment: Extract<InitialPagesDeploymentOutcome, { kind: "success" }>;
  pagesUrl: string;
}>;

/** Discord配送本体と履歴event。 */
export type DiscordDeliveryResult = Readonly<{
  delivery: DiscordDigestDelivery;
  notificationEvents: readonly StateHistoryNotificationEvent[];
}>;

/** daily transactionが完了保存へ渡すDiscord結果。 */
export type DiscordResult = DiscordDeliveryResult &
  Readonly<{
    notificationLedger: StateNotificationLedger;
  }>;

/** 公開処理が参照してよい設定とcredential。 */
export type PublicationConfiguration = Readonly<{
  config: Config;
  credentials: RuntimeCredentials;
  target: RuntimeExecutionTarget;
}>;

/** 公開処理が参照してよい永続化sessionと読込済み状態。 */
export type PublicationState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  notificationLedger: StateNotificationLedger;
}>;

/** 公開処理が参照してよいrepository一覧と公開allowlist。 */
export type PublicationRepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
  allowlistDigest: Sha256Hash;
}>;

/** 公開処理だけが必要とする外部接続。 */
export type RunPublicationAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
  ) => Promise<StatePersistenceSession>;
  createStateBranchAdapter: () => StateBranchAdapter;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  writeJsonArtifact: (path: string, value: unknown) => Promise<void>;
  writePublicData: (
    outputDirectory: string,
    data: GeneratedPublicData,
  ) => Promise<PublicDataWriteResult>;
  buildWebOutput: (repositoryPath: string) => Promise<void>;
  deployProductionPages: (intent: PagesDeploymentIntent) => Promise<SequentialPagesResult>;
  sendDiscord: typeof sendDiscordDigest;
}>;

/** 公開stageだけを具体化したdaily transaction型対応表。 */
export type PublicationDailyTypes = DailyTransactionTypeMap &
  Readonly<{
    configuration: PublicationConfiguration;
    state: PublicationState;
    repositoryInventory: PublicationRepositoryInventory;
    validated: ValidatedRun;
    planned: PublicationPlannedRun;
    persisted: PersistedRun;
    pagesPrepared: InitialPagesPreparedRun;
    pages: InitialPagesPublishedRun;
    notifications: Extract<NotificationSettlementOutcome, { kind: "settled" }>;
    operationsAlert: DiscordResult;
  }>;

/** 完全性検証後の出力・永続化stageだけを受け持つ依存。 */
export type DailyPublicationStageHandlers = Pick<
  DailyTransactionDependencies<PublicationDailyTypes>,
  | "persistState"
  | "buildPages"
  | "deployPages"
  | "settleNotifications"
  | "finalizeRun"
  | "sendOperationsAlert"
  | "writeCollectAnalyzeArtifact"
>;

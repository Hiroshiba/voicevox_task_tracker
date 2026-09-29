import { type OperationsAlertLedgerEntry } from "../domain/index.js";
import {
  sendDiscordOperationsAlert,
  type DiscordDeliveryDependencies,
  type DiscordDeliverySettings,
  type DiscordOperationsAlertDelivery,
  type DiscordOperationsIncident,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
import {
  sendDiscordInfrastructureAlert,
  type WorkflowInfrastructureIncident,
} from "../discord/infrastructure-alert.js";
import {
  assertOperationsAlertLedgerWritable,
  assertExistingStatePublicSafety,
  commitOperationsAlertLedger,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StatePersistenceConfiguration,
  type StatePersistenceSession,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import { operationsAlertLedgerEntry } from "./notification-ledger-normalization.js";
import { requireEnvironmentValue } from "./production-runtime-setup.js";

type NotificationDeliveryRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  createStateBranchAdapter: () => StateBranchAdapter;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
}>;

type NotificationDeliveryRuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
}>;

type OperationsIncident =
  | (DiscordOperationsIncident &
      Readonly<{
        context?: Readonly<{
          failureKind: string;
          failedStage: string;
          finalStateRevision?: string;
          lastReceiptDigest?: string;
        }>;
      }>)
  | WorkflowInfrastructureIncident;

/** Discord送信後に専用ledgerへの確定記録が失敗したことを表す。 */
export class OperationsAlertCommitFailureError extends Error {
  public readonly discordMessageId: string;

  public constructor(discordMessageId: string, cause: unknown) {
    super("運用障害通知の送信後にledgerを確定できませんでした", { cause });
    this.discordMessageId = discordMessageId;
  }
}

function previousSnapshot(state: NotificationDeliveryRuntimeState): StateSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot.snapshot : undefined;
}

function environmentSecretProvider(
  environment: Readonly<NodeJS.ProcessEnv>,
): DiscordSecretProvider {
  return Object.freeze({
    read: (name) => requireEnvironmentValue(environment, name),
  });
}

/** 運用障害通知を送達し、成功した通知管理記録を保存する。 */
export async function deliverOperationsAlert(
  adapters: NotificationDeliveryRuntimeAdapters,
  settings: DiscordDeliverySettings,
  knownSecrets: readonly string[],
  state: NotificationDeliveryRuntimeState,
  configuration: StatePersistenceConfiguration,
  incident: OperationsIncident,
): Promise<
  Readonly<{
    delivery: DiscordOperationsAlertDelivery;
    operationsCommit?: StateBranchCommitResult;
  }>
> {
  const currentNotificationLedger = await state.session.loadNotificationLedger();
  assertExistingStatePublicSafety(
    previousSnapshot(state),
    await state.session.loadHistoryRecords(),
    currentNotificationLedger,
    [incident],
    knownSecrets,
  );
  await assertOperationsAlertLedgerWritable(
    adapters.createStateBranchAdapter(),
    configuration,
    state.session.baseRevision,
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    currentNotificationLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  const deliveryDependencies: DiscordDeliveryDependencies = {
    secretProvider: environmentSecretProvider(adapters.environment),
    httpClient: adapters.discordHttpClient,
    runtime: {
      now: adapters.now,
      sleep: adapters.sleep,
      random: adapters.random,
    },
    ledger: {
      hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
      recordNotifications: () =>
        Promise.reject(new TypeError("運用通知から通常ledgerを更新できません")),
      recordOperationsAlert: (entry) => {
        operationsAlertsByKey.set(entry.alertKey, entry);
        return Promise.resolve();
      },
    },
  };
  const operationsAlert =
    incident.kind === "workflow_infrastructure_failure"
      ? await sendDiscordInfrastructureAlert(incident, settings, deliveryDependencies)
      : await sendDiscordOperationsAlert({
          incident,
          settings,
          dependencies: deliveryDependencies,
        });
  const operationsDelivery = operationsAlert;
  if (operationsDelivery.status !== "sent") {
    return Object.freeze({
      delivery: operationsDelivery,
    });
  }
  let operationsCommit: StateBranchCommitResult;
  try {
    operationsCommit = await commitOperationsAlertLedger(
      adapters.createStateBranchAdapter(),
      configuration,
      state.session.baseRevision,
      operationsDelivery.ledgerEntry,
    );
  } catch (error: unknown) {
    throw new OperationsAlertCommitFailureError(operationsDelivery.discordMessageId, error);
  }
  return Object.freeze({
    delivery: operationsDelivery,
    operationsCommit,
  });
}

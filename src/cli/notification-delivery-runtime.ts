import { type loadConfig } from "../config/index.js";
import {
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  type sendDiscordDigest,
  type DiscordDigestDelivery,
  type DiscordDeliverySettings,
  type DiscordOperationsIncident,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
import {
  assertExistingStatePublicSafety,
  createStateNotificationLedger,
  NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
  type StateBranchAdapter,
  type StateHistoryNotificationEvent,
  type StateNotificationLedger,
  type StatePersistenceConfiguration,
  type StatePersistenceSession,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import {
  operationsAlertLedgerEntry,
  notificationLedgerEntry,
} from "./notification-ledger-normalization.js";
import { requireEnvironmentValue } from "./production-runtime-setup.js";

type NotificationDeliveryRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  repositoryPath: string;
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
  sendDiscord: typeof sendDiscordDigest;
}>;

type NotificationDeliveryRuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
}>;

type DiscordDeliveryResult = Readonly<{
  delivery: DiscordDigestDelivery;
  notificationEvents: readonly StateHistoryNotificationEvent[];
}>;

type DiscordResult = DiscordDeliveryResult &
  Readonly<{
    notificationLedger: StateNotificationLedger;
  }>;

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
  incident: DiscordOperationsIncident,
): Promise<
  Readonly<{
    value: DiscordResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
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
  const notificationEntriesByKey = new Map<string, NotificationLedgerEntry>(
    currentNotificationLedger.entries.map((entry): readonly [string, NotificationLedgerEntry] => {
      const normalizedEntry = notificationLedgerEntry(entry);
      return [normalizedEntry.notificationKey, normalizedEntry];
    }),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    currentNotificationLedger.operationsAlerts.map((entry) => [
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
      value: Object.freeze({
        delivery,
        notificationEvents: Object.freeze([]),
        notificationLedger: currentNotificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const operationsDelivery = delivery.operationsAlert;
  if (operationsDelivery.status !== "sent") {
    return Object.freeze({
      value: Object.freeze({
        delivery,
        notificationEvents: Object.freeze([]),
        notificationLedger: currentNotificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
    entries: [...notificationEntriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
    pendingNotifications: currentNotificationLedger.pendingNotifications,
  });
  const persistenceInput = Object.freeze({
    notificationLedger,
    committedAt: operationsDelivery.ledgerEntry.sentAt,
    knownSecrets,
    commitScope: "operations_alert" satisfies "operations_alert",
  });
  if (state.snapshot.status === "missing_branch") {
    await state.session.persistInitialOperationsNotificationLedger(persistenceInput);
  } else {
    await state.session.persistNotificationLedger(persistenceInput);
  }
  await state.session.publish();
  return Object.freeze({
    value: Object.freeze({
      delivery,
      notificationEvents: Object.freeze([]),
      notificationLedger,
    }),
    notificationCount: 1,
    discordSentAt: operationsDelivery.ledgerEntry.sentAt,
  });
}

import { resolve } from "node:path";

import { type loadConfig } from "../config/index.js";
import {
  createUtcIsoDateTime,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type PendingNotification,
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
import { type ResolveDiscordDeliveryCliCommand } from "./command.js";
import {
  operationsAlertLedgerEntry,
  notificationLedgerEntry,
} from "./notification-ledger-normalization.js";
import { requireEnvironmentValue } from "./production-runtime-setup.js";

const DISCORD_DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;

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

function acknowledgeDeliveryStartedEntry(
  entry: Extract<NotificationLedgerEntry, { status: "delivery_started" }>,
  acknowledgedAt: UtcIsoDateTime,
): NotificationLedgerEntry {
  return Object.freeze({
    notificationKey: entry.notificationKey,
    itemNodeId: entry.itemNodeId,
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    reservedAt: entry.reservedAt,
    status: "acknowledged",
    acknowledgedAt,
  });
}

/** 送信開始済み通知を手動で確認済みまたは再試行可能にする。 */
export async function resolveDiscordDelivery(
  adapters: NotificationDeliveryRuntimeAdapters,
  command: ResolveDiscordDeliveryCliCommand,
): Promise<void> {
  if (!DISCORD_DELIVERY_ID_PATTERN.test(command.deliveryId)) {
    throw new TypeError("Discord送信のdelivery IDが不正です");
  }
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
    config.staleness.timezone,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord送信の手動解決対象となるstate snapshotがありません");
  }
  const currentLedger = await session.loadNotificationLedger();
  const entries = currentLedger.entries.map(notificationLedgerEntry);
  const matchingEntries = entries.filter(
    (entry): entry is Extract<NotificationLedgerEntry, { status: "delivery_started" }> =>
      entry.status === "delivery_started" && entry.deliveryId === command.deliveryId,
  );
  if (matchingEntries.length === 0) {
    throw new TypeError(`指定されたdelivery IDの送信開始記録がありません: ${command.deliveryId}`);
  }
  const matchingKeys = new Set(matchingEntries.map((entry) => entry.notificationKey));
  const resolvedAt = createUtcIsoDateTime(adapters.now().toISOString());
  if (matchingEntries.some((entry) => resolvedAt < entry.startedAt)) {
    throw new TypeError("Discord送信の解決時刻は送信開始時刻以後にしてください");
  }
  let nextEntries: readonly NotificationLedgerEntry[];
  let pendingNotifications: readonly PendingNotification[];
  if (command.resolution === "retry") {
    nextEntries = Object.freeze(
      entries.filter((entry) => !matchingKeys.has(entry.notificationKey)),
    );
    pendingNotifications = currentLedger.pendingNotifications;
  } else {
    nextEntries = Object.freeze(
      entries.map((entry) => {
        if (entry.status !== "delivery_started" || entry.deliveryId !== command.deliveryId) {
          return entry;
        }
        return acknowledgeDeliveryStartedEntry(entry, resolvedAt);
      }),
    );
    pendingNotifications = Object.freeze(
      currentLedger.pendingNotifications.filter(
        (pending) => !matchingKeys.has(pending.notificationKey),
      ),
    );
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
    entries: nextEntries,
    operationsAlerts: currentLedger.operationsAlerts,
    pendingNotifications,
  });
  assertExistingStatePublicSafety(
    persistedSnapshot.snapshot,
    await session.loadHistoryRecords(),
    currentLedger,
    [notificationLedger],
    [],
  );
  await session.persistNotificationLedger({
    notificationLedger,
    committedAt: resolvedAt,
    knownSecrets: [],
    commitScope: "manual_resolution",
  });
  await session.publish();
}

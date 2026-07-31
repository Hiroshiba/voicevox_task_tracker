import { z } from "zod";

import { serializeCanonicalJsonLine } from "./canonical-json.js";
import { StateFormatError } from "./errors.js";

const nonEmptyStringSchema = z.string().min(1).max(1000);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => {
      const timestamp = Date.parse(`${value}T00:00:00.000Z`);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value);
    },
    {
      message: "実在する日付を指定してください",
    },
  );
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const notificationReasonCodeSchema = z.enum([
  "none",
  "triage_overdue",
  "review_overdue",
  "author_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "ready_to_merge_overdue",
  "automation_stuck",
]);
const operationsAlertKindSchema = z.enum(["collection", "pages", "discord"]);

const runMetricsSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  changedItemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  aiCallCount: nonNegativeIntegerSchema,
  aiCacheHitCount: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  githubApiRemaining: nonNegativeIntegerSchema,
  staleRepositoryCount: nonNegativeIntegerSchema,
  notificationCount: nonNegativeIntegerSchema,
  durationMilliseconds: nonNegativeIntegerSchema,
});
const runReportSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  runId: nonEmptyStringSchema,
  date: dateSchema,
  status: z.enum(["success", "fallback"]),
  complete: z.literal(true),
  scheduledFor: dateTimeSchema,
  startedAt: dateTimeSchema,
  finishedAt: dateTimeSchema,
  metrics: runMetricsSchema,
  diagnostics: z.array(z.string().max(1000)),
});

const ledgerEntryBaseSchema = z.strictObject({
  notificationKey: nonEmptyStringSchema,
  itemNodeId: nonEmptyStringSchema,
  reasonCode: notificationReasonCodeSchema,
  severity: severitySchema,
  reservedAt: dateTimeSchema,
  cooldownUntil: dateTimeSchema,
});
const ledgerEntrySchema = z.discriminatedUnion("status", [
  ledgerEntryBaseSchema.extend({
    status: z.literal("reserved"),
  }),
  ledgerEntryBaseSchema.extend({
    status: z.literal("sent"),
    sentAt: dateTimeSchema,
    discordMessageId: nonEmptyStringSchema,
  }),
]);
const operationsAlertEntrySchema = z.strictObject({
  alertKey: nonEmptyStringSchema,
  incidentId: nonEmptyStringSchema,
  kind: operationsAlertKindSchema,
  occurredAt: dateTimeSchema,
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const notificationLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    entries: z.array(ledgerEntrySchema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "運用障害通知のalertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "送信時刻は障害発生時刻以後にしてください",
        });
      }
    }
  });

/** 日次runの完了状態と運用metricsを保持するreport。 */
export type StateRunReport = z.output<typeof runReportSchema>;

/** 通常通知の予約と送信結果、送信済み運用障害を保持するledger。 */
export type StateNotificationLedger = z.output<typeof notificationLedgerSchema>;

function createFormatError(kind: string): StateFormatError {
  return new StateFormatError(kind, {
    cause: new TypeError(`${kind}のschema検証に失敗しました`),
  });
}

/** 未検証の値を完了済みrun reportへ変換する。 */
export function createStateRunReport(value: unknown): StateRunReport {
  const result = runReportSchema.safeParse(value);
  if (!result.success) {
    throw createFormatError("run report");
  }
  return {
    ...result.data,
    metrics: {
      ...result.data.metrics,
    },
    diagnostics: [...result.data.diagnostics],
  };
}

/** 未検証の値をnotification ledgerへ変換する。 */
export function createStateNotificationLedger(value: unknown): StateNotificationLedger {
  const result = notificationLedgerSchema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger");
  }
  const compareNotificationKeys = (
    left: StateNotificationLedger["entries"][number],
    right: StateNotificationLedger["entries"][number],
  ): number => {
    if (left.notificationKey < right.notificationKey) {
      return -1;
    }
    if (left.notificationKey > right.notificationKey) {
      return 1;
    }
    return 0;
  };
  return {
    schemaVersion: "1",
    entries: [...result.data.entries].sort(compareNotificationKeys),
    operationsAlerts: [...result.data.operationsAlerts].sort((left, right) => {
      if (left.alertKey < right.alertKey) {
        return -1;
      }
      if (left.alertKey > right.alertKey) {
        return 1;
      }
      return 0;
    }),
  };
}

/** 初回bootstrap用の空notification ledgerを生成する。 */
export function createEmptyStateNotificationLedger(): StateNotificationLedger {
  return {
    schemaVersion: "1",
    entries: [],
    operationsAlerts: [],
  };
}

/** run reportを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateRunReport(report: StateRunReport): string {
  return serializeCanonicalJsonLine(createStateRunReport(report));
}

/** notification ledgerを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateNotificationLedger(ledger: StateNotificationLedger): string {
  return serializeCanonicalJsonLine(createStateNotificationLedger(ledger));
}

/** JSONからnotification ledgerを検証して読み取る。 */
export function parseStateNotificationLedger(source: string): StateNotificationLedger {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("notification ledger", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
  return createStateNotificationLedger(value);
}

/** JSONからrun reportを検証して読み取る。 */
export function parseStateRunReport(source: string): StateRunReport {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("run report", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
  return createStateRunReport(value);
}

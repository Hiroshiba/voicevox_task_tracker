import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";

export const OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1 = "1";
export const OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 = "state/operations-alert-ledger-v1.json";
const nonEmptyStringSchema = z.string().min(1).max(1000);
const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const operationsAlertEntrySchema = z.strictObject({
  alertKey: nonEmptyStringSchema,
  incidentId: nonEmptyStringSchema,
  kind: z.enum(["collection", "pages", "discord", "workflow_infrastructure_failure"]),
  occurredAt: dateTimeSchema,
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const operationsAlertLedgerVersion1Schema = z
  .strictObject({
    schemaVersion: z.literal(OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "alertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "運用障害通知の送信時刻は発生時刻以後にしてください",
        });
      }
    }
  });

/** 通常通知と独立して保存する運用障害通知ledger。 */
export type StateOperationsAlertLedger = Readonly<{
  schemaVersion: "1";
  operationsAlerts: readonly z.output<typeof operationsAlertEntrySchema>[];
}>;

/** 運用障害通知ledgerを現行形式へ検証して正規化する。 */
export function createStateOperationsAlertLedger(value: unknown): StateOperationsAlertLedger {
  const ledger = operationsAlertLedgerVersion1Schema.parse(value);
  return Object.freeze({
    schemaVersion: OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1,
    operationsAlerts: Object.freeze(
      [...ledger.operationsAlerts].sort((left, right) =>
        left.alertKey.localeCompare(right.alertKey),
      ),
    ),
  });
}

/** 運用障害通知ledgerをcanonical JSONへ変換する。 */
export function serializeStateOperationsAlertLedger(ledger: StateOperationsAlertLedger): string {
  return serializeCanonicalJsonLine(createStateOperationsAlertLedger(ledger));
}

/** 運用障害通知ledgerを専用state fileから読む。 */
export function parseStateOperationsAlertLedger(source: string): StateOperationsAlertLedger {
  const value: unknown = JSON.parse(source);
  return createStateOperationsAlertLedger(value);
}

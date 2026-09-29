import { serializeCanonicalJson } from "../canonical-json/value.js";
import { z } from "zod";
import type { Repository } from "../domain/index.js";
import type { StatePersistenceConfiguration } from "../persistence/branch-adapter.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import type { ProductionRuntimeAdapters } from "./production-runtime/adapters.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import { requireEnvironmentValue } from "./production-runtime-setup.js";
import { createProductionNotificationMessageSendPort } from "./notification-message-http.js";
import type { NotificationSettlementPort } from "./notification-settlement.js";

type NotificationStageAdapters = Pick<
  ProductionRuntimeAdapters,
  "environment" | "createStateBranchAdapter" | "discordHttpClient" | "now" | "diagnosticsRecorder"
>;

/** productionまたはsandboxの通知effectを同じsettlement stageへ接続する。 */
export function createNotificationSettlementPort(
  adapters: NotificationStageAdapters,
  configuration: StatePersistenceConfiguration,
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
  effectTarget: "production" | "recording",
): NotificationSettlementPort {
  const sender =
    effectTarget === "production"
      ? createProductionNotificationMessageSendPort({
          secretProvider: {
            read: (name) => requireEnvironmentValue(adapters.environment, name),
          },
          httpClient: adapters.discordHttpClient,
          now: adapters.now,
        })
      : {
          send: (() => {
            const sandbox = adapters.environment["TRACKING_EFFECT_TARGET"] === "sandbox";
            const outcome = sandbox
              ? z
                  .enum(["recorded_success", "recorded_clear_rejection", "recorded_ambiguous"])
                  .parse(adapters.environment["TRACKING_RECORDING_OUTCOME"])
              : "recorded_success";
            const messageIndex = sandbox
              ? z.coerce
                  .number()
                  .int()
                  .nonnegative()
                  .parse(adapters.environment["TRACKING_RECORDING_MESSAGE_INDEX"])
              : 0;
            let attempted = 0;
            return (payload: unknown) => {
              const selected = attempted === messageIndex ? outcome : "recorded_success";
              attempted += 1;
              const observedAt = adapters.now().toISOString();
              if (selected === "recorded_clear_rejection" || selected === "recorded_ambiguous") {
                return Promise.resolve({
                  status:
                    selected === "recorded_clear_rejection"
                      ? ("clear_rejection" as const)
                      : ("ambiguous" as const),
                  source: "recording" as const,
                  observedAt,
                  cause: new TypeError(`sandbox通知の記録結果: ${selected}`),
                });
              }
              return Promise.resolve({
                status: "sent" as const,
                source: "recording" as const,
                discordMessageId: `recording:v1:${digest.sha256Utf8(serializeCanonicalJson(payload))}`,
                observedAt,
              });
            };
          })(),
        };
  return Object.freeze({
    adapter: adapters.createStateBranchAdapter(),
    configuration,
    repositoryInventory,
    knownSecrets,
    sender,
    recordDiagnostic: async (cause: unknown) => {
      if (adapters.diagnosticsRecorder == null) {
        process.stderr.write(`${safeErrorDiagnostic("discord", cause)}\n`);
        return;
      }
      await adapters.diagnosticsRecorder.append({
        event: "cli.stage.failed",
        details: { stage: "discord" },
        error: cause,
      });
    },
    now: adapters.now,
  });
}

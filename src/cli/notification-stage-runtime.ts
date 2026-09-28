import { serializeCanonicalJson } from "../canonical-json/value.js";
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
          send: (payload: unknown) =>
            Promise.resolve({
              status: "sent" as const,
              source: "recording" as const,
              discordMessageId: `recording:v1:${digest.sha256Utf8(serializeCanonicalJson(payload))}`,
              observedAt: adapters.now().toISOString(),
            }),
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

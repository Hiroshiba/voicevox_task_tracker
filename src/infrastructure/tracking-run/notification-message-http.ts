import { z } from "zod";
import {
  DiscordWebhookRequestError,
  DiscordWebhookSecretInvalidError,
  DiscordWebhookSecretMissingError,
  DiscordWebhookSecretReadError,
} from "../../discord/errors.js";
import type { DiscordWebhookPayload } from "../../discord/payload.js";
import {
  executeDiscordWebhook,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../../discord/webhook.js";

export const notificationMessageSendOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("sent"),
    source: z.enum(["production", "recording"]),
    discordMessageId: z.string().min(1).max(1000),
    observedAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    status: z.enum(["clear_rejection", "ambiguous"]),
    source: z.enum(["production", "recording"]),
    observedAt: z.iso.datetime({ offset: true }),
    cause: z.unknown(),
  }),
]);

/** 一つの実HTTP試行またはsandbox記録の判別可能な結果。 */
export type NotificationMessageSendOutcome = z.output<typeof notificationMessageSendOutcomeSchema>;

/** CAS予約成功後に一度だけ呼ぶDiscord effect境界。 */
export type NotificationMessageSendPort = Readonly<{
  send: (
    payload: DiscordWebhookPayload,
    webhookSecretName: string,
  ) => Promise<NotificationMessageSendOutcome>;
}>;

/** 既存webhook clientでretryを無効にしたproduction送信境界を作る。 */
export function createProductionNotificationMessageSendPort(
  input: Readonly<{
    secretProvider: DiscordSecretProvider;
    httpClient: DiscordWebhookHttpClient;
    now: () => Date;
  }>,
): NotificationMessageSendPort {
  return Object.freeze({
    send: async (payload, webhookSecretName) => {
      try {
        const result = await executeDiscordWebhook({
          secretName: webhookSecretName,
          payload,
          retry: { maxAttempts: 1, initialDelaySeconds: 0, maxDelaySeconds: 0 },
          secretProvider: input.secretProvider,
          httpClient: input.httpClient,
          runtime: { now: input.now, sleep: () => Promise.resolve(), random: () => 0 },
          beforeFirstAttempt: () => Promise.resolve(),
        });
        if (result.attempts !== 1) {
          throw new TypeError("一つの予約で複数のDiscord HTTP試行を実行しました");
        }
        return Object.freeze({
          status: "sent",
          source: "production",
          discordMessageId: result.discordMessageId,
          observedAt: input.now().toISOString(),
        });
      } catch (cause: unknown) {
        const status =
          cause instanceof DiscordWebhookRequestError ||
          cause instanceof DiscordWebhookSecretInvalidError ||
          cause instanceof DiscordWebhookSecretMissingError ||
          cause instanceof DiscordWebhookSecretReadError
            ? "clear_rejection"
            : "ambiguous";
        return Object.freeze({
          status,
          source: "production",
          observedAt: input.now().toISOString(),
          cause,
        });
      }
    },
  });
}

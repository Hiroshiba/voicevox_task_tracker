import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ZodError } from "zod";

import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { InitialStateCommitReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import {
  decodeInitialPagesBuildArtifact,
  type InitialPagesBuildArtifact,
} from "../initial-pages-build-artifact.js";
import {
  readInitialPagesDeploymentOutcome,
  type InitialPagesDeploymentOutcome,
} from "../initial-pages-deployment.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import {
  NotificationSettlementFailureError,
  settleNotificationsWithPreflight,
} from "../notification-settlement.js";
import { createNotificationSettlementPort } from "../notification-stage-runtime.js";
import { NotificationStructureError } from "../notification-structure-error.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import { finalizeRun } from "../run-finalization.js";
import type { FinalizeRunCliCommand, SettleNotificationsCliCommand } from "../command.js";
import type { RunPublicationAdapters } from "./contracts.js";

type WorkflowNotificationAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "diagnosticsRecorder"
  | "writeJsonArtifact"
  | "now"
>;

function pagesArtifactFailure(cause: unknown): never {
  if (
    cause instanceof SyntaxError ||
    cause instanceof ZodError ||
    cause instanceof TypeError ||
    (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
  ) {
    throw new NotificationStructureError("workflow通知のPages artifactが不正です", "no_effect", {
      cause,
    });
  }
  throw cause;
}

async function initialReceipt(
  adapters: WorkflowNotificationAdapters,
  path: string,
): Promise<InitialStateCommitReceipt> {
  const receipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, path)),
    nodeContentDigestPort,
  );
  if (
    receipt.receiptType !== "initial_state_commit" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !==
      requireEnvironmentValue(adapters.environment, "VOICEVOX_EXPECTED_RUN_ID")
  ) {
    throw new TypeError("workflow通知の初回state receiptが期待runと一致しません");
  }
  return receipt;
}

/** split workflowの通知をexact state recordからsettleする。 */
export async function settleWorkflowNotifications(
  adapters: WorkflowNotificationAdapters,
  command: SettleNotificationsCliCommand,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const initialStateReceipt = await initialReceipt(adapters, command.initialStateReceiptPath);
  const adapter = adapters.createStateBranchAdapter();
  const initial = await readNotificationMessageState(
    adapter,
    config.state,
    initialStateReceipt.result.resultingStateRevision,
  );
  const record = initial.transaction.record;
  const knownSecrets =
    record.executionPolicy.effectTarget === "production" &&
    record.notificationOutbox.action === "send" &&
    record.notificationOutbox.settings.enabled
      ? [
          requireEnvironmentValue(
            adapters.environment,
            record.notificationOutbox.settings.webhookSecretName,
          ),
          requireEnvironmentValue(
            adapters.environment,
            record.notificationOutbox.settings.operationsWebhookSecretName,
          ),
        ]
      : [];
  const outcome = await settleNotificationsWithPreflight(
    {
      record,
      initialStateReceipt,
      loadPages: async () => {
        let build: InitialPagesBuildArtifact;
        try {
          build = decodeInitialPagesBuildArtifact(
            await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
          );
        } catch (cause: unknown) {
          pagesArtifactFailure(cause);
        }
        let deployment: InitialPagesDeploymentOutcome;
        try {
          deployment = await readInitialPagesDeploymentOutcome(
            resolve(adapters.repositoryPath, command.deploymentOutcomePath),
            build,
          );
        } catch (cause: unknown) {
          pagesArtifactFailure(cause);
        }
        if (
          deployment.kind !== "success" ||
          build.intent.runId !== record.runIdentity.runId ||
          build.intent.checkpointDigest !== record.checkpointDigest ||
          serializeCanonicalJson(build.receipt.binding) !==
            serializeCanonicalJson(initialStateReceipt.binding)
        ) {
          throw new NotificationStructureError(
            "workflow通知のPages証拠とstate recordが一致しません",
            "no_effect",
          );
        }
        return {
          initialPages: {
            kind: "published" as const,
            buildReceipt: build.receipt,
            deploymentReceipt: deployment.receipt,
            evidence: deployment.evidence,
          },
          pagesReceipt: deployment.receipt,
        };
      },
    },
    createNotificationSettlementPort(
      adapters,
      config.state,
      initial.snapshot.repositories,
      knownSecrets,
      record.executionPolicy.effectTarget === "production" ? "production" : "recording",
    ),
  );
  if (outcome.kind !== "settled") {
    throw new NotificationSettlementFailureError(outcome);
  }
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.settlementReceiptPath),
    outcome.receipt,
  );
}

/** split workflowの最終reportをsettlement stateから単一CASへ保存する。 */
export async function finalizeWorkflowRun(
  adapters: WorkflowNotificationAdapters,
  command: FinalizeRunCliCommand,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const initialStateReceipt = await initialReceipt(adapters, command.initialStateReceiptPath);
  const settlementReceipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.settlementReceiptPath)),
    nodeContentDigestPort,
  );
  if (settlementReceipt.receiptType !== "notification_settlement") {
    throw new TypeError("workflow finalizationにsettlement receiptがありません");
  }
  const adapter = adapters.createStateBranchAdapter();
  const settled = await readNotificationMessageState(
    adapter,
    config.state,
    settlementReceipt.result.resultingStateRevision,
  );
  const outcome = await finalizeRun(
    {
      record: settled.transaction.record,
      initialStateReceipt,
      settlementReceipt,
    },
    createNotificationSettlementPort(
      adapters,
      config.state,
      settled.snapshot.repositories,
      [],
      settled.transaction.record.executionPolicy.effectTarget === "production"
        ? "production"
        : "recording",
    ),
  );
  if (outcome.kind !== "finalized") {
    throw new TypeError(`workflow finalizationを確定できません。状態: ${outcome.kind}`);
  }
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.finalizationReceiptPath),
    outcome.receipt,
  );
}

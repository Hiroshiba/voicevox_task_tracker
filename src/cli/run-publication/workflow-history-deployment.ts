import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { nodeContentDigestPort as digest } from "../../infrastructure/tracking-run/content-digest.js";
import type {
  PreflightNotificationHistoryDeploymentCliCommand,
  RecordNotificationHistoryDeploymentCliCommand,
} from "../command.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "../notification-history-pages-build-artifact.js";
import {
  preflightNotificationHistoryPagesDeployment,
  parseNotificationHistoryPagesDeploymentPreflight,
} from "../notification-history-pages-deployment.js";
import { recordNotificationHistoryWorkflowDeployment } from "../notification-history-pages-deployment-record.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "../notification-history-pages-deployment-outcome.js";
import { workflowAdapterIdentity } from "../publication-runtime.js";
import type { RunPublicationAdapters } from "./contracts.js";

type WorkflowHistoryDeploymentAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "now"
  | "writeJsonArtifact"
>;

async function readPreviousOutcome(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function optionalOutput(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value == null || value.length === 0 ? undefined : value;
}

/** split通知履歴Pages action直前の正本と全fileを検証する。 */
export async function preflightWorkflowNotificationHistoryDeployment(
  adapters: WorkflowHistoryDeploymentAdapters,
  command: PreflightNotificationHistoryDeploymentCliCommand,
): Promise<void> {
  const artifact = decodeNotificationHistoryPagesBuildArtifact(
    await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
  );
  const settlement = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.settlementReceiptPath)),
    digest,
  );
  const finalization = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.finalizationReceiptPath)),
    digest,
  );
  if (
    settlement.receiptType !== "notification_settlement" ||
    finalization.receiptType !== "run_finalization"
  ) {
    throw new TypeError("通知履歴Pages deployにsettlementとfinalizationのreceiptが必要です");
  }
  const previousBytes = await readPreviousOutcome(
    resolve(adapters.repositoryPath, command.previousOutcomePath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const preflight = await preflightNotificationHistoryPagesDeployment({
    adapter: adapters.createStateBranchAdapter(),
    config,
    configuration: config.state,
    repositoryPath: adapters.repositoryPath,
    artifact,
    settlementReceipt: settlement,
    finalizationReceipt: finalization,
    ...(previousBytes == null
      ? {}
      : {
          previousOutcome: decodeNotificationHistoryPagesDeploymentOutcome(previousBytes, artifact),
        }),
    replay: command.runAttempt > 1,
    observedAt: adapters.now().toISOString(),
    effectTarget: "production",
    adapterIdentityDigest: await workflowAdapterIdentity(adapters.repositoryPath, digest),
  });
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.preflightPath),
    preflight,
  );
}

/** split通知履歴Pages actionの実outputをreceiptまたは失敗artifactへ記録する。 */
export async function recordWorkflowNotificationHistoryDeployment(
  adapters: WorkflowHistoryDeploymentAdapters,
  command: RecordNotificationHistoryDeploymentCliCommand,
): Promise<void> {
  const artifact = decodeNotificationHistoryPagesBuildArtifact(
    await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
  );
  const preflightPath = resolve(adapters.repositoryPath, command.preflightPath);
  const preflightSource = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(preflightPath),
  );
  const preflightRaw: unknown = JSON.parse(preflightSource);
  if (preflightSource !== serializeCanonicalJsonLine(preflightRaw)) {
    throw new TypeError("通知履歴Pages preflightがcanonical JSONではありません");
  }
  const preflight = parseNotificationHistoryPagesDeploymentPreflight(preflightRaw, artifact);
  const outcome = recordNotificationHistoryWorkflowDeployment({
    artifact,
    preflight,
    observation: {
      schemaVersion: 1,
      phase: "notification_history",
      ...(optionalOutput(adapters.environment, "PAGES_DEPLOYMENT_INTENT_DIGEST") == null
        ? {}
        : {
            deploymentIntentDigest: optionalOutput(
              adapters.environment,
              "PAGES_DEPLOYMENT_INTENT_DIGEST",
            ),
          }),
      uploadOutcome: adapters.environment["PAGES_UPLOAD_OUTCOME"],
      deploymentOutcome: adapters.environment["PAGES_DEPLOYMENT_OUTCOME"],
      artifactName: adapters.environment["PAGES_ARTIFACT_NAME"],
      ...(optionalOutput(adapters.environment, "PAGES_ARTIFACT_ID") == null
        ? {}
        : { artifactId: optionalOutput(adapters.environment, "PAGES_ARTIFACT_ID") }),
      ...(optionalOutput(adapters.environment, "PAGES_ARTIFACT_DIGEST") == null
        ? {}
        : { artifactDigest: optionalOutput(adapters.environment, "PAGES_ARTIFACT_DIGEST") }),
      ...(optionalOutput(adapters.environment, "PAGES_DEPLOYMENT_ID") == null
        ? {}
        : { deploymentId: optionalOutput(adapters.environment, "PAGES_DEPLOYMENT_ID") }),
      ...(optionalOutput(adapters.environment, "PAGES_URL") == null
        ? {}
        : { pageUrl: optionalOutput(adapters.environment, "PAGES_URL") }),
    },
    adapterIdentityDigest: await workflowAdapterIdentity(adapters.repositoryPath, digest),
    observedAt: adapters.now().toISOString(),
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outcomePath), outcome);
  if (outcome.kind === "failure") {
    throw new TypeError(`通知履歴Pages公開結果が確定しませんでした。種別: ${outcome.reason}`);
  }
}

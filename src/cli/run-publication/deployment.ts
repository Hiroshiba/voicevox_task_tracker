import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { decodeInitialPagesBuildArtifact } from "../initial-pages-build-artifact.js";
import {
  preflightInitialPagesDeployment,
  readInitialPagesDeploymentPreflight,
  recordInitialPagesSequentialDeployment,
  recordInitialPagesWorkflowDeployment,
} from "../initial-pages-deployment.js";
import { isWorkflowPublicationReplay, workflowAdapterIdentityV2 } from "../publication-runtime.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import type { Config } from "../../config/index.js";
import type {
  PreflightPagesDeploymentCliCommand,
  RecordPagesDeploymentCliCommand,
} from "../command.js";
import type { RunPublicationAdapters } from "./contracts.js";

type DeploymentAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "now"
  | "writeJsonArtifact"
>;

/** split Pages actionの直前にremote stateと全fileを検査する。 */
export async function preflightWorkflowPagesDeployment(
  adapters: DeploymentAdapters,
  command: PreflightPagesDeploymentCliCommand,
): Promise<void> {
  const config: Config = await adapters.loadConfig(
    resolve(adapters.repositoryPath, command.configPath),
  );
  const artifact = decodeInitialPagesBuildArtifact(
    await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
  );
  const initialReceipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.initialStateReceiptPath)),
    nodeContentDigestPort,
  );
  if (initialReceipt.receiptType !== "initial_state_commit") {
    throw new TypeError("Pages deploy直前の初回state commit receiptがありません");
  }
  const adapter = adapters.createStateBranchAdapter();
  const source = await readNotificationMessageState(
    adapter,
    config.state,
    initialReceipt.result.resultingStateRevision,
  );
  const preflight = await preflightInitialPagesDeployment({
    adapter,
    configuration: config.state,
    repositoryPath: adapters.repositoryPath,
    artifact,
    initialStateCommitReceipt: initialReceipt,
    replay:
      initialReceipt.receiptKind === "observed" ||
      isWorkflowPublicationReplay(
        source.transaction.record.runtimeRecoveryPlan,
        adapters.environment,
      ),
    observedAt: adapters.now().toISOString(),
    effectTarget: source.transaction.record.executionPolicy.effectTarget,
    ...(source.transaction.record.executionPolicy.effectTarget === "production"
      ? {
          adapterIdentityDigest: await workflowAdapterIdentityV2(
            adapters.repositoryPath,
            nodeContentDigestPort,
          ),
        }
      : {}),
  });
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.preflightPath),
    preflight,
  );
}

function optionalOutput(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value == null || value.length === 0 ? undefined : value;
}

/** split Pages actionの成否と実outputをreceiptまたは失敗artifactへ記録する。 */
export async function recordWorkflowPagesDeployment(
  adapters: DeploymentAdapters,
  command: RecordPagesDeploymentCliCommand,
): Promise<void> {
  const artifact = decodeInitialPagesBuildArtifact(
    await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
  );
  const preflight = await readInitialPagesDeploymentPreflight(
    resolve(adapters.repositoryPath, command.preflightPath),
  );
  const effectTarget = adapters.environment["TRACKING_EFFECT_TARGET"];
  if (effectTarget !== "production" && effectTarget !== "sandbox") {
    throw new TypeError("Pages結果のeffect targetが不正です");
  }
  if (effectTarget === "sandbox") {
    if (
      adapters.environment["PAGES_DEPLOYMENT_OUTCOME"] !== "skipped" ||
      (preflight.kind === "ready" && adapters.environment["PAGES_UPLOAD_OUTCOME"] !== "success") ||
      (preflight.kind !== "ready" && adapters.environment["PAGES_UPLOAD_OUTCOME"] !== "skipped")
    ) {
      throw new TypeError("sandbox Pages artifactの結果が不正です");
    }
    let recordingId: string | undefined;
    if (preflight.kind === "ready") {
      const artifactId = optionalOutput(adapters.environment, "PAGES_ARTIFACT_ID");
      const artifactName = optionalOutput(adapters.environment, "PAGES_ARTIFACT_NAME");
      if (artifactId == null || artifactName == null) {
        throw new TypeError("sandbox Pages artifactの識別情報がありません");
      }
      recordingId = `${artifactName}:${artifactId}`;
    }
    const outcome = recordInitialPagesSequentialDeployment({
      artifact,
      preflight,
      target: "recording",
      ...(recordingId == null ? {} : { recordingId }),
      observedAt: adapters.now().toISOString(),
    });
    await adapters.writeJsonArtifact(
      resolve(adapters.repositoryPath, command.outcomePath),
      outcome,
    );
    if (outcome.kind === "failure") {
      throw new TypeError(`sandbox Pages結果が確定しませんでした。種別: ${outcome.reason}`);
    }
    return;
  }
  const outcome = recordInitialPagesWorkflowDeployment({
    artifact,
    preflight,
    observation: {
      schemaVersion: 1,
      phase: "initial",
      deploymentIntentDigest: adapters.environment["PAGES_DEPLOYMENT_INTENT_DIGEST"],
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
    adapterIdentityDigest: await workflowAdapterIdentityV2(
      adapters.repositoryPath,
      nodeContentDigestPort,
    ),
    observedAt: adapters.now().toISOString(),
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outcomePath), outcome);
  if (outcome.kind === "failure") {
    throw new TypeError(`Pages actionの公開結果が確定しませんでした。種別: ${outcome.reason}`);
  }
}

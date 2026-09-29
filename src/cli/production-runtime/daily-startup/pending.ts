import { resolve } from "node:path";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";

import { completeTrackingRun } from "../../../application/tracking-run/complete-run.js";
import {
  PagesEffectNotStartedError,
  publishPagesWithEffect,
} from "../../../application/tracking-run/pages-effect.js";
import { verifyReceiptChain } from "../../../application/tracking-run/receipt-chain.js";
import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
  type ReceiptChainEvidence,
  type ReceiptChainEntry,
} from "../../../application/tracking-run/receipt-chain-schema.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import type { RecoveryStageInput } from "../../../infrastructure/tracking-run/recovery-stage.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  decodeInitialPagesBuildArtifact,
  parseInitialPagesBuildArtifact,
} from "../../initial-pages-build-artifact.js";
import {
  preflightInitialPagesDeployment,
  recordInitialPagesSequentialDeployment,
  recordInitialPagesSequentialFailure,
  readInitialPagesDeploymentOutcome,
} from "../../initial-pages-deployment.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "../../notification-history-pages-build-artifact.js";
import { CliWorkflowArtifactError } from "../../errors.js";
import { readNotificationMessageState } from "../../notification-message-state.js";
import { createNotificationSettlementPort } from "../../notification-stage-runtime.js";
import {
  NotificationSettlementFailureError,
  settleNotifications,
} from "../../notification-settlement.js";
import { readRuntimeCredentials, resolveRuntimeTarget } from "../../production-runtime-setup.js";
import { finalizeRun } from "../../run-finalization.js";
import {
  buildDailyNotificationHistoryPages,
  deployDailyNotificationHistoryPages,
} from "../../run-publication/daily-history-pages.js";
import { buildPublicPages } from "../../run-publication/pages.js";
import type { RunRequest } from "../../../application/tracking-run/request.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { readSequentialReceipts } from "./launch.js";
import { sequentialReceiptPath } from "../../sequential-receipt-path.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type PendingConfiguration = Readonly<{
  config: Awaited<ReturnType<ProductionRuntimeAdapters["loadConfig"]>>;
  target: Awaited<ReturnType<typeof resolveRuntimeTarget>>;
  credentials: ReturnType<typeof readRuntimeCredentials>;
}>;

async function optionalArtifactBytes(
  adapters: ProductionRuntimeAdapters,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await adapters.readArtifactBytes(resolve(adapters.repositoryPath, path));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function requiredArtifactBytes(
  adapters: ProductionRuntimeAdapters,
  path: string,
): Promise<Uint8Array> {
  try {
    return await adapters.readArtifactBytes(resolve(adapters.repositoryPath, path));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliWorkflowArtifactError(path, "missing", { cause: error });
    }
    throw error;
  }
}

function initialReceipt(entries: readonly ReceiptChainEntry[]): InitialStateCommitReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "initial_state_commit",
  )?.receipt;
  if (receipt?.receiptType !== "initial_state_commit") {
    throw new TypeError("再開に必要なinitial_state_commit receiptが保存されていません");
  }
  return receipt;
}

function settlementReceipt(entries: readonly ReceiptChainEntry[]): NotificationSettlementReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "notification_settlement",
  )?.receipt;
  if (receipt?.receiptType !== "notification_settlement") {
    throw new TypeError("再開に必要なnotification_settlement receiptが保存されていません");
  }
  return receipt;
}

function finalizationReceipt(entries: readonly ReceiptChainEntry[]): RunFinalizationReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "run_finalization",
  )?.receipt;
  if (receipt?.receiptType !== "run_finalization") {
    throw new TypeError("再開に必要なrun_finalization receiptが保存されていません");
  }
  return receipt;
}

async function pendingConfiguration(
  adapters: ProductionRuntimeAdapters,
  request: RunRequest,
): Promise<PendingConfiguration> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, request.configPath));
  const target = await resolveRuntimeTarget(
    Object.freeze({
      repositoryPath: adapters.repositoryPath,
      ...(adapters.readSandboxContext == null
        ? {}
        : { readSandboxContext: adapters.readSandboxContext }),
      createStateBranchAdapter: adapters.createStateBranchAdapter,
    }),
    config,
    request,
  );
  return Object.freeze({
    config,
    target,
    credentials: readRuntimeCredentials(adapters.environment, config, request),
  });
}

/** 保存済みrunのexact effectを実行するproduction portを作る。 */
export function createPendingRunStage(
  adapters: ProductionRuntimeAdapters,
  request: RunRequest,
  invocationId: string,
  inspectLaunch: ProductionDailyDependencies["inspectLaunch"],
  getRunId: () => string,
): ReturnType<ProductionDailyDependencies["pendingRun"]> {
  const readEntries = (): Promise<ReceiptChainEntry[]> =>
    readSequentialReceipts(adapters.repositoryPath, getRunId(), adapters.readArtifactBytes).then(
      (entries) => [...entries],
    );
  const appendEntries = async (...added: readonly ReceiptChainEntry[]): Promise<void> => {
    const entries = await readEntries();
    for (const entry of added) {
      if (
        entries.some((current) => current.receipt.receiptDigest === entry.receipt.receiptDigest)
      ) {
        continue;
      }
      entries.push(entry);
    }
    verifyReceiptChain(entries, nodeContentDigestPort);
    await adapters.writeJsonArtifact(
      sequentialReceiptPath(adapters.repositoryPath, getRunId()),
      receiptChainEnvelopeSchema.parse({ schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION, entries }),
    );
  };
  const inspect = async (): Promise<RecoveryStageInput> => {
    const launch = await inspectLaunch(request, invocationId);
    if (launch.runtime !== "exact" || launch.decision.kind !== "resume_pending") {
      throw new TypeError("再開中のrunがexact pendingでなくなりました");
    }
    return launch.decision.pending;
  };
  return Object.freeze({
    inspect,
    execute: Object.freeze({
      initial_pages_build: async (value: RecoveryStageInput) => {
        if (value.stage !== "initial_pages_build") {
          throw new TypeError("初回Pages buildの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const initial =
          entries.length === 0
            ? value.resumeInput.initialStateCommitReceipt
            : initialReceipt(entries);
        if (entries.length === 0) {
          if (value.resumeInput.initialStateCommitEvidence == null) {
            throw new TypeError("初回state commitの再観測証拠がありません");
          }
          await appendEntries({
            receipt: initial,
            evidence: { kind: "state_commit", state: value.resumeInput.initialStateCommitEvidence },
          });
        }
        const saved = await optionalArtifactBytes(
          adapters,
          "artifacts/workflow/initial-pages-build.json",
        );
        if (saved != null) {
          const artifact = decodeInitialPagesBuildArtifact(saved);
          if (
            artifact.intent.runId !== value.record.runIdentity.runId ||
            artifact.intent.checkpointDigest !== value.record.checkpointDigest ||
            artifact.intent.sourceStateRevision !== value.initialStateRevision ||
            artifact.receipt.previousReceiptDigest !== initial.receiptDigest
          ) {
            throw new TypeError("保存済み初回Pages build artifactがexact runと一致しません");
          }
          await appendEntries({ receipt: artifact.receipt, evidence: { kind: "none" } });
          return;
        }
        const built = await buildPublicPages({
          adapter: adapters.createStateBranchAdapter(),
          config: configuration.config,
          stateConfiguration: configuration.target.state,
          initialStateCommitReceipt: initial,
          repositoryPath: adapters.repositoryPath,
          outputDirectory: adapters.pagesOutputDirectory,
          knownSecrets: configuration.credentials.knownSecrets,
          writePublicData: adapters.writePublicData,
          buildWebOutput: adapters.buildWebOutput,
          now: adapters.now,
        });
        await adapters.writeJsonArtifact(
          resolve(adapters.repositoryPath, "artifacts/workflow/initial-pages-build.json"),
          parseInitialPagesBuildArtifact({
            schemaVersion: 1,
            manifest: built.manifest,
            intent: built.intent,
            receipt: built.receipt,
          }),
        );
        await appendEntries({ receipt: built.receipt, evidence: { kind: "none" } });
      },
      initial_pages_deploy: async (value: RecoveryStageInput) => {
        if (value.stage !== "initial_pages_deploy") {
          throw new TypeError("初回Pages deployの再開段階が一致しません");
        }
        const artifact = decodeInitialPagesBuildArtifact(
          await requiredArtifactBytes(adapters, "artifacts/workflow/initial-pages-build.json"),
        );
        if (artifact.receipt.receiptDigest !== value.buildReceipt.receiptDigest) {
          throw new TypeError("保存済み初回Pages build artifactとexact receiptが一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const initial = initialReceipt(await readEntries());
        const deployment = await publishPagesWithEffect(artifact, {
          preflight: (build) =>
            preflightInitialPagesDeployment({
              adapter: adapters.createStateBranchAdapter(),
              configuration: configuration.target.state,
              repositoryPath: adapters.repositoryPath,
              artifact: build,
              initialStateCommitReceipt: initial,
              replay: true,
              observedAt: adapters.now().toISOString(),
              effectTarget: configuration.target.kind,
            }),
          intent: (build) => build.intent,
          deploy: async (intent) => {
            if (configuration.target.kind !== "production") {
              return { kind: "deployed", result: undefined };
            }
            try {
              return { kind: "deployed", result: await adapters.deployProductionPages(intent) };
            } catch (cause: unknown) {
              if (cause instanceof PagesEffectNotStartedError) {
                return { kind: "no_effect", cause };
              }
              throw cause;
            }
          },
          record: async (build, preflight, observation) => {
            const outcome =
              observation.kind === "no_effect" || observation.kind === "ambiguous"
                ? recordInitialPagesSequentialFailure(build, preflight, observation.kind)
                : recordInitialPagesSequentialDeployment({
                    artifact: build,
                    preflight,
                    target: configuration.target.kind === "production" ? "production" : "recording",
                    ...(observation.kind !== "deployed" || observation.result == null
                      ? {}
                      : { productionResult: observation.result }),
                    recordingId: `${value.record.runIdentity.runId}:${build.intent.deploymentIntentDigest}`,
                    observedAt: adapters.now().toISOString(),
                  });
            await adapters.writeJsonArtifact(
              resolve(adapters.repositoryPath, "artifacts/workflow/initial-pages-deployment.json"),
              outcome,
            );
            return outcome;
          },
          requirePublished: (outcome, observation) => {
            if (outcome.kind !== "success") {
              throw new TypeError("初回Pages公開を確定できません", {
                cause:
                  observation.kind === "ambiguous" || observation.kind === "no_effect"
                    ? observation.cause
                    : undefined,
              });
            }
            return outcome;
          },
        });
        let evidence: ReceiptChainEvidence = { kind: "none" };
        if (deployment.receipt.receiptKind === "observed") {
          const revision = deployment.receipt.expectedStateRevision;
          if (typeof revision !== "string") {
            throw new TypeError("再観測した初回Pagesにexact state revisionがありません");
          }
          const state = await readNotificationMessageState(
            adapters.createStateBranchAdapter(),
            configuration.target.state,
            revision,
          );
          const marker = state.transaction.marker;
          if (
            marker.phase === "initial_state_committed" ||
            state.transaction.initialPagesEvidence == null ||
            serializeCanonicalJson(state.transaction.initialPagesEvidence) !==
              serializeCanonicalJson(deployment.evidence)
          ) {
            throw new TypeError("初回Pages再観測receiptとexact state証拠が一致しません");
          }
          evidence = {
            kind: "initial_pages_state",
            state: {
              exactStateRevision: revision,
              marker: {
                runId: marker.runId,
                checkpointDigest: marker.checkpointDigest,
                phase: marker.phase,
                initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
                initialStateRevision: marker.initialStateRevision,
              },
              evidence: deployment.evidence,
            },
          };
        }
        await appendEntries({ receipt: deployment.receipt, evidence });
      },
      notifications: async (value: RecoveryStageInput) => {
        if (value.stage !== "notifications") {
          throw new TypeError("通知settlementの再開段階が一致しません");
        }
        const build = decodeInitialPagesBuildArtifact(
          await requiredArtifactBytes(adapters, "artifacts/workflow/initial-pages-build.json"),
        );
        await requiredArtifactBytes(adapters, "artifacts/workflow/initial-pages-deployment.json");
        const deployed = await readInitialPagesDeploymentOutcome(
          resolve(adapters.repositoryPath, "artifacts/workflow/initial-pages-deployment.json"),
          build,
        );
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const initial = initialReceipt(entries);
        const initialState = await readNotificationMessageState(
          adapters.createStateBranchAdapter(),
          configuration.target.state,
          value.initialStateRevision,
        );
        if (
          deployed.kind !== "success" ||
          build.receipt.receiptDigest !== entries[1]?.receipt.receiptDigest ||
          deployed.receipt.receiptDigest !== entries[2]?.receipt.receiptDigest ||
          (value.source.kind === "deployment_receipt" &&
            deployed.receipt.receiptDigest !== value.source.receipt.receiptDigest) ||
          (value.source.kind === "state_evidence" &&
            serializeCanonicalJson(deployed.evidence) !==
              serializeCanonicalJson(value.source.evidence))
        ) {
          throw new TypeError("保存済み初回Pages公開artifactとexact receiptが一致しません");
        }
        const outcome = await settleNotifications(
          {
            record: value.record,
            initialStateReceipt: initial,
            initialPages: {
              kind: "published",
              buildReceipt: build.receipt,
              deploymentReceipt: deployed.receipt,
              evidence: deployed.evidence,
            },
            pagesReceipt: deployed.receipt,
          },
          createNotificationSettlementPort(
            adapters,
            configuration.target.state,
            initialState.snapshot.repositories,
            configuration.credentials.knownSecrets,
            configuration.target.kind === "production" ? "production" : "recording",
          ),
        );
        if (outcome.kind !== "settled") {
          throw new NotificationSettlementFailureError(outcome);
        }
        await appendEntries(...outcome.messageReceipts, {
          receipt: outcome.receipt,
          evidence: outcome.receiptEvidence,
        });
      },
      run_finalization: async (value: RecoveryStageInput) => {
        if (value.stage !== "run_finalization") {
          throw new TypeError("run finalizationの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const initial = initialReceipt(entries);
        const settlement = entries.some(
          (entry) => entry.receipt.receiptType === "notification_settlement",
        )
          ? settlementReceipt(entries)
          : value.resumeInput.notificationSettlementReceipt;
        if (!entries.some((entry) => entry.receipt.receiptType === "notification_settlement")) {
          if (value.resumeInput.notificationSettlementEvidence == null) {
            throw new TypeError("通知settlementの再観測証拠がありません");
          }
          await appendEntries({
            receipt: settlement,
            evidence: {
              kind: "state_commit",
              state: value.resumeInput.notificationSettlementEvidence,
            },
          });
        }
        const settledState = await readNotificationMessageState(
          adapters.createStateBranchAdapter(),
          configuration.target.state,
          value.exactStateRevision,
        );
        const outcome = await finalizeRun(
          { record: value.record, initialStateReceipt: initial, settlementReceipt: settlement },
          createNotificationSettlementPort(
            adapters,
            configuration.target.state,
            settledState.snapshot.repositories,
            configuration.credentials.knownSecrets,
            configuration.target.kind === "production" ? "production" : "recording",
          ),
        );
        if (outcome.kind !== "finalized") {
          throw new TypeError(`run finalizationを確定できません。状態: ${outcome.kind}`);
        }
        await appendEntries({ receipt: outcome.receipt, evidence: outcome.receiptEvidence });
      },
      notification_history_build: async (value: RecoveryStageInput) => {
        if (value.stage !== "notification_history_build") {
          throw new TypeError("通知履歴Pages buildの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const settlement = settlementReceipt(entries);
        const finalization = entries.some(
          (entry) => entry.receipt.receiptType === "run_finalization",
        )
          ? finalizationReceipt(entries)
          : value.resumeInput.runFinalizationReceipt;
        if (!entries.some((entry) => entry.receipt.receiptType === "run_finalization")) {
          if (value.resumeInput.runFinalizationEvidence == null) {
            throw new TypeError("run finalizationの再観測証拠がありません");
          }
          await appendEntries({
            receipt: finalization,
            evidence: {
              kind: "state_commit",
              state: value.resumeInput.runFinalizationEvidence,
            },
          });
        }
        const saved = await optionalArtifactBytes(
          adapters,
          "artifacts/workflow/notification-history-pages-build.json",
        );
        if (saved != null) {
          const artifact = decodeNotificationHistoryPagesBuildArtifact(saved);
          if (
            artifact.receipt.binding.bindingKind !== "checkpoint" ||
            artifact.receipt.binding.runId !== value.record.runIdentity.runId ||
            artifact.receipt.binding.checkpointDigest !== value.record.checkpointDigest ||
            artifact.sourceStateRevision !== value.exactStateRevision ||
            artifact.receipt.previousReceiptDigest !== finalization.receiptDigest
          ) {
            throw new TypeError("保存済み通知履歴Pages build artifactがexact runと一致しません");
          }
          await appendEntries({ receipt: artifact.receipt, evidence: { kind: "none" } });
          return;
        }
        const built = await buildDailyNotificationHistoryPages(adapters, {
          configuration,
          settlementReceipt: settlement,
          finalizationReceipt: finalization,
        });
        await appendEntries({ receipt: built.receipt, evidence: { kind: "none" } });
      },
      notification_history_deploy: async (value: RecoveryStageInput) => {
        if (value.stage !== "notification_history_deploy") {
          throw new TypeError("通知履歴Pages deployの再開段階が一致しません");
        }
        const artifact = decodeNotificationHistoryPagesBuildArtifact(
          await requiredArtifactBytes(
            adapters,
            "artifacts/workflow/notification-history-pages-build.json",
          ),
        );
        if (artifact.receipt.receiptDigest !== value.buildReceipt.receiptDigest) {
          throw new TypeError("保存済み通知履歴Pages build artifactとexact receiptが一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const deployment = await deployDailyNotificationHistoryPages(adapters, {
          configuration,
          prepared: artifact,
          settlementReceipt: settlementReceipt(entries),
          finalizationReceipt: finalizationReceipt(entries),
          runId: value.record.runIdentity.runId,
        });
        await appendEntries({ receipt: deployment.deployment.receipt, evidence: { kind: "none" } });
      },
    }),
    complete: async () => {
      const entries = await readEntries();
      const finalization = finalizationReceipt(entries);
      return completeTrackingRun(
        {
          entries,
          finalStateRevision: finalization.result.resultingStateRevision,
          invocationId,
          observedAt: adapters.now().toISOString(),
        },
        nodeContentDigestPort,
      );
    },
  });
}

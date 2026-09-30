import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { serializeCanonicalJson } from "../canonical-json/value.js";
import { decodeReceipt } from "../application/tracking-run/receipt-codec.js";
import type { ReceiptChainEntry } from "../application/tracking-run/receipt-chain-schema.js";
import type { Config } from "../config/index.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import type { StateBranchAdapter } from "../persistence/index.js";
import { decodeInitialPagesBuildArtifact } from "./initial-pages-build-artifact.js";
import {
  preflightInitialPagesDeployment,
  readInitialPagesDeploymentOutcome,
} from "./initial-pages-deployment.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "./notification-history-pages-deployment-outcome.js";
import { preflightNotificationHistoryPagesDeployment } from "./notification-history-pages-deployment.js";
import type { ProductionRuntimeAdapters } from "./production-runtime/adapters.js";
import { workflowAdapterIdentityV2 } from "./publication-runtime.js";
import { prepareWorkflowNotificationHistoryPages } from "./run-publication/workflow-history-pages.js";
import { buildWorkflowPages } from "./run-publication/workflow-stage-handlers.js";
import type { SplitStagePaths } from "./split-stage-paths.js";
import { restoreSplitHistoryPagesArtifact } from "./split-stage-pages-recovery.js";
import { restoreSplitInitialPagesArtifacts } from "./split-stage-receipts.js";

const artifactSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1),
  workflowRunId: z.number().int().positive(),
});
const pageSchema = artifactSchema.extend({ runAttempt: z.number().int().positive() });
const witnessSchema = z.strictObject({
  phase: z.enum(["initial", "notification_history"]),
  trackingRunId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  status: z.enum(["no_previous", "downloaded"]),
  stageArtifact: artifactSchema.nullable(),
  individualArtifact: artifactSchema.nullable(),
  pagesArtifact: pageSchema.nullable(),
});

type Witness = z.output<typeof witnessSchema>;

async function readWitness(
  adapters: ProductionRuntimeAdapters,
  phase: Witness["phase"],
  runId: string,
): Promise<Witness | undefined> {
  const prefix = phase === "initial" ? "INITIAL" : "HISTORY";
  const path = adapters.environment[`VOICEVOX_PRIOR_${prefix}_EVIDENCE_PATH`];
  if (path == null) return undefined;
  const witness = witnessSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (
    witness.phase !== phase ||
    witness.trackingRunId !== runId ||
    witness.status !== adapters.environment[`VOICEVOX_PREVIOUS_${prefix}_OUTCOME_STATUS`]
  ) {
    throw new TypeError("Pages保持artifactの取得状態とrunが一致しません");
  }
  if (
    witness.stageArtifact != null &&
    witness.stageArtifact.name !==
      (phase === "initial"
        ? "tracking-stage-initial-pages"
        : "tracking-stage-notification-history-pages")
  ) {
    throw new TypeError("Pages保持artifactの段階名が一致しません");
  }
  return witness;
}

function assertPagesArtifact(
  witness: Witness,
  reference: {
    kind: string;
    actionsArtifact?: { kind: string; artifactId?: string; artifactName?: string };
    recordingId?: string;
  },
): void {
  const page = witness.pagesArtifact;
  if (page == null) {
    throw new TypeError("保存済みPages receiptのActions artifactがありません");
  }
  const suffix = witness.phase === "initial" ? "initial" : "notification-history";
  const match = new RegExp(
    `^(tracking|sandbox)-pages-([1-9][0-9]*)-([1-9][0-9]*)-${suffix}$`,
    "u",
  ).exec(page.name);
  if (
    match == null ||
    Number(match[2]) !== page.workflowRunId ||
    Number(match[3]) !== page.runAttempt ||
    (reference.kind === "github_pages_actions" && match[1] !== "tracking") ||
    (reference.kind === "recording" && match[1] !== "sandbox")
  ) {
    throw new TypeError("Pages receiptのActions run、attempt、artifact名が一致しません");
  }
  if (reference.kind === "github_pages_actions") {
    const artifact = reference.actionsArtifact;
    if (
      artifact == null ||
      (artifact.kind === "not_exposed"
        ? artifact.artifactName !== page.name
        : artifact.artifactId !== String(page.id))
    ) {
      throw new TypeError("Pages receiptのActions artifact参照が一致しません");
    }
  } else if (
    reference.kind !== "recording" ||
    reference.recordingId !== `${page.name}:${String(page.id)}`
  ) {
    throw new TypeError("Pages receiptの記録artifact参照が一致しません");
  }
}

/** 保持artifactの初回Pages成功証拠をexact stateと同一contentへ照合する。 */
export async function validateRetainedInitialPages(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  configPath: string,
  config: Config,
  adapter: StateBranchAdapter,
  effectTarget: "production" | "sandbox" | "recording",
): Promise<void> {
  const witness = await readWitness(adapters, "initial", runId);
  if (witness?.status !== "downloaded") return;
  const original = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
  const outcome = await readInitialPagesDeploymentOutcome(paths.initialDeployment, original);
  if (outcome.kind !== "success") {
    if (outcome.effectCertainty === "no_effect") return;
    throw new TypeError("初回Pagesの保存結果が成功を確定していません");
  }
  if (witness.stageArtifact == null) {
    throw new TypeError("初回Pagesの元build artifactがありません");
  }
  assertPagesArtifact(witness, outcome.evidence.externalReference);
  const initial = decodeReceipt(await readFile(paths.initialReceipt), digest);
  if (initial.receiptType !== "initial_state_commit") {
    throw new TypeError("保持された初回Pagesの初回state receiptが不正です");
  }
  const temp = await mkdtemp(join(tmpdir(), "tracking-prior-initial-pages-"));
  try {
    const regeneratedPath = join(temp, "initial-pages-build.json");
    await buildWorkflowPages(
      { adapters },
      {
        kind: "build-pages",
        configPath,
        initialStateReceiptPath: paths.initialReceipt,
        buildArtifactPath: regeneratedPath,
        outputDirectory: paths.pagesOutput,
      },
    );
    const regenerated = decodeInitialPagesBuildArtifact(await readFile(regeneratedPath));
    if (
      serializeCanonicalJson(regenerated.intent) !== serializeCanonicalJson(original.intent) ||
      serializeCanonicalJson(regenerated.manifest) !== serializeCanonicalJson(original.manifest)
    ) {
      throw new TypeError("保持された初回Pagesと現在の同一stateのcontentが一致しません");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const preflight = await preflightInitialPagesDeployment({
    adapter,
    configuration: config.state,
    repositoryPath: adapters.repositoryPath,
    artifact: original,
    initialStateCommitReceipt: initial,
    previousOutcome: outcome,
    replay: true,
    observedAt: adapters.now().toISOString(),
    effectTarget,
    ...(effectTarget === "production"
      ? { adapterIdentityDigest: await workflowAdapterIdentityV2(adapters.repositoryPath, digest) }
      : {}),
  });
  if (preflight.kind !== "observed") {
    throw new TypeError("保持された初回Pages receiptをremote stateへ再観測できません");
  }
}

/** 保持artifactの通知履歴Pages成功証拠をfinal stateと同一contentへ照合する。 */
export async function validateRetainedHistoryPages(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  configPath: string,
  config: Config,
  adapter: StateBranchAdapter,
  effectTarget: "production" | "sandbox" | "recording",
): Promise<void> {
  const witness = await readWitness(adapters, "notification_history", runId);
  if (witness?.status !== "downloaded") return;
  if (witness.stageArtifact == null) {
    throw new TypeError("通知履歴Pagesの元build artifactがありません");
  }
  const original = decodeNotificationHistoryPagesBuildArtifact(await readFile(paths.historyBuild));
  const outcome = decodeNotificationHistoryPagesDeploymentOutcome(
    await readFile(paths.historyDeployment),
    original,
  );
  if (outcome.kind === "failure") {
    if (outcome.failedOperationEffectCertainty === "no_effect") return;
    throw new TypeError("通知履歴Pagesの保存結果が成功を確定していません");
  }
  if (outcome.kind === "deployed") {
    const reference = outcome.receipt.result?.externalReference;
    if (reference == null) throw new TypeError("通知履歴Pagesの公開先参照がありません");
    assertPagesArtifact(witness, reference);
  }
  const temp = await mkdtemp(join(tmpdir(), "tracking-prior-history-pages-"));
  try {
    const regeneratedPath = join(temp, "notification-history-pages-build.json");
    await prepareWorkflowNotificationHistoryPages(adapters, {
      kind: "prepare-notification-history-pages",
      configPath,
      settlementReceiptPath: paths.settlementReceipt,
      finalizationReceiptPath: paths.finalizationReceipt,
      buildArtifactPath: regeneratedPath,
      outputDirectory: paths.pagesOutput,
    });
    const regenerated = decodeNotificationHistoryPagesBuildArtifact(
      await readFile(regeneratedPath),
    );
    if (
      original.status !== regenerated.status ||
      original.sourceStateRevision !== regenerated.sourceStateRevision ||
      (original.status === "built" &&
        (regenerated.status !== "built" ||
          serializeCanonicalJson(original.intent) !== serializeCanonicalJson(regenerated.intent) ||
          serializeCanonicalJson(original.manifest) !==
            serializeCanonicalJson(regenerated.manifest))) ||
      (original.status === "not_required" &&
        (regenerated.status !== "not_required" || original.reason !== regenerated.reason))
    ) {
      throw new TypeError("保持された通知履歴Pagesと現在のfinal stateのcontentが一致しません");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const settlement = decodeReceipt(await readFile(paths.settlementReceipt), digest);
  const finalization = decodeReceipt(await readFile(paths.finalizationReceipt), digest);
  if (
    settlement.receiptType !== "notification_settlement" ||
    finalization.receiptType !== "run_finalization"
  ) {
    throw new TypeError("通知履歴Pagesの保存済みstate receiptが不正です");
  }
  const preflight = await preflightNotificationHistoryPagesDeployment({
    adapter,
    config,
    configuration: config.state,
    repositoryPath: adapters.repositoryPath,
    artifact: original,
    settlementReceipt: settlement,
    finalizationReceipt: finalization,
    previousOutcome: outcome,
    replay: true,
    observedAt: adapters.now().toISOString(),
    effectTarget,
    ...(effectTarget === "production"
      ? { adapterIdentityDigest: await workflowAdapterIdentityV2(adapters.repositoryPath, digest) }
      : {}),
  });
  if (preflight.kind !== "observed" && preflight.kind !== "not_required") {
    throw new TypeError("保持された通知履歴Pages receiptをfinal stateへ再観測できません");
  }
}

/** 保持された両Pages段階の証拠を効果前に照合する。 */
export async function validateRetainedPages(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  entries: readonly ReceiptChainEntry[],
  runId: string,
  configPath: string,
  state: Readonly<{
    config: Config;
    adapter: StateBranchAdapter;
    effectTarget: "production" | "sandbox" | "recording";
  }>,
): Promise<void> {
  await restoreSplitInitialPagesArtifacts(adapters, paths, entries, configPath);
  await restoreSplitHistoryPagesArtifact(adapters, paths, entries);
  await validateRetainedInitialPages(
    adapters,
    paths,
    runId,
    configPath,
    state.config,
    state.adapter,
    state.effectTarget,
  );
  await validateRetainedHistoryPages(
    adapters,
    paths,
    runId,
    configPath,
    state.config,
    state.adapter,
    state.effectTarget,
  );
}

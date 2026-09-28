import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createPagesDeploymentIntent } from "../../application/tracking-run/pages-build-contracts.js";
import { createReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { InitialStateCommitReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { loadWebConfig } from "../../config/index.js";
import type { Config } from "../../config/index.js";
import { createGitHubRepositoryId } from "../../domain/index.js";
import { nodeContentDigestPort as digest } from "../../infrastructure/tracking-run/content-digest.js";
import { generatePublicData, readPagesContentManifest } from "../../pages/index.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "../../persistence/index.js";
import { readInitialPagesSource } from "../initial-pages-source.js";
import type { InitialPagesPreparedRun, RunPublicationAdapters } from "./contracts.js";

/** exact stateから初回Pages成果物を作る接続。 */
export type BuildPublicPagesInput = Readonly<{
  adapter: StateBranchAdapter;
  config: Config;
  stateConfiguration: StatePersistenceConfiguration;
  initialStateCommitReceipt: InitialStateCommitReceipt;
  repositoryPath: string;
  outputDirectory: string;
  knownSecrets: readonly string[];
  writePublicData: RunPublicationAdapters["writePublicData"];
  buildWebOutput: RunPublicationAdapters["buildWebOutput"];
  now: RunPublicationAdapters["now"];
}>;

async function assertBuiltDataFiles(
  output: InitialPagesPreparedRun["output"],
  manifest: InitialPagesPreparedRun["manifest"],
): Promise<void> {
  const dataFiles: readonly (readonly [string, string])[] = [
    ["summary.json", output.summaryPath],
    ["details.json", output.detailsPath],
    ["notification-history.json", output.notificationHistoryPath],
  ];
  for (const [name, path] of dataFiles) {
    const entry = manifest.files.find((file) => file.path === `data/${name}`);
    const bytes = await readFile(path);
    if (entry?.byteLength !== bytes.byteLength || entry.sha256 !== digest.sha256Bytes(bytes)) {
      throw new TypeError("Pages buildの公開DTOとWeb出力manifestが一致しません");
    }
  }
}

/** recordと初回commit receiptのexact stateからPagesを投影、buildして固定する。 */
export async function buildPublicPages(
  input: BuildPublicPagesInput,
): Promise<InitialPagesPreparedRun> {
  const dataDirectory = resolve(input.repositoryPath, "web/public/data");
  if (resolve(input.outputDirectory) !== dataDirectory) {
    throw new TypeError("Pages公開DTOの出力先がWeb buildの入力directoryと一致しません");
  }
  const webConfig = await loadWebConfig(resolve(input.repositoryPath, "config.yml"));
  if (serializeCanonicalJson(webConfig) !== serializeCanonicalJson(input.config.web)) {
    throw new TypeError("Pages buildのWeb設定が初回commitの設定と一致しません");
  }
  const source = await readInitialPagesSource(
    input.adapter,
    input.config,
    input.stateConfiguration,
    input.initialStateCommitReceipt,
    input.knownSecrets,
    input.now,
  );
  const record = source.resume.record;
  const projection = record.initialPagesProjection;
  const data = generatePublicData({
    snapshot: source.snapshot,
    historyRecords: source.historyRecords,
    repositoryAllowlist: projection.repositoryAllowlist.map((repository) => ({
      ...repository,
      id: createGitHubRepositoryId(repository.id),
    })),
    repositoryInventory: source.snapshot.repositories,
    knownSecrets: input.knownSecrets,
    options: {
      confidenceThresholds: projection.settings.confidenceThresholds,
      labelRules: projection.settings.labelRules,
      maxInitialGraphNodes: projection.settings.maxInitialGraphNodes,
      maxSummaryGzipBytes: projection.settings.maxSummaryGzipBytes,
      timezone: projection.settings.timezone,
    },
  });
  if (
    data.summary.runId !== record.runIdentity.runId ||
    data.summary.generatedAt !== projection.generatedAt
  ) {
    throw new TypeError("Pages公開DTOのrunと生成時刻がrecordと一致しません");
  }
  const output = await input.writePublicData(dataDirectory, data);
  await input.buildWebOutput(input.repositoryPath);
  const outputManifest = await readPagesContentManifest(resolve(input.repositoryPath, "dist/web"));
  await assertBuiltDataFiles(output, outputManifest.manifest);
  const intent = createPagesDeploymentIntent(
    {
      runId: record.runIdentity.runId,
      checkpointDigest: record.checkpointDigest,
      recordDigest: record.recordDigest,
      sourceStateRevision: source.resume.state.revision,
      snapshotDigest: source.resume.state.snapshotDigest,
      repositoryAllowlistDigest: projection.repositoryAllowlistDigest,
      outputManifestDigest: outputManifest.outputManifestDigest,
      pagesContentDigest: outputManifest.pagesContentDigest,
      outputDirectory: "dist/web",
      expectedPageUrl: projection.settings.url,
    },
    digest,
  );
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "pages_build",
      stage: "initial_pages_prepared",
      phase: "initial",
      binding: source.resume.initialStateCommitReceipt.binding,
      logicalTarget: intent.deploymentIntentDigest,
      invocationId: randomUUID(),
      localAttemptIndex: 0,
      phaseSequence: source.resume.initialStateCommitReceipt.phaseSequence + 1,
      previousReceiptDigest: source.resume.initialStateCommitReceipt.receiptDigest,
      expectedStateRevision: source.resume.state.revision,
      receiptKind: "executed",
      observedAt: input.now().toISOString(),
      status: "built",
      effectCertainty: "committed",
      result: {
        deploymentIntentDigest: intent.deploymentIntentDigest,
        pagesContentDigest: intent.pagesContentDigest,
        outputManifestDigest: intent.outputManifestDigest,
        sourceStateRevision: intent.sourceStateRevision,
      },
    },
    digest,
  );
  if (receipt.receiptType !== "pages_build") {
    throw new TypeError("初回Pages build receiptの種別が不正です");
  }
  return Object.freeze({
    data,
    output,
    pagesUrl: projection.settings.url,
    manifest: outputManifest.manifest,
    intent,
    receipt,
  });
}

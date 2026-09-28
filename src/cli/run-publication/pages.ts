import { assertValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import type { PublicationPlannedRun } from "../../publication/publication-plan-contracts.js";
import type { Repository } from "../../domain/index.js";
import { generatePublicData } from "../../pages/index.js";
import type { StateHistoryRecord } from "../../persistence/index.js";
import type {
  PagesResult,
  RunPublicationAdapters,
} from "./contracts.js";

/** Pages成果物の生成と書込みに必要な値。 */
export type BuildPublicPagesInput = Readonly<{
  writePublicData: RunPublicationAdapters["writePublicData"];
  inventory: readonly Repository[];
  planned: PublicationPlannedRun;
  historyRecords: readonly StateHistoryRecord[];
  outputDirectory: string;
  knownSecrets: readonly string[];
}>;

/** 検証済みsnapshotと保存後履歴からPages成果物を生成して書き込む。 */
export async function buildPublicPages(input: BuildPublicPagesInput): Promise<PagesResult> {
  const { validated, publicationPlan } = input.planned;
  assertValidatedRun(validated);
  const projection = publicationPlan.initialPagesProjection;
  const data = generatePublicData({
    snapshot: publicationPlan.initialStateWriteSet.snapshot,
    historyRecords: input.historyRecords,
    repositoryAllowlist: projection.repositoryAllowlist,
    repositoryInventory: input.inventory,
    knownSecrets: input.knownSecrets,
    options: {
      confidenceThresholds: projection.settings.confidenceThresholds,
      labelRules: projection.settings.labelRules,
      maxInitialGraphNodes: projection.settings.maxInitialGraphNodes,
      maxSummaryGzipBytes: projection.settings.maxSummaryGzipBytes,
      timezone: projection.settings.timezone,
    },
  });
  const output = await input.writePublicData(input.outputDirectory, data);
  return Object.freeze({
    data,
    output,
    pagesUrl: projection.settings.url,
  });
}

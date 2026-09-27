import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { PreparedRun } from "../prepare-run.js";
import type { ContentDigestPort } from "../ports.js";
import { createInventoryCollectedStageProof } from "../contracts/proofs.js";
import { projectAnalysisRunCore, type StageState } from "../contracts/run-core.js";

/** GitHub portが確定した公開repositoryと非secret認証情報。 */
export type RepositoryInventoryObservation = Readonly<{
  approvedRepositories: readonly PublicRepository[];
  installationId: number;
  githubApiRemaining: number;
  diagnostics: readonly string[];
}>;

/** repository inventory取得に必要なGitHub副作用境界。 */
export type RepositoryInventoryPort = Readonly<{
  collect: (prepared: PreparedRun) => Promise<RepositoryInventoryObservation>;
}>;

/** 公開repositoryの選定と認証metadataが確定したrun。 */
export type InventoryCollectedRun = StageState<
  "inventory_collected",
  {
    approvedRepositories: readonly PublicRepository[];
    allowlistDigest: Sha256Hash;
    session: Readonly<{ installationId: number }>;
    metrics: Readonly<{ repositoryCount: number; githubApiRemaining: number }>;
    diagnostics: readonly string[];
  }
>;

/** 一つのGitHub portから公開repository一覧とdigestを固定する。 */
export async function collectRepositoryInventory(
  prepared: PreparedRun,
  port: RepositoryInventoryPort,
  digest: ContentDigestPort,
): Promise<InventoryCollectedRun> {
  const observation = await port.collect(prepared);
  if (!Number.isSafeInteger(observation.installationId) || observation.installationId <= 0) {
    throw new TypeError("GitHub installation IDが不正です");
  }
  const approvedRepositories = Object.freeze([...observation.approvedRepositories]);
  const allowlistDigest = digest.sha256Utf8(
    serializeCanonicalJson(
      approvedRepositories.map((repository) => ({
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        visibility: repository.visibility,
        archived: repository.archived,
        disabled: repository.disabled,
      })),
    ),
  );
  return Object.freeze({
    stage: "inventory_collected",
    core: projectAnalysisRunCore(prepared.core),
    data: Object.freeze({
      approvedRepositories,
      allowlistDigest,
      session: Object.freeze({ installationId: observation.installationId }),
      metrics: Object.freeze({
        repositoryCount: approvedRepositories.length,
        githubApiRemaining: observation.githubApiRemaining,
      }),
      diagnostics: Object.freeze([...observation.diagnostics]),
    }),
    proof: createInventoryCollectedStageProof(),
  });
}

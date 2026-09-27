import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { Repository } from "../../../domain/types.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { PreparedBaseStateShape, PreparedRun } from "../prepare-run.js";
import type { ContentDigestPort } from "../ports.js";
import { createInventoryCollectedStageProof, type StageProofFor } from "../contracts/proofs.js";

/** GitHub portが確定した公開repositoryと非secret認証情報。 */
export type RepositoryInventoryObservation = Readonly<{
  inventory: readonly Repository[];
  approvedRepositories: readonly PublicRepository[];
  installationId: number;
  githubApiRemaining: number;
  diagnostics: readonly string[];
}>;

/** repository inventory取得に必要なGitHub副作用境界。 */
export type RepositoryInventoryPort<BaseState extends PreparedBaseStateShape> = Readonly<{
  collect: (prepared: PreparedRun<BaseState>) => Promise<RepositoryInventoryObservation>;
}>;

/** 公開repositoryの選定と認証metadataが確定したrun。 */
export type InventoryCollectedRun<BaseState extends PreparedBaseStateShape> = Readonly<{
  stage: "inventory_collected";
  core: PreparedRun<BaseState>["core"];
  data: Readonly<{
    request: PreparedRun<BaseState>["data"]["request"];
    approvedRepositories: readonly PublicRepository[];
    allowlistDigest: Sha256Hash;
    session: Readonly<{ installationId: number }>;
    metrics: Readonly<{ repositoryCount: number; githubApiRemaining: number }>;
    diagnostics: readonly string[];
  }>;
  proof: StageProofFor<"inventory_collected">;
}>;

/** 一つのGitHub portから公開repository一覧とdigestを固定する。 */
export async function collectRepositoryInventory<BaseState extends PreparedBaseStateShape>(
  prepared: PreparedRun<BaseState>,
  port: RepositoryInventoryPort<BaseState>,
  digest: ContentDigestPort,
): Promise<InventoryCollectedRun<BaseState>> {
  const observation = await port.collect(prepared);
  if (!Number.isSafeInteger(observation.installationId) || observation.installationId <= 0) {
    throw new TypeError("GitHub installation IDが不正です");
  }
  const approvedRepositories = Object.freeze([...observation.approvedRepositories]);
  const inventoryById = new Map(
    observation.inventory.map((repository) => [repository.id, repository]),
  );
  if (inventoryById.size !== observation.inventory.length) {
    throw new TypeError("repository inventoryのIDが重複しています");
  }
  for (const repository of approvedRepositories) {
    const inventoryRepository = inventoryById.get(repository.id);
    if (inventoryRepository == null) {
      throw new TypeError("公開repository一覧とinventoryが一致しません");
    }
    if (
      inventoryRepository.owner !== repository.owner ||
      inventoryRepository.name !== repository.name ||
      inventoryRepository.visibility !== "public" ||
      inventoryRepository.archived ||
      inventoryRepository.disabled
    ) {
      throw new TypeError("公開repository一覧とinventoryが一致しません");
    }
  }
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
    core: prepared.core,
    data: Object.freeze({
      request: prepared.data.request,
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

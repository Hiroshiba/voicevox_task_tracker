import type {
  NormalizedBaseState,
  RepositoryInventory,
} from "../../production-runtime/contracts.js";
import type { InventoryCollectedRun } from "../../../application/tracking-run/stages/inventory.js";
import { PublicRepositoryAllowlist } from "../../../github/public-repository-allowlist.js";

/** 未移行の公開処理へinventoryと同じ公開repository集合を投影する。 */
export function projectLegacyRepositoryInventory(
  run: InventoryCollectedRun<NormalizedBaseState>,
): RepositoryInventory {
  return Object.freeze({
    inventory: run.data.approvedRepositories,
    allowlist: PublicRepositoryAllowlist.fromApprovedRepositories(run.data.approvedRepositories),
  });
}

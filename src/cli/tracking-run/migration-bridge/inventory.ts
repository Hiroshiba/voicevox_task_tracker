import type { RepositoryInventory } from "../../production-runtime/contracts.js";
import type { InventoryCollectedRun } from "../../../application/tracking-run/stages/inventory.js";

/** 未移行の公開処理へinventoryと同じ公開repository集合を投影する。 */
export function projectLegacyRepositoryInventory(run: InventoryCollectedRun): RepositoryInventory {
  return Object.freeze({
    inventory: run.data.allowlist.repositories,
    allowlist: run.data.allowlist,
  });
}

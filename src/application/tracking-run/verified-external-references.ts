import {
  normalizeVerifiedExternalReferences,
  type VerifiedExternalReference,
} from "../../domain/verified-external-reference.js";
import type { RelationCandidate } from "../../graph/index.js";
import { relationNodes } from "../../graph/relation-candidate-endpoints.js";

/** 前回の証拠と今回の詳細確認済み候補から公開外部参照を固定する。 */
export function collectVerifiedExternalReferences(
  previous: readonly VerifiedExternalReference[],
  candidates: readonly RelationCandidate[],
): readonly VerifiedExternalReference[] {
  return normalizeVerifiedExternalReferences([
    ...previous,
    ...candidates.flatMap((candidate) =>
      relationNodes(candidate.relation).flatMap((node) =>
        node.scope === "external_public"
          ? [
              {
                repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                number: node.number,
                url: node.url,
              },
            ]
          : [],
      ),
    ),
  ]);
}

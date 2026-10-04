import { createHash } from "node:crypto";

import { z } from "zod";

import { GitHubPublicBoundaryViolationError } from "../../github/errors.js";
import type { PrivateRepositoryReferenceFinding } from "../../github/private-repository-reference.js";

const fieldKindSchema = z.enum([
  "items",
  "details",
  "observedItems",
  "repositories",
  "comments",
  "timelineEvents",
  "body",
  "bodyText",
  "title",
  "description",
  "url",
  "htmlUrl",
  "id",
  "repositoryId",
  "owner",
  "name",
]);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const diagnosticSchema = z.strictObject({
  reason: z.enum([
    "private_repository_id",
    "private_repository_url",
    "private_repository_name",
    "scanner_text_limit",
    "scanner_invalid_encoding",
    "scanner_candidate_characters_limit",
    "scanner_candidate_count_limit",
    "scanner_decode_depth_limit",
  ]),
  path: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("array_index"), index: z.number().int().nonnegative() }),
      z.strictObject({ kind: z.literal("field"), field: fieldKindSchema }),
      z.strictObject({ kind: z.literal("property"), keyHash: hashSchema }),
    ]),
  ),
  valueHash: hashSchema,
});
type PublicBoundaryDiagnostic = z.output<typeof diagnosticSchema>;

const diagnostics = new WeakMap<Error, PublicBoundaryDiagnostic>();

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 原文を保持せず暗号化診断用の停止理由を公開境界エラーに結び付ける。 */
export function createPublicBoundaryDiagnosticError(
  finding: PrivateRepositoryReferenceFinding,
): GitHubPublicBoundaryViolationError {
  const path = finding.path.map((segment) => {
    if (typeof segment === "number") {
      return { kind: "array_index" as const, index: segment };
    }
    const field = fieldKindSchema.safeParse(segment);
    return field.success
      ? { kind: "field" as const, field: field.data }
      : { kind: "property" as const, keyHash: hash(segment) };
  });
  const diagnostic = diagnosticSchema.parse({
    reason: finding.reason,
    path,
    valueHash: hash(finding.value),
  });
  const error = new GitHubPublicBoundaryViolationError(1);
  diagnostics.set(error, diagnostic);
  return error;
}

/** 原因連鎖にある公開境界の停止理由を暗号化対象の詳細情報へ取り出す。 */
export function publicBoundaryDiagnosticDetails(
  error: unknown,
): Readonly<{ publicBoundary?: readonly PublicBoundaryDiagnostic[] }> {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  const found: PublicBoundaryDiagnostic[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const diagnostic = diagnostics.get(current);
    if (diagnostic != null) {
      found.push(diagnostic);
    }
    pending.push(current.cause);
    if (current instanceof AggregateError) {
      const errors: readonly unknown[] = current.errors;
      pending.push(...errors);
    }
  }
  return found.length === 0 ? {} : { publicBoundary: found };
}

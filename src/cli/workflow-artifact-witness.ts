import { z } from "zod";

import type { EvidenceClosureWitness } from "../application/tracking-run/stages/run-validation-artifact-witness.js";
import { buildSourceId, parseSourceId } from "../domain/source-id.js";
import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
} from "../domain/index.js";
import { aiAnalysisElementSchema } from "../domain/ai-analysis-elements.js";
import { personalReminderCauseIdSchema } from "../domain/personal-reminder-causes.js";
import { parseSha256Hash } from "../canonical-json/sha256.js";

const sourceIdSchema = z.string().transform((value) => {
  const source = parseSourceId(value);
  return buildSourceId(source.kind, source.originalId);
});
const nodeIdSchema = z.string().min(1).transform(createGitHubNodeId);
const repositoryIdSchema = z.string().min(1).transform(createGitHubRepositoryId);
const dateTimeSchema = z.iso.datetime({ offset: true }).transform(createUtcIsoDateTime);
const sha256Schema = z.string().transform(parseSha256Hash);
const immutableSchema = z
  .strictObject({
    nodeId: nodeIdSchema.optional(),
    repositoryId: repositoryIdSchema.optional(),
    itemType: z.enum(["issue", "pull_request"]).optional(),
    itemNumber: z.number().int().nonnegative().optional(),
    actorNodeId: nodeIdSchema.optional(),
    occurredAt: dateTimeSchema.optional(),
    committedAt: dateTimeSchema.optional(),
    sha: z.string().optional(),
    recordKind: z.string().optional(),
    relatedNodeId: nodeIdSchema.optional(),
    relationKind: z.string().optional(),
  })
  .transform((value) => ({
    ...(value.nodeId == null ? {} : { nodeId: value.nodeId }),
    ...(value.repositoryId == null ? {} : { repositoryId: value.repositoryId }),
    ...(value.itemType == null ? {} : { itemType: value.itemType }),
    ...(value.itemNumber == null ? {} : { itemNumber: value.itemNumber }),
    ...(value.actorNodeId == null ? {} : { actorNodeId: value.actorNodeId }),
    ...(value.occurredAt == null ? {} : { occurredAt: value.occurredAt }),
    ...(value.committedAt == null ? {} : { committedAt: value.committedAt }),
    ...(value.sha == null ? {} : { sha: value.sha }),
    ...(value.recordKind == null ? {} : { recordKind: value.recordKind }),
    ...(value.relatedNodeId == null ? {} : { relatedNodeId: value.relatedNodeId }),
    ...(value.relationKind == null ? {} : { relationKind: value.relationKind }),
  }));
const commonSourceFields = {
  sourceId: sourceIdSchema,
  origin: z.enum(["enumerated_item", "item_detail", "normalized_item"]),
  immutable: immutableSchema,
};
const currentSourceSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    ...commonSourceFields,
    scope: z.literal("shared"),
    sourceKind: z.enum([
      "github_actor",
      "github_user",
      "github_team",
      "github_item",
      "github_commit",
      "github_label",
      "github_check_run",
      "github_commit_status",
      "github_status_check_rollup",
    ]),
  }),
  z.strictObject({
    ...commonSourceFields,
    scope: z.literal("item"),
    sourceKind: z.enum([
      "github_issue_comment",
      "github_pull_request_commit",
      "github_timeline_event",
      "github_inbound_cross_reference",
      "github_pull_request_review",
      "github_pull_request_review_comment",
      "github_pull_request_review_thread",
      "github_review_request",
      "github_native_closing_issue",
      "github_native_dependency",
      "github_native_hierarchy",
      "github_auto_merge_request",
      "github_merge_queue_entry",
      "github_item_detail",
      "github_item_body",
    ]),
    itemNodeId: nodeIdSchema,
  }),
]);
const historicalEvidenceSchema = z.strictObject({
  record: z.strictObject({
    status: z.literal("historical"),
    location: z.strictObject({
      container: z.enum(["previous_snapshot", "retained_value", "migration"]),
      path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    }),
    evidence: z.strictObject({
      sourceId: sourceIdSchema,
      supports: z.enum([
        "status",
        "waiting_on",
        "relation",
        "progress",
        "notification",
        "uncertainty",
        "self_commitment",
      ]),
      summary: z.string(),
    }),
  }),
  owner: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("item"),
      itemNodeId: nodeIdSchema,
      repositoryId: repositoryIdSchema,
    }),
    z.strictObject({
      kind: z.literal("relation"),
      relationId: z.string().min(1),
      fromNodeId: z.string().min(1),
      toNodeId: z.string().min(1),
    }),
  ]),
});
const evidenceUseSchema = z.strictObject({
  sourceId: sourceIdSchema,
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  destination: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("item"), itemNodeId: nodeIdSchema }),
    z.strictObject({ kind: z.literal("relation"), relationId: z.string().min(1) }),
  ]),
  purpose: z.string().min(1),
  requiredCurrentness: z.enum(["current", "historical_allowed"]),
  allowedOwnerNodeIds: z.array(z.string().min(1)),
  allowedRelationIds: z.array(z.string().min(1)),
});
const witnessSchema = z.strictObject({
  currentSources: z.array(currentSourceSchema),
  historicalEvidence: z.array(historicalEvidenceSchema),
  resolvedUses: z.array(
    z.strictObject({
      use: evidenceUseSchema,
      resolution: z.enum(["current", "historical"]),
      recordIdentity: z.string().min(1),
    }),
  ),
  materializedReferences: z.array(
    z.strictObject({
      sourceId: sourceIdSchema,
      path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
      owner: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("item"), id: z.string().min(1) }),
        z.strictObject({ kind: z.literal("relation"), id: z.string().min(1) }),
      ]),
    }),
  ),
  cacheOwners: z.strictObject({
    generic: z.array(
      z.strictObject({
        cacheKey: sha256Schema,
        itemNodeId: nodeIdSchema,
        element: aiAnalysisElementSchema,
        generationDigest: sha256Schema,
      }),
    ),
    personalReminder: z.array(
      z.strictObject({
        cacheKey: sha256Schema,
        itemNodeId: nodeIdSchema,
        causeId: personalReminderCauseIdSchema,
        generationDigest: sha256Schema,
      }),
    ),
  }),
});

/** v17 artifact内の公開可能なsource witnessを厳密に読む。 */
export function parseWorkflowEvidenceWitness(value: unknown): EvidenceClosureWitness {
  return witnessSchema.parse(value);
}

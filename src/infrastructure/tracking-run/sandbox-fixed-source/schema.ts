import { z } from "zod";

import { createUtcIsoDateTime } from "../../../domain/types.js";

const timestampSchema = z.iso.datetime({ offset: true }).transform(createUtcIsoDateTime);
const nodeIdSchema = z.string().min(1).regex(/^\S+$/u);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const itemBaseSchema = z.strictObject({
  key: z.enum(["A", "B", "C", "D"]),
  nodeId: nodeIdSchema,
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const pullRequestSchema = itemBaseSchema.extend({
  type: z.literal("pull_request"),
  headSha: shaSchema,
  headCommitNodeId: nodeIdSchema,
  headCommittedAt: timestampSchema,
  commentNodeId: nodeIdSchema,
  commentBody: z.string().min(1),
  commentAt: timestampSchema,
  nativeClosingIssueKeys: z.tuple([z.enum(["C", "D"])]),
});
const issueSchema = itemBaseSchema.extend({
  type: z.literal("issue"),
  closedAt: timestampSchema,
});

/** 合成GitHub入力と2回のrun時計を検証する正本schema。 */
export const sandboxFixedSourceDatasetSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    organization: z.literal("VOICEVOX"),
    installationId: z.number().int().positive(),
    rateLimit: z.strictObject({
      limit: z.number().int().positive(),
      remaining: z.number().int().nonnegative(),
    }),
    repository: z.strictObject({
      nodeId: nodeIdSchema,
      name: z.string().min(1),
      visibility: z.literal("public"),
      archived: z.literal(false),
      disabled: z.literal(false),
    }),
    clock: z.strictObject({
      first: z.strictObject({ startedAt: timestampSchema, evaluatedAt: timestampSchema }),
      second: z.strictObject({ startedAt: timestampSchema, evaluatedAt: timestampSchema }),
    }),
    items: z.tuple([
      pullRequestSchema.extend({ key: z.literal("A") }),
      pullRequestSchema.extend({ key: z.literal("B") }),
      issueSchema.extend({ key: z.literal("C") }),
      issueSchema.extend({ key: z.literal("D") }),
    ]),
  })
  .superRefine((dataset, context) => {
    const ids = new Set(dataset.items.map((item) => item.nodeId));
    const numbers = new Set(dataset.items.map((item) => item.number));
    if (ids.size !== dataset.items.length || numbers.size !== dataset.items.length) {
      context.addIssue({ code: "custom", message: "合成項目のIDまたは番号が重複しています" });
    }
    if (dataset.rateLimit.remaining > dataset.rateLimit.limit) {
      context.addIssue({ code: "custom", message: "合成APIの残量が上限を超えています" });
    }
    if (
      dataset.items[0].nativeClosingIssueKeys[0] !== "C" ||
      dataset.items[1].nativeClosingIssueKeys[0] !== "C"
    ) {
      context.addIssue({ code: "custom", message: "合成Pull Requestの共通対象がCではありません" });
    }
    if (
      dataset.clock.first.startedAt >= dataset.clock.first.evaluatedAt ||
      dataset.clock.first.evaluatedAt >= dataset.clock.second.startedAt ||
      dataset.clock.second.startedAt >= dataset.clock.second.evaluatedAt
    ) {
      context.addIssue({ code: "custom", message: "合成run時計の順序が不正です" });
    }
    for (const item of dataset.items) {
      if (item.updatedAt >= dataset.clock.first.startedAt || item.createdAt > item.updatedAt) {
        context.addIssue({ code: "custom", message: "合成項目の更新時刻が不正です" });
      }
      if (item.type === "issue") {
        if (item.closedAt < item.createdAt || item.closedAt > item.updatedAt) {
          context.addIssue({ code: "custom", message: "合成Issueの終了時刻が不正です" });
        }
      } else if (
        item.headCommittedAt > item.updatedAt ||
        item.commentAt > item.updatedAt ||
        item.commentAt < item.createdAt
      ) {
        context.addIssue({ code: "custom", message: "合成Pull Requestの出来事時刻が不正です" });
      }
    }
  });

/** 合成GitHub入力の検証済み型。 */
export type SandboxFixedSourceDataset = z.output<typeof sandboxFixedSourceDatasetSchema>;

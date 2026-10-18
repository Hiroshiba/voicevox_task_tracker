import { hashCanonicalJson } from "../content-digest.js";

import { sandboxFixedSourceDatasetSchema, type SandboxFixedSourceDataset } from "./schema.js";

function freezeRecursively(value: unknown): void {
  if (typeof value !== "object" || value == null) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeRecursively(child);
  }
  Object.freeze(value);
}

const datasetInput = {
  schemaVersion: 1,
  organization: "VOICEVOX",
  installationId: 1,
  rateLimit: { limit: 5000, remaining: 5000 },
  repository: {
    nodeId: "R_sandbox_strict_zero_fixture",
    name: "sandbox-strict-zero-fixture",
    visibility: "public",
    archived: false,
    disabled: false,
  },
  clock: {
    first: {
      startedAt: "2026-08-01T00:00:00.000Z",
      evaluatedAt: "2026-08-01T00:00:01.000Z",
    },
    second: {
      startedAt: "2026-08-01T00:01:00.000Z",
      evaluatedAt: "2026-08-01T00:01:01.000Z",
    },
  },
  items: [
    {
      key: "A",
      nodeId: "PR_sandbox_strict_zero_A",
      number: 900001,
      type: "pull_request",
      title: "合成更新Aの自動確認",
      body: "合成対象Cの処理を自動確認します。",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headCommitNodeId: "C_sandbox_strict_zero_A",
      headCommittedAt: "2026-04-01T01:00:00.000Z",
      commentNodeId: "IC_sandbox_strict_zero_A",
      commentBody: "自動確認の完了を待っています。",
      commentAt: "2026-04-02T00:00:00.000Z",
      nativeClosingIssueKeys: ["C"],
    },
    {
      key: "B",
      nodeId: "PR_sandbox_strict_zero_B",
      number: 900002,
      type: "pull_request",
      title: "合成更新Bの自動確認",
      body: "合成対象Cの別の処理を自動確認します。",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      headCommitNodeId: "C_sandbox_strict_zero_B",
      headCommittedAt: "2026-04-01T01:00:00.000Z",
      commentNodeId: "IC_sandbox_strict_zero_B",
      commentBody: "自動確認の完了を待っています。",
      commentAt: "2026-04-02T00:00:00.000Z",
      nativeClosingIssueKeys: ["C"],
    },
    {
      key: "C",
      nodeId: "I_sandbox_strict_zero_C",
      number: 900003,
      type: "issue",
      title: "合成共通終了対象C",
      body: "合成更新AとBの共通対象です。",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      closedAt: "2026-04-20T00:00:00.000Z",
    },
    {
      key: "D",
      nodeId: "I_sandbox_strict_zero_D",
      number: 900004,
      type: "issue",
      title: "合成孤立終了対象D",
      body: "関係を持たない増分収集確認用の項目です。",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
      closedAt: "2026-04-21T00:00:00.000Z",
    },
  ],
} satisfies import("zod").input<typeof sandboxFixedSourceDatasetSchema>;

const parsedDataset = sandboxFixedSourceDatasetSchema.parse(datasetInput);
freezeRecursively(parsedDataset);

/** strict-zero検証だけに使う固定の合成GitHub入力。 */
export const SANDBOX_FIXED_SOURCE_DATASET: Readonly<SandboxFixedSourceDataset> = parsedDataset;

/** 合成GitHub入力と固定時計のcanonical digest。 */
export const SANDBOX_FIXED_SOURCE_DATASET_DIGEST = hashCanonicalJson(SANDBOX_FIXED_SOURCE_DATASET);

import { z } from "zod";

import type { ProductionPagesEffectLease } from "../../persistence/production-pages-effect-lease.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import {
  sequentialPagesChildName,
  type SequentialPagesActionsPayload,
} from "./sequential-pages-actions-contract.js";

const workflowFile = "sequential_pages_effect.yml";
const runSchema = z.looseObject({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  event: z.literal("workflow_dispatch"),
  display_title: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const runsSchema = z.looseObject({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(runSchema),
});

/** Pages childのActions run観測値。 */
export type SequentialPagesActionsRun = z.output<typeof runSchema>;
export type SequentialPagesActionsGet = (path: string) => Promise<Response>;

/** 固定keyに一致するPages childを一意に探す。 */
export async function findSequentialPagesChildRun(
  repository: string,
  payload: SequentialPagesActionsPayload,
  get: SequentialPagesActionsGet,
): Promise<SequentialPagesActionsRun | undefined> {
  const name = sequentialPagesChildName(payload.idempotencyKey);
  const matches: SequentialPagesActionsRun[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await get(
      `repos/${repository}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=100&page=${page.toString()}`,
    );
    const parsed = runsSchema.parse(await response.json());
    matches.push(...parsed.workflow_runs.filter((run) => run.display_title === name));
    if (matches.length > 1) {
      throw new TypeError("同じPages idempotency keyのchild runが複数あります");
    }
    if (page * 100 >= parsed.total_count) {
      return matches[0];
    }
  }
  throw new TypeError("Pages child runのActions一覧を最後まで確認できません");
}

/** dispatchしたPages childの完了を待つ。 */
export async function waitForSequentialPagesChildRun(
  repository: string,
  payload: SequentialPagesActionsPayload,
  get: SequentialPagesActionsGet,
): Promise<SequentialPagesActionsRun> {
  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    const run = await findSequentialPagesChildRun(repository, payload, get);
    if (run?.status === "completed") {
      return run;
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 10_000));
  }
  throw new TypeError("Pages childの実結果が制限時間内に確定しませんでした");
}

/** leaseに記録された元childのIDとattemptを指定して完了を待つ。 */
export async function waitForClaimedSequentialPagesChildRun(
  repository: string,
  payload: SequentialPagesActionsPayload,
  lease: ProductionPagesEffectLease,
  get: SequentialPagesActionsGet,
): Promise<SequentialPagesActionsRun> {
  const childRunId = lease.effect.childRunId;
  const childRunAttempt = lease.effect.childRunAttempt;
  assertNonNullable(childRunId, "production Pages leaseにchild run IDがありません");
  assertNonNullable(childRunAttempt, "production Pages leaseにchild attemptがありません");
  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    const response = await get(
      `repos/${repository}/actions/runs/${childRunId}/attempts/${childRunAttempt.toString()}`,
    );
    const child = runSchema.parse(await response.json());
    if (
      child.id.toString() !== childRunId ||
      child.run_attempt !== childRunAttempt ||
      child.display_title !== sequentialPagesChildName(payload.idempotencyKey)
    ) {
      throw new TypeError("leaseが保持するPages childの実行情報が一致しません");
    }
    if (child.status === "completed") {
      return child;
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 10_000));
  }
  throw new TypeError("leaseが保持するPages childの実結果が制限時間内に確定しませんでした");
}

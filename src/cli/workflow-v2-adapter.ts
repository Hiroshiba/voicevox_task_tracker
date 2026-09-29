import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

const stepSchema = z.looseObject({
  run: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
});
const workflowSchema = z.looseObject({
  jobs: z.record(z.string(), z.looseObject({ steps: z.array(stepSchema).optional() })),
});

function hasProtocolCall(run: string | undefined, operation: string): boolean {
  if (run == null) {
    return false;
  }
  return run.split("\n").some((line) => {
    const source = line.trim();
    return (
      !source.startsWith("#") &&
      new RegExp(`(?:^|\\s)runtime-recovery-v2\\s+--operation\\s+${operation}(?:\\s|$)`, "u").test(
        source,
      )
    );
  });
}

function assertPagesJob(
  steps: readonly z.output<typeof stepSchema>[],
  phase: "initial" | "notification_history",
): void {
  const deploy = steps.findIndex((step) =>
    /^actions\/deploy-pages@[0-9a-f]{40}$/u.test(step.uses ?? ""),
  );
  const record = steps.findIndex(
    (step) =>
      hasProtocolCall(step.run, "record_pages") &&
      step.run?.includes(`--phase ${phase}`) === true &&
      step.if?.includes("always()") === true,
  );
  if (deploy < 0 || record <= deploy) {
    throw new TypeError("V2 Pagesの静的action後にalways観測stepがありません");
  }
}

/** V2固定入口とPages実actionの静的接続をworkflow構造で検証する。 */
export async function assertWorkflowV2Adapter(repositoryPath: string): Promise<void> {
  const source = await readFile(
    resolve(repositoryPath, ".github/workflows/_tracking-run.yml"),
    "utf8",
  );
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("V2 workflow adapterのYAMLが不正です", { cause: document.errors[0] });
  }
  const workflow = workflowSchema.parse(document.toJS());
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  if (
    !steps.some((step) => hasProtocolCall(step.run, "inspect")) ||
    !steps.some((step) => hasProtocolCall(step.run, "execute_stage"))
  ) {
    throw new TypeError("V2固定入口のinspectまたはexecute_stageが実stepにありません");
  }
  const initialPages = workflow.jobs["initial-pages"]?.steps;
  const historyPages = workflow.jobs["notification-history-pages"]?.steps;
  if (initialPages == null || historyPages == null) {
    throw new TypeError("V2 Pagesの静的jobがありません");
  }
  assertPagesJob(initialPages, "initial");
  assertPagesJob(historyPages, "notification_history");
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

const stepSchema = z.looseObject({
  id: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
});
const workflowSchema = z.looseObject({
  jobs: z.record(
    z.string(),
    z.looseObject({
      steps: z.array(stepSchema).optional(),
      permissions: z.record(z.string(), z.string()).optional(),
      environment: z.looseObject({ name: z.string() }).optional(),
    }),
  ),
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
): readonly z.output<typeof stepSchema>[] {
  const preflight = steps.findIndex((step) => step.id === "preflight");
  const upload = steps.findIndex((step) =>
    /^actions\/upload-pages-artifact@[0-9a-f]{40}$/u.test(step.uses ?? ""),
  );
  const sandboxUpload = steps.findIndex((step) =>
    /^actions\/upload-artifact@[0-9a-f]{40}$/u.test(step.uses ?? ""),
  );
  const deploy = steps.findIndex((step) =>
    /^actions\/deploy-pages@[0-9a-f]{40}$/u.test(step.uses ?? ""),
  );
  const record = steps.findIndex(
    (step) =>
      hasProtocolCall(step.run, "record_pages") &&
      step.run?.includes(`--phase ${phase}`) === true &&
      step.if?.includes("always()") === true,
  );
  const preflightStage =
    phase === "initial"
      ? "preflight-initial-pages-deployment"
      : "preflight-history-pages-deployment";
  if (
    preflight < 0 ||
    !hasProtocolCall(steps[preflight]?.run, "execute_stage") ||
    steps[preflight]?.run?.includes(`--stage ${preflightStage}`) !== true ||
    upload <= preflight ||
    sandboxUpload <= preflight ||
    deploy <= upload ||
    deploy <= sandboxUpload ||
    record <= deploy
  ) {
    throw new TypeError("V2 Pagesの静的action後にalways観測stepがありません");
  }
  const adapterSteps = steps.slice(preflight, record + 1);
  if (
    adapterSteps.some(
      (step) =>
        (step.uses?.startsWith("actions/") === true &&
          !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/u.test(step.uses)) ||
        step.uses?.startsWith("./") === true,
    )
  ) {
    throw new TypeError("V2 Pagesの静的adapterに固定されないactionがあります");
  }
  return adapterSteps;
}

/** V2固定入口とPages実actionの静的接続を検証してidentity入力を返す。 */
export async function readWorkflowV2Adapter(repositoryPath: string): Promise<object> {
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
  const initialPages = workflow.jobs["initial-pages"];
  const historyPages = workflow.jobs["notification-history-pages"];
  if (
    initialPages?.steps == null ||
    initialPages.permissions == null ||
    initialPages.environment == null ||
    historyPages?.steps == null ||
    historyPages.permissions == null ||
    historyPages.environment == null
  ) {
    throw new TypeError("V2 Pagesの静的jobがありません");
  }
  return {
    adapterVersion: "tracking-run-pages-actions-v2",
    phases: [
      {
        phase: "initial",
        permissions: initialPages.permissions,
        environment: initialPages.environment,
        steps: assertPagesJob(initialPages.steps, "initial"),
      },
      {
        phase: "notification_history",
        permissions: historyPages.permissions,
        environment: historyPages.environment,
        steps: assertPagesJob(historyPages.steps, "notification_history"),
      },
    ],
  };
}

/** V2固定入口とPages実actionの静的接続をworkflow構造で検証する。 */
export async function assertWorkflowV2Adapter(repositoryPath: string): Promise<void> {
  await readWorkflowV2Adapter(repositoryPath);
}

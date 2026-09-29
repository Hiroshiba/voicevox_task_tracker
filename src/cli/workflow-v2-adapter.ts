import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

const deployAction = "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e";
const uploadAction = "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa";
const stepSchema = z.looseObject({
  id: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
  "continue-on-error": z.boolean().optional(),
});
const jobSchema = z.looseObject({
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: z.string().optional(),
  steps: z.array(stepSchema).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  environment: z.looseObject({ name: z.string() }).optional(),
});
const workflowSchema = z.looseObject({ jobs: z.record(z.string(), jobSchema) });

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

async function readWorkflow(repositoryPath: string, relativePath: string) {
  const source = await readFile(resolve(repositoryPath, relativePath), "utf8");
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("V2 workflow adapterのYAMLが不正です", { cause: document.errors[0] });
  }
  return workflowSchema.parse(document.toJS());
}

function assertPagesSteps(
  deploySteps: readonly z.output<typeof stepSchema>[],
  recordSteps: readonly z.output<typeof stepSchema>[],
): void {
  const preflight = deploySteps.findIndex((step) => step.id === "preflight");
  const upload = deploySteps.findIndex((step) => step.uses === uploadAction);
  const sandboxUpload = deploySteps.findIndex((step) =>
    /^actions\/upload-artifact@[0-9a-f]{40}$/u.test(step.uses ?? ""),
  );
  const deploy = deploySteps.findIndex((step) => step.uses === deployAction);
  const observe = recordSteps.findIndex(
    (step) => step.uses === "./.github/actions/observe-pages-deployment",
  );
  const record = recordSteps.findIndex(
    (step) =>
      hasProtocolCall(step.run, "record_pages") &&
      step.run?.includes("--phase initial") === true &&
      step.run.includes("--phase notification_history") &&
      step.if?.includes("always()") === true,
  );
  const preflightRun = deploySteps[preflight]?.run;
  if (
    preflight < 0 ||
    !hasProtocolCall(preflightRun, "execute_stage") ||
    preflightRun?.includes("preflight-initial-pages-deployment") !== true ||
    !preflightRun.includes("preflight-history-pages-deployment") ||
    upload <= preflight ||
    sandboxUpload <= preflight ||
    deploy <= upload ||
    deploy <= sandboxUpload ||
    observe < 0 ||
    record <= observe ||
    recordSteps[observe]?.["continue-on-error"] !== true
  ) {
    throw new TypeError("V2 Pagesのdeploy jobとalways観測jobが接続されていません");
  }
  const adapterSteps = [
    ...deploySteps.slice(preflight, deploy + 1),
    ...recordSteps.slice(0, record + 1),
  ];
  if (
    adapterSteps.some(
      (step) =>
        (step.uses?.startsWith("actions/") === true &&
          !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/u.test(step.uses)) ||
        (step.uses?.startsWith("./") === true && !step.uses.startsWith("./.github/actions/")),
    )
  ) {
    throw new TypeError("V2 Pagesの静的adapterに固定されないactionがあります");
  }
}

/** V2固定入口とPages実actionの静的接続を検証してidentity入力を返す。 */
export async function readWorkflowV2Adapter(repositoryPath: string): Promise<object> {
  const [tracking, pages] = await Promise.all([
    readWorkflow(repositoryPath, ".github/workflows/_tracking-run.yml"),
    readWorkflow(repositoryPath, ".github/workflows/_tracking-pages.yml"),
  ]);
  const trackingSteps = Object.values(tracking.jobs).flatMap((job) => job.steps ?? []);
  if (
    !trackingSteps.some((step) => hasProtocolCall(step.run, "inspect")) ||
    !trackingSteps.some((step) => hasProtocolCall(step.run, "execute_stage"))
  ) {
    throw new TypeError("V2固定入口のinspectまたはexecute_stageが実stepにありません");
  }
  const initial = tracking.jobs["initial-pages"];
  const history = tracking.jobs["notification-history-pages"];
  const deploy = pages.jobs["deploy"];
  const record = pages.jobs["record"];
  if (
    initial?.uses !== "./.github/workflows/_tracking-pages.yml" ||
    initial.with?.["phase"] !== "initial" ||
    history?.uses !== "./.github/workflows/_tracking-pages.yml" ||
    history.with?.["phase"] !== "notification_history" ||
    deploy?.steps == null ||
    deploy.permissions?.["pages"] !== "write" ||
    deploy.permissions["id-token"] !== "write" ||
    deploy.environment == null ||
    record?.steps == null ||
    record.permissions?.["pages"] !== "read" ||
    record.permissions["actions"] !== "read" ||
    record.if?.includes("always()") !== true ||
    record.needs !== "deploy"
  ) {
    throw new TypeError("V2 Pagesの静的jobまたは権限がありません");
  }
  assertPagesSteps(deploy.steps, record.steps);
  return {
    adapterVersion: "tracking-run-pages-actions-v2",
    calls: [initial, history],
    deploy,
    record,
  };
}

/** V2固定入口とPages実actionの静的接続をworkflow構造で検証する。 */
export async function assertWorkflowV2Adapter(repositoryPath: string): Promise<void> {
  await readWorkflowV2Adapter(repositoryPath);
}

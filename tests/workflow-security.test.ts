import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const WORKFLOW_DIRECTORY = join(import.meta.dirname, "..", ".github", "workflows");
const DAILY_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "daily.yml");
const CI_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "ci.yml");
const FULL_COMMIT_ACTION_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/u;
const VERSIONED_USES_LINE_PATTERN =
  /^\s*uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+){0,2}\s*$/gmu;

const permissionSchema = z.enum(["read", "write", "none"]);
const permissionsSchema = z.record(z.string(), permissionSchema);
const stepSchema = z
  .object({
    uses: z.string().optional(),
    run: z.string().optional(),
  })
  .loose();
const needsSchema = z.union([z.string(), z.array(z.string())]);
const jobSchema = z
  .object({
    permissions: permissionsSchema,
    needs: needsSchema.optional(),
    if: z.string().optional(),
    steps: z.array(stepSchema),
  })
  .loose();
const workflowSchema = z
  .object({
    on: z.record(z.string(), z.unknown()),
    jobs: z.record(z.string(), jobSchema),
  })
  .loose();
const dailyWorkflowSchema = workflowSchema.extend({
  on: z
    .object({
      schedule: z.array(
        z
          .object({
            cron: z.string(),
          })
          .loose(),
      ),
      workflow_dispatch: z
        .object({
          inputs: z
            .object({
              backfill: z
                .object({
                  type: z.literal("choice"),
                  options: z.array(z.string()),
                })
                .loose(),
              repository_filter: z
                .object({
                  type: z.literal("string"),
                })
                .loose(),
            })
            .loose(),
        })
        .loose(),
    })
    .loose(),
  concurrency: z
    .object({
      group: z.string(),
      "cancel-in-progress": z.boolean(),
    })
    .loose(),
});

type Workflow = z.output<typeof workflowSchema>;
type WorkflowJob = z.output<typeof jobSchema>;

async function readWorkflow(path: string): Promise<Workflow> {
  return workflowSchema.parse(parse(await readFile(path, "utf8")));
}

async function readDailyWorkflow(): Promise<z.output<typeof dailyWorkflowSchema>> {
  return dailyWorkflowSchema.parse(parse(await readFile(DAILY_WORKFLOW_PATH, "utf8")));
}

function collectUses(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectUses(entry));
  }
  if (typeof value !== "object" || value == null) {
    return [];
  }
  const uses: string[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (name === "uses") {
      if (typeof entry !== "string") {
        throw new TypeError("workflowのusesは文字列にしてください");
      }
      uses.push(entry);
    } else {
      uses.push(...collectUses(entry));
    }
  }
  return uses;
}

function needs(job: WorkflowJob): readonly string[] {
  if (job.needs == null) {
    return [];
  }
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

function secretJobNames(workflow: Workflow): readonly string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => JSON.stringify(job).includes("${{ secrets."))
    .map(([name]) => name)
    .sort();
}

function runCommands(job: WorkflowJob): readonly string[] {
  return job.steps.flatMap((step) => (step.run == null ? [] : [step.run]));
}

describe("日次workflow", () => {
  it("08:00 JST相当のcron、手動trigger、直列化を定義する", async () => {
    const workflow = await readDailyWorkflow();

    expect(workflow.on.schedule.map((schedule) => schedule.cron)).toEqual(["0 23 * * *"]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.workflow_dispatch.inputs.backfill.options).toEqual([
      "none",
      "linked",
      "all-open",
    ]);
    expect(workflow.on.workflow_dispatch.inputs.repository_filter.type).toBe("string");
    expect(workflow.concurrency).toEqual({
      group: "voicevox-task-tracker-daily",
      "cancel-in-progress": false,
    });
  });

  it("jobごとのGITHUB_TOKEN権限をallowlistと一致させる", async () => {
    const workflow = await readDailyWorkflow();
    const actualPermissions = Object.fromEntries(
      Object.entries(workflow.jobs).map(([name, job]) => [name, job.permissions]),
    );

    expect(actualPermissions).toEqual({
      "test-eval": {
        contents: "read",
      },
      "collect-analyze": {
        contents: "read",
      },
      "persist-state": {
        contents: "write",
      },
      "build-pages": {
        contents: "read",
      },
      "deploy-pages": {
        contents: "read",
        pages: "write",
        "id-token": "write",
      },
      "notify-discord": {},
    });
  });

  it("Discord通知をPagesのdeploy成功後だけに実行する", async () => {
    const workflow = await readDailyWorkflow();
    const notifyJob = workflow.jobs["notify-discord"];
    const deployJob = workflow.jobs["deploy-pages"];

    expect(notifyJob).toBeDefined();
    expect(deployJob).toBeDefined();
    if (notifyJob == null || deployJob == null) {
      throw new TypeError("Pages deployまたはDiscord通知jobがありません");
    }
    expect(needs(notifyJob)).toContain("deploy-pages");
    expect(notifyJob.if).toContain("success()");
    expect(needs(deployJob)).toContain("build-pages");
  });
});

describe("workflow security", () => {
  it("全Actionをversion付きfull commit SHAへpinする", async () => {
    const fileNames = (await readdir(WORKFLOW_DIRECTORY))
      .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"))
      .sort();
    for (const fileName of fileNames) {
      const path = join(WORKFLOW_DIRECTORY, fileName);
      const source = await readFile(path, "utf8");
      const workflow = await readWorkflow(path);
      const uses = collectUses(workflow);
      const versionedUsesLines = source.match(VERSIONED_USES_LINE_PATTERN) ?? [];

      expect(uses.length, fileName).toBeGreaterThan(0);
      expect(
        uses.every((value) => FULL_COMMIT_ACTION_PATTERN.test(value)),
        fileName,
      ).toBe(true);
      expect(versionedUsesLines, fileName).toHaveLength(uses.length);
    }
  });

  it("pull request eventからsecret利用jobへ到達できない", async () => {
    const fileNames = (await readdir(WORKFLOW_DIRECTORY))
      .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"))
      .sort();
    for (const fileName of fileNames) {
      const workflow = await readWorkflow(join(WORKFLOW_DIRECTORY, fileName));
      const triggerNames = Object.keys(workflow.on);

      expect(triggerNames, fileName).not.toContain("pull_request_target");
      if (triggerNames.includes("pull_request")) {
        expect(secretJobNames(workflow), fileName).toEqual([]);
      }
    }

    const dailyWorkflow = await readWorkflow(DAILY_WORKFLOW_PATH);
    expect(Object.keys(dailyWorkflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(secretJobNames(dailyWorkflow)).toEqual(["collect-analyze", "notify-discord"]);
    for (const jobName of secretJobNames(dailyWorkflow)) {
      expect(dailyWorkflow.jobs[jobName]?.if, jobName).toContain(
        "github.event.repository.default_branch",
      );
    }
    expect(needs(dailyWorkflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] })).toContain(
      "collect-analyze",
    );
  });

  it("CIを外部APIへ接続せず全検証とgolden evalに割り当てる", async () => {
    const workflow = await readWorkflow(CI_WORKFLOW_PATH);
    const qualityJob = workflow.jobs["quality"];
    const goldenEvalJob = workflow.jobs["golden-eval"];
    if (qualityJob == null || goldenEvalJob == null) {
      throw new TypeError("CIのqualityまたはgolden-eval jobがありません");
    }

    const qualityCommands = runCommands(qualityJob);
    for (const command of [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm test",
      "pnpm build",
      "pnpm build:web",
    ]) {
      expect(qualityCommands).toContain(command);
    }
    expect(runCommands(goldenEvalJob)).toContain("pnpm eval:golden");
    expect(JSON.stringify(workflow)).not.toContain("${{ secrets.");
    expect(runCommands(qualityJob).join("\n")).not.toContain("curl");
    expect(runCommands(goldenEvalJob).join("\n")).not.toContain("curl");
  });
});

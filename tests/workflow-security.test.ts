import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const WORKFLOW_DIRECTORY = join(import.meta.dirname, "..", ".github", "workflows");
const DAILY_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "daily.yml");
const CI_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "ci.yml");
const PERFORMANCE_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "performance.yml");
const CONFIG_PATH = join(import.meta.dirname, "..", "config.yml");
const PACKAGE_PATH = join(import.meta.dirname, "..", "package.json");
const FULL_COMMIT_ACTION_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/u;
const VERSIONED_USES_LINE_PATTERN =
  /^\s*uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+){0,2}\s*$/gmu;

const permissionSchema = z.enum(["read", "write", "none"]);
const permissionsSchema = z.record(z.string(), permissionSchema);
const stepSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
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
const configSchema = z
  .object({
    notifications: z
      .object({
        discord: z
          .object({
            webhookSecretName: z.string(),
            operationsWebhookSecretName: z.string(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

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

function environmentVariableNames(job: WorkflowJob): readonly string[] {
  return job.steps.flatMap((step) => (step.env == null ? [] : Object.keys(step.env)));
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
        pages: "write",
        "id-token": "write",
      },
      "notify-discord": {
        contents: "write",
      },
      "notify-operations": {
        contents: "write",
      },
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

  it("各jobが検証済みartifactを対応するCLI stageへ渡す", async () => {
    const workflow = await readDailyWorkflow();
    const collectCommands = runCommands(
      workflow.jobs["collect-analyze"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const persistCommands = runCommands(
      workflow.jobs["persist-state"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const buildCommands = runCommands(
      workflow.jobs["build-pages"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const notifyCommands = runCommands(
      workflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const operationsCommands = runCommands(
      workflow.jobs["notify-operations"] ?? { permissions: {}, steps: [] },
    ).join("\n");

    expect(collectCommands).toContain("collect-analyze");
    expect(collectCommands).toContain("pnpm build:workflow-cli");
    expect(collectCommands).toContain(
      "git fetch --no-tags origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(persistCommands).toContain("tracker-run.mjs persist-state");
    expect(persistCommands).toContain(
      "git push origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(buildCommands).toContain("tracker-run.mjs build-pages");
    expect(buildCommands).toContain(
      "git fetch --no-tags origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(notifyCommands).toContain("tracker-run.mjs notify-discord");
    expect(notifyCommands).not.toContain("curl");
    expect(operationsCommands).toContain("tracker:run notify-operations");
    expect(operationsCommands).toContain("incident_kind=collection");
    expect(operationsCommands).not.toContain("curl");
    for (const jobName of ["persist-state", "build-pages", "notify-discord"] as const) {
      expect(JSON.stringify(workflow.jobs[jobName])).toContain("actions/download-artifact@");
      expect(JSON.stringify(workflow.jobs[jobName])).toContain("validated-public-run");
    }
  });

  it("Codex CLIをexact versionで固定して収集jobへinstallする", async () => {
    const workflow = await readDailyWorkflow();
    const packageDefinition: unknown = JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
    const packageSchema = z
      .object({
        devDependencies: z
          .object({
            "@openai/codex": z.string(),
          })
          .loose(),
      })
      .loose();
    const parsedPackage = packageSchema.parse(packageDefinition);
    const collectCommands = runCommands(
      workflow.jobs["collect-analyze"] ?? { permissions: {}, steps: [] },
    );

    expect(parsedPackage.devDependencies["@openai/codex"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(collectCommands).toContain("pnpm install --frozen-lockfile");
    expect(collectCommands).toContain("pnpm exec codex --version");
  });

  it("外部secretを収集とDiscordのjobだけへ分離する", async () => {
    const workflow = await readDailyWorkflow();
    const collectSource = JSON.stringify(workflow.jobs["collect-analyze"]);
    const persistSource = JSON.stringify(workflow.jobs["persist-state"]);
    const buildSource = JSON.stringify(workflow.jobs["build-pages"]);
    const notifySource = JSON.stringify(workflow.jobs["notify-discord"]);
    const operationsSource = JSON.stringify(workflow.jobs["notify-operations"]);

    expect(collectSource).toContain("GH_APP_PRIVATE_KEY");
    expect(collectSource).toContain("OPENAI_API_KEY");
    expect(collectSource).not.toContain("DISCORD_OPERATIONS_WEBHOOK_URL");
    expect(collectSource).not.toContain("DISCORD_WEBHOOK_URL");
    expect(persistSource).not.toContain("secrets.");
    expect(buildSource).not.toContain("secrets.");
    expect(notifySource).toContain("DISCORD_OPERATIONS_WEBHOOK_URL");
    expect(notifySource).toContain("DISCORD_WEBHOOK_URL");
    expect(notifySource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(notifySource).not.toContain("OPENAI_API_KEY");
    expect(operationsSource).toContain("DISCORD_OPERATIONS_WEBHOOK_URL");
    expect(operationsSource).not.toContain("DISCORD_WEBHOOK_URL");
    expect(operationsSource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(operationsSource).not.toContain("OPENAI_API_KEY");
  });

  it("Discord secretの設定名を必要な通知jobの環境変数へ公開する", async () => {
    const workflow = await readDailyWorkflow();
    const config = configSchema.parse(parse(await readFile(CONFIG_PATH, "utf8")));
    const discordConfig = config.notifications.discord;

    expect(
      environmentVariableNames(workflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] }),
    ).toContain(discordConfig.webhookSecretName);
    expect(
      environmentVariableNames(workflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] }),
    ).toContain(discordConfig.operationsWebhookSecretName);
    expect(
      environmentVariableNames(
        workflow.jobs["notify-operations"] ?? { permissions: {}, steps: [] },
      ),
    ).toContain(discordConfig.operationsWebhookSecretName);
  });
});

describe("workflow security", () => {
  it("性能profileを外部secretなしの手動workflowへ分離する", async () => {
    const workflow = await readWorkflow(PERFORMANCE_WORKFLOW_PATH);
    const profileJob = workflow.jobs["end-to-end-profile"];
    if (profileJob == null) {
      throw new TypeError("end-to-end性能profile jobがありません");
    }

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(profileJob.permissions).toEqual({ contents: "read" });
    expect(runCommands(profileJob)).toContain("pnpm perf:profile");
    expect(JSON.stringify(workflow)).not.toContain("${{ secrets.");
  });

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
    expect(secretJobNames(dailyWorkflow)).toEqual([
      "collect-analyze",
      "notify-discord",
      "notify-operations",
    ]);
    for (const jobName of secretJobNames(dailyWorkflow)) {
      expect(dailyWorkflow.jobs[jobName]?.if, jobName).toContain(
        "github.event.repository.default_branch",
      );
    }
    expect(needs(dailyWorkflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] })).toContain(
      "collect-analyze",
    );
    const operationsJob = dailyWorkflow.jobs["notify-operations"];
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("collect-analyze");
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("build-pages");
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("deploy-pages");
    expect(operationsJob?.if).toContain("needs.collect-analyze.result == 'failure'");
    expect(operationsJob?.if).toContain("needs.build-pages.result == 'failure'");
    expect(operationsJob?.if).toContain("needs.deploy-pages.result == 'failure'");
  });

  it("CIを外部APIへ接続せず全検証とgolden evalに割り当てる", async () => {
    const workflow = await readWorkflow(CI_WORKFLOW_PATH);
    const qualityJob = workflow.jobs["quality"];
    if (qualityJob == null) {
      throw new TypeError("CIのquality jobがありません");
    }

    const qualityCommands = runCommands(qualityJob);
    for (const command of [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm test",
      "pnpm eval:golden",
      "pnpm build",
      "pnpm build:workflow-cli",
      "pnpm build:web",
    ]) {
      expect(qualityCommands).toContain(command);
    }
    expect(JSON.stringify(workflow)).not.toContain("${{ secrets.");
    expect(runCommands(qualityJob).join("\n")).not.toContain("curl");
  });
});

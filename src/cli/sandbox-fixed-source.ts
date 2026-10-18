import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runRequestSchema } from "../application/tracking-run/request.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { createUtcIsoDateTime } from "../domain/types.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import { parseSandboxContext } from "../infrastructure/tracking-run/sandbox-context.js";
import {
  SANDBOX_FIXED_SOURCE_DATASET,
  SANDBOX_FIXED_SOURCE_DATASET_DIGEST,
} from "../infrastructure/tracking-run/sandbox-fixed-source/dataset.js";
import {
  assertSandboxFixedSourceEnvironment,
  parseSandboxFixedSourceDescriptor,
} from "../infrastructure/tracking-run/sandbox-fixed-source/descriptor.js";
import { createSandboxFixedSourceSeed } from "../infrastructure/tracking-run/sandbox-fixed-source/seed.js";
import { createRunIdentity } from "../infrastructure/tracking-run/tracking-run/identity.js";
import {
  createStateOperationsAlertLedger,
  serializeStateOperationsAlertLedger,
} from "../persistence/state-documents.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";
import { loadTrackingConfig } from "./composition-root.js";

function createSeedFiles(): Readonly<
  Record<"snapshot.json" | "notification-ledger.json" | "operations-alert-ledger-v1.json", string>
> {
  const seed = createSandboxFixedSourceSeed();
  return {
    "snapshot.json": seed.snapshot,
    "notification-ledger.json": seed.notificationLedger,
    "operations-alert-ledger-v1.json": serializeStateOperationsAlertLedger(
      createStateOperationsAlertLedger({
        schemaVersion: "2",
        operationsAlerts: [],
        deliveryReservations: [],
      }),
    ),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function writeSeed(directory: string): void {
  mkdirSync(directory);
  for (const [name, source] of Object.entries(createSeedFiles())) {
    writeFileSync(join(directory, name), source, { flag: "wx", mode: 0o644 });
  }
}

function verifySeed(directory: string): void {
  for (const [name, source] of Object.entries(createSeedFiles())) {
    if (readFileSync(join(directory, name), "utf8") !== source) {
      throw new TypeError(`固定sourceのseed ${name}が合成datasetと一致しません`);
    }
  }
}

async function prepareDescriptor(): Promise<void> {
  const contextPath = requiredEnvironment("SANDBOX_CONTEXT_PATH");
  const context = parseSandboxContext(JSON.parse(readFileSync(contextPath, "utf8")));
  const phase = context.analysisMode.kind === "normal" ? "first" : "second";
  if (
    (phase === "first" && context.analysisMode.kind !== "normal") ||
    (phase === "second" && context.analysisMode.kind !== "cache_probe")
  ) {
    throw new TypeError("固定sourceのrun slotと解析modeが一致しません");
  }
  const configPath = "config.sandbox-strict-zero.yml";
  const config = await loadTrackingConfig(configPath, process.env);
  const scheduledFor = createUtcIsoDateTime(SANDBOX_FIXED_SOURCE_DATASET.clock[phase].startedAt);
  const request = runRequestSchema.parse({
    invocationId: "00000000-0000-4000-8000-000000000000",
    configPath,
    reportPath: "artifacts/run-reports/run-stage-analyze.json",
    scheduledFor,
    startedAt: scheduledFor,
    requestKind: "sandbox_daily",
    executionPolicy: {
      kind: "sandbox_daily",
      executionShape: "split_workflow",
      effectTarget: "sandbox",
      notificationAction: "send",
    },
    sandboxContextPath: contextPath,
    output: { kind: "analysis_artifact", path: "artifacts/workflow/validated-run.cpk" },
  });
  const descriptor = parseSandboxFixedSourceDescriptor({
    schemaVersion: 1,
    kind: "sandbox_fixed_source",
    datasetDigest: SANDBOX_FIXED_SOURCE_DATASET_DIGEST,
    environmentId: context.environmentId,
    sourceRef: context.sourceRef,
    seedRevision: context.seedRevision,
    codeRevision: context.codeRevision,
    configDigest: nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)),
    workflowRunId: context.workflowRunId,
    workflowRunAttempt: context.workflowRunAttempt,
    runId: createRunIdentity(request).runId,
    runSlot: phase,
  });
  assertSandboxFixedSourceEnvironment(descriptor, process.env);
  const source = serializeCanonicalJson(descriptor);
  writeFileSync(
    join(requiredEnvironment("RUNNER_TEMP"), "sandbox-fixed-source-descriptor.json"),
    `${source}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  appendFileSync(
    requiredEnvironment("GITHUB_OUTPUT"),
    `fixed_source_descriptor=${source}\nfixed_source_scheduled_for=${scheduledFor}\n`,
  );
}

const command = process.argv[2];
if (command === "prepare-descriptor") {
  await prepareDescriptor();
} else if (command === "write-seed" || command === "verify-seed") {
  const directory = process.argv[3];
  assertNonNullable(directory, "固定sourceのstate directoryがありません");
  if (command === "write-seed") {
    writeSeed(directory);
  } else {
    verifySeed(directory);
  }
} else {
  throw new TypeError("固定source CLIの操作が不正です");
}

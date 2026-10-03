import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  parsePagesDeploymentIntent,
  type PagesDeploymentIntent,
} from "../../application/tracking-run/pages-build-contracts.js";
import { PagesEffectNotStartedError } from "../../application/tracking-run/pages-effect.js";
import { pagesDeploymentExternalReferenceSchema } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { StateBranchAdapter } from "../../persistence/branch-adapter.js";
import { reserveProductionPagesEffectLease } from "../../persistence/production-pages-effect-lease.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import { nodeContentDigestPort } from "./content-digest.js";
import type { SequentialPagesResult } from "./initial-pages-deployment.js";
import { workflowAdapterIdentity } from "./publication-runtime-adapter-identity.js";
import {
  parseSequentialPagesActionsObservation,
  parseSequentialPagesActionsPayload,
  sequentialPagesChildArtifactName,
  sequentialPagesChildName,
  type SequentialPagesActionsObservation,
  type SequentialPagesActionsPayload,
} from "./sequential-pages-actions-contract.js";

const execFileAsync = promisify(execFile);
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
const artifactSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  expired: z.boolean(),
});
const artifactsSchema = z.looseObject({ artifacts: z.array(artifactSchema) });

type ActionsContext = Readonly<{
  apiUrl: string;
  repository: string;
  ref: string;
  token: string;
  parentRunId: string;
  parentRunAttempt: number;
  codeRevision: string;
}>;

function required(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name];
  if (value == null || value.length === 0) {
    throw new PagesEffectNotStartedError(`production Pages公開に${name}が必要です`);
  }
  return value;
}

/** production sequentialの公開前にActionsとOIDCの実行条件を確認する。 */
export function requireSequentialPagesActionsContext(
  environment: Readonly<NodeJS.ProcessEnv>,
): ActionsContext {
  if (environment["GITHUB_ACTIONS"] !== "true") {
    throw new PagesEffectNotStartedError("production Pages公開にはGitHub Actionsが必要です");
  }
  const repository = required(environment, "GITHUB_REPOSITORY");
  const ref = required(environment, "GITHUB_REF_NAME");
  const parentRunId = required(environment, "GITHUB_RUN_ID");
  const attempt = Number(required(environment, "GITHUB_RUN_ATTEMPT"));
  const codeRevision = required(environment, "GITHUB_SHA");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[A-Za-z0-9._/-]+$/u.test(ref) ||
    environment["GITHUB_REF"] !== `refs/heads/${ref}` ||
    !/^[1-9][0-9]*$/u.test(parentRunId) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !/^[0-9a-f]{40}$/u.test(codeRevision)
  ) {
    throw new PagesEffectNotStartedError("production Pages公開のActions実行情報が不正です");
  }
  required(environment, "ACTIONS_ID_TOKEN_REQUEST_URL");
  required(environment, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  return Object.freeze({
    apiUrl: required(environment, "GITHUB_API_URL"),
    repository,
    ref,
    token: required(environment, "GITHUB_TOKEN"),
    parentRunId,
    parentRunAttempt: attempt,
    codeRevision,
  });
}

async function apiRequest(
  context: ActionsContext,
  path: string,
  method: "GET" | "POST",
  body?: object,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${context.apiUrl.replace(/\/$/u, "")}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${context.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error: unknown) {
      if (method === "GET" && attempt < 2) {
        await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 1_000));
        continue;
      }
      throw error;
    }
    if (
      method === "GET" &&
      attempt < 2 &&
      [408, 429, 500, 502, 503, 504].includes(response.status)
    ) {
      await response.body?.cancel();
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 1_000));
      continue;
    }
    const accepted =
      method === "POST" ? response.status === 204 : response.ok || response.status === 302;
    if (!accepted) {
      await response.body?.cancel();
      throw new Error(`Pages childのGitHub APIがHTTP ${response.status.toString()}を返しました`);
    }
    return response;
  }
  throw new TypeError("Pages childのGitHub API読み取りを確定できませんでした");
}

async function findChildRun(
  context: ActionsContext,
  payload: SequentialPagesActionsPayload,
): Promise<z.output<typeof runSchema> | undefined> {
  const name = sequentialPagesChildName(payload.idempotencyKey);
  const matches: z.output<typeof runSchema>[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await apiRequest(
      context,
      `repos/${context.repository}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=100&page=${page.toString()}`,
      "GET",
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

async function waitForChildRun(
  context: ActionsContext,
  payload: SequentialPagesActionsPayload,
): Promise<z.output<typeof runSchema>> {
  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    const run = await findChildRun(context, payload);
    if (run?.status === "completed") {
      return run;
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 10_000));
  }
  throw new TypeError("Pages childの実結果が制限時間内に確定しませんでした");
}

async function readChildObservation(
  context: ActionsContext,
  payload: SequentialPagesActionsPayload,
  child: z.output<typeof runSchema>,
): Promise<SequentialPagesActionsObservation> {
  const response = await apiRequest(
    context,
    `repos/${context.repository}/actions/runs/${child.id.toString()}/artifacts?per_page=100`,
    "GET",
  );
  const artifacts = artifactsSchema
    .parse(await response.json())
    .artifacts.filter(
      (artifact) => artifact.name === sequentialPagesChildArtifactName(payload.idempotencyKey),
    );
  if (artifacts.length !== 1 || artifacts[0]?.expired === true) {
    throw new TypeError("Pages childの観測artifactを一意に取得できません");
  }
  const artifact = artifacts[0];
  assertNonNullable(artifact, "Pages childの観測artifactがありません");
  const archiveResponse = await apiRequest(
    context,
    `repos/${context.repository}/actions/artifacts/${artifact.id.toString()}/zip`,
    "GET",
  );
  let archive = archiveResponse;
  if (archiveResponse.status === 302) {
    const location = archiveResponse.headers.get("location");
    await archiveResponse.body?.cancel();
    if (location == null) {
      throw new TypeError("Pages child観測artifactのdownload先がありません");
    }
    archive = await fetch(location, { signal: AbortSignal.timeout(30_000) });
  }
  if (!archive.ok) {
    await archive.body?.cancel();
    throw new TypeError("Pages child観測artifactをdownloadできません");
  }
  const bytes = new Uint8Array(await archive.arrayBuffer());
  if (bytes.length > 1024 * 1024) {
    throw new TypeError("Pages child観測artifactが上限を超えています");
  }
  const directory = await mkdtemp(join(tmpdir(), "tracking-pages-observation-"));
  try {
    const archivePath = join(directory, "observation.zip");
    await writeFile(archivePath, bytes);
    const { stdout } = await execFileAsync("unzip", ["-p", archivePath, "observation.json"], {
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    const raw: unknown = JSON.parse(stdout);
    if (stdout !== serializeCanonicalJsonLine(raw)) {
      throw new TypeError("Pages child観測がcanonical JSONではありません");
    }
    return parseSequentialPagesActionsObservation(
      raw,
      payload,
      String(child.id),
      child.run_attempt,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 専用childへdispatchしてPages actionの実結果を同じ親processで待つ。 */
export async function deploySequentialPagesThroughActions(
  intentInput: PagesDeploymentIntent,
  dependencies: Readonly<{
    environment: Readonly<NodeJS.ProcessEnv>;
    repositoryPath: string;
    adapter: StateBranchAdapter;
    now: () => Date;
  }>,
): Promise<SequentialPagesResult> {
  const context = requireSequentialPagesActionsContext(dependencies.environment);
  const intent = parsePagesDeploymentIntent(intentInput, nodeContentDigestPort);
  const lease = await reserveProductionPagesEffectLease(
    dependencies.adapter,
    intent,
    {
      parentRunId: context.parentRunId,
      parentRunAttempt: context.parentRunAttempt,
      codeRevision: context.codeRevision,
    },
    dependencies.now(),
  );
  const payload = parseSequentialPagesActionsPayload({
    schemaVersion: 1,
    idempotencyKey: lease.effect.idempotencyKey,
    owner: {
      parentRunId: context.parentRunId,
      parentRunAttempt: context.parentRunAttempt,
      codeRevision: context.codeRevision,
    },
    intent,
  });
  let child = await findChildRun(context, payload);
  if (child == null) {
    await apiRequest(
      context,
      `repos/${context.repository}/actions/workflows/${workflowFile}/dispatches`,
      "POST",
      { ref: context.ref, inputs: { payload: serializeCanonicalJsonLine(payload) } },
    );
  }
  child = await waitForChildRun(context, payload);
  const observation = await readChildObservation(context, payload, child);
  if (
    child.conclusion !== "success" ||
    observation.uploadOutcome !== "success" ||
    observation.deploymentOutcome !== "success" ||
    observation.deploymentId == null ||
    observation.pageUrl !== intent.expectedPageUrl
  ) {
    throw new TypeError("Pages childの公開効果が確定しませんでした");
  }
  const actionsArtifact =
    pagesDeploymentExternalReferenceSchema.options[0].shape.actionsArtifact.parse(
      observation.artifactId == null
        ? {
            kind: "not_exposed",
            artifactName: observation.artifactName,
            limitation: "action_did_not_expose_artifact_id_or_digest",
          }
        : observation.artifactDigest == null
          ? {
              kind: "identified_without_digest",
              artifactId: observation.artifactId,
              limitation: "action_did_not_expose_artifact_digest",
            }
          : {
              kind: "identified",
              artifactId: observation.artifactId,
              artifactDigest: observation.artifactDigest,
            },
    );
  return Object.freeze({
    deploymentReference: observation.deploymentId,
    pageUrl: observation.pageUrl,
    adapterIdentityDigest: await workflowAdapterIdentity(
      dependencies.repositoryPath,
      nodeContentDigestPort,
    ),
    actionsArtifact,
  });
}

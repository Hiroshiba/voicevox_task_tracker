import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

import { z } from "zod";

import { affectedIssueNodeId } from "../../dist/application/tracking-run/excluded-pull-request.js";
import { hashCanonicalJson, serializeCanonicalJson } from "../../dist/canonical-json/index.js";
import { createAiCacheEntry, createAiCacheKey } from "../../dist/codex/cache.js";
import { loadConfig } from "../../dist/config/index.js";
import { AI_ANALYSIS_ELEMENTS } from "../../dist/domain/ai-analysis-elements.js";
import { parseSandboxContext } from "../../dist/infrastructure/tracking-run/sandbox-context.js";
import { parseStateSnapshot } from "../../dist/persistence/snapshot-v23.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);

function required(name) {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function stateFile(revision, path) {
  return execFileSync("git", ["show", `${revision}:${path}`], {
    cwd: required("SANDBOX_STATE_REPOSITORY_PATH"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function firstGeneratedElements(snapshot, item) {
  return AI_ANALYSIS_ELEMENTS.filter(
    (element) =>
      item.aiAnalysis.elements[element]?.generation.metadata.generatedAt === snapshot.generatedAt,
  );
}

function firstExecutedAdoption(snapshot, item, element) {
  const adopted = item.aiAnalysis.adoptedElements[element];
  const evaluated = item.aiAnalysis.elements[element];
  return (
    item.aiAnalysis.applications[element]?.status === "current_ai" &&
    item.aiAnalysis.applications[element].origin === "executed" &&
    adopted?.origin === "current" &&
    adopted.reuseProof.status === "verified" &&
    adopted.generation.metadata.generatedAt === snapshot.generatedAt &&
    evaluated?.generation.metadata.generatedAt === snapshot.generatedAt &&
    serializeCanonicalJson(adopted.generation) === serializeCanonicalJson(evaluated.generation)
  );
}

function cacheProof(revision, cacheDirectory, element, generation) {
  const metadata = generation.metadata;
  const cacheKey = createAiCacheKey({
    element,
    revision: metadata.revision,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    backendVersion: metadata.backendVersion,
    schemaVersion: metadata.schemaVersion,
    inputFingerprint: metadata.inputFingerprint,
    executionFingerprint: metadata.executionFingerprint,
  });
  const path = `${cacheDirectory}/${cacheKey.slice("sha256:".length)}.json`;
  const entry = createAiCacheEntry(JSON.parse(stateFile(revision, path)));
  if (
    entry.cacheKey !== cacheKey ||
    entry.element !== element ||
    serializeCanonicalJson(entry.generation) !== serializeCanonicalJson(generation)
  ) {
    throw new TypeError("firstの実file cacheがsnapshotの生成結果と一致しません");
  }
  return {
    element,
    inputFingerprint: metadata.inputFingerprint,
    cacheKey,
    generationDigest: hashCanonicalJson(generation),
  };
}

async function selectProbe() {
  const revision = revisionSchema.parse(required("SANDBOX_FIRST_FINAL_REVISION"));
  const firstRunId = runIdSchema.parse(required("SANDBOX_FIRST_TRACKING_RUN_ID"));
  const snapshot = parseStateSnapshot(stateFile(revision, "state/snapshot.json"));
  if (snapshot.run.id !== firstRunId) {
    throw new TypeError("firstのsnapshotとtracking run IDが一致しません");
  }
  const config = await loadConfig(new URL("../../config.yml", import.meta.url));
  const items = [...snapshot.items].sort((left, right) => {
    if (left.nodeId < right.nodeId) {
      return -1;
    }
    if (left.nodeId > right.nodeId) {
      return 1;
    }
    return 0;
  });
  const first = items.find(
    (item) =>
      item.nodeId !== affectedIssueNodeId &&
      firstGeneratedElements(snapshot, item).some((element) =>
        firstExecutedAdoption(snapshot, item, element),
      ),
  );
  if (first == null) {
    throw new TypeError("firstに実AI採用とcache probeの対象nodeがありません");
  }
  const elements = firstGeneratedElements(snapshot, first).map((element) => {
    const evaluated = first.aiAnalysis.elements[element];
    if (evaluated == null) {
      throw new TypeError("firstのcache probe対象に生成結果がありません");
    }
    return cacheProof(revision, config.state.aiCacheDirectory, element, evaluated.generation);
  });
  const second = items.find(
    (item) =>
      item.nodeId !== first.nodeId &&
      AI_ANALYSIS_ELEMENTS.some((element) => firstExecutedAdoption(snapshot, item, element)),
  );
  if (second == null) {
    throw new TypeError("firstに別nodeのsnapshot再利用対象がありません");
  }
  const reuseElement = AI_ANALYSIS_ELEMENTS.find((element) =>
    firstExecutedAdoption(snapshot, second, element),
  );
  if (reuseElement == null) {
    throw new TypeError("firstに別nodeの実AI採用要素がありません");
  }
  const adopted = second.aiAnalysis.adoptedElements[reuseElement];
  if (adopted?.origin !== "current") {
    throw new TypeError("firstに別nodeの現行AI採用値がありません");
  }
  return {
    nodeId: first.nodeId,
    elements,
    snapshotReuse: {
      nodeId: second.nodeId,
      element: reuseElement,
      inputFingerprint: adopted.generation.metadata.inputFingerprint,
      generationDigest: hashCanonicalJson(adopted.generation),
    },
  };
}

const probe = await selectProbe();
switch (process.argv[2]) {
  case "select":
    writeFileSync(
      required("SANDBOX_CACHE_PROBE_OUTPUT_PATH"),
      `${serializeCanonicalJson(probe)}\n`,
      {
        mode: 0o600,
      },
    );
    break;
  case "verify": {
    const context = parseSandboxContext(
      JSON.parse(readFileSync(required("SANDBOX_CONTEXT_PATH"), "utf8")),
    );
    if (
      context.analysisMode.kind !== "cache_probe" ||
      serializeCanonicalJson(context.analysisMode.probe) !== serializeCanonicalJson(probe)
    ) {
      throw new TypeError("continuity secondのcache probeがfirstの保存結果と一致しません");
    }
    break;
  }
  default:
    throw new TypeError("cache probe commandが不正です");
}

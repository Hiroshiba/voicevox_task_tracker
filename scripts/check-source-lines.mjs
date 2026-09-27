import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INITIAL_SOURCE_LINE_BASELINE } from "../config/source-line-baseline-inventory.mjs";
import {
  isSourceLineExcluded,
  SOURCE_LINE_CHECKER_VERSION,
  SOURCE_LINE_EXTENSIONS,
  SOURCE_LINE_PERMANENT_EXCLUSIONS,
  SOURCE_LINE_ROOTS,
} from "../config/source-line-policy.mjs";

const BASELINE_PATH = "config/refactor-source-line-baseline.json";
const CACHE_PATH = "node_modules/.cache/voicevox-task-tracker/source-lines.json";
const BASELINE_COMMIT = "2facf26033517ee7138a95b70ee1c0116028bc9a";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (isSourceLineExcluded(path)) {
      return [];
    }
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (entry.isFile() && SOURCE_LINE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      return [path];
    }
    return [];
  });
}

function readBaseline() {
  const baselineBytes = readFileSync(BASELINE_PATH);
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  if (
    baseline.baselineCommit !== BASELINE_COMMIT ||
    !Array.isArray(baseline.entries) ||
    Object.keys(baseline).sort().join(",") !== "baselineCommit,entries"
  ) {
    throw new TypeError("source line baselineの形式または基準commitが一致しません");
  }
  const initial = new Map(INITIAL_SOURCE_LINE_BASELINE.map((entry) => [entry.path, entry]));
  const entries = new Map();
  for (const entry of baseline.entries) {
    if (
      typeof entry !== "object" ||
      entry == null ||
      Object.keys(entry).sort().join(",") !== "lineCount,path,sha256"
    ) {
      throw new TypeError("source line baselineのentry形式が不正です");
    }
    const expected = initial.get(entry.path);
    if (
      expected == null ||
      entry.lineCount !== expected.lineCount ||
      entry.sha256 !== expected.sha256 ||
      entries.has(entry.path)
    ) {
      throw new TypeError(
        `source line baselineに追加または変更されたentryがあります: ${entry.path}`,
      );
    }
    entries.set(entry.path, entry);
  }
  return { entries, digest: sha256(baselineBytes) };
}

function readCache(key) {
  if (!existsSync(CACHE_PATH)) {
    return {};
  }
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  if (cache.key !== key) {
    return {};
  }
  if (typeof cache.entries !== "object" || cache.entries == null || Array.isArray(cache.entries)) {
    throw new TypeError("source line cacheの形式が不正です");
  }
  return cache.entries;
}

function lineCount(bytes) {
  const source = bytes.toString("utf8");
  return source.split("\n").length - Number(source.endsWith("\n"));
}

function main() {
  const baseline = readBaseline();
  const cacheKey = sha256(
    JSON.stringify({
      checkerVersion: SOURCE_LINE_CHECKER_VERSION,
      roots: SOURCE_LINE_ROOTS,
      extensions: SOURCE_LINE_EXTENSIONS,
      exclusions: SOURCE_LINE_PERMANENT_EXCLUSIONS,
      baselineDigest: baseline.digest,
    }),
  );
  const previousCache = readCache(cacheKey);
  const nextCache = {};
  const failures = [];
  const files = SOURCE_LINE_ROOTS.flatMap((root) => sourceFiles(root));
  const seen = new Set(files);

  for (const path of files) {
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    const cached = previousCache[path];
    const lines = cached?.sha256 === digest ? cached.lineCount : lineCount(bytes);
    nextCache[path] = { sha256: digest, lineCount: lines };
    const accepted = baseline.entries.get(path);
    if (accepted != null && (accepted.sha256 !== digest || accepted.lineCount !== lines)) {
      failures.push(`${path}: 一時許可対象の内容または行数が基準から変わりました`);
    } else if (accepted != null && lines <= 1000) {
      failures.push(`${path}: 1000行以下になったため一時許可entryを削除してください`);
    } else if (accepted == null && lines > 1000) {
      failures.push(`${path}: ${lines}行です。上限は1000行です`);
    }
  }
  for (const path of baseline.entries.keys()) {
    if (!seen.has(path)) {
      failures.push(`${path}: 一時許可対象のfileが存在しません`);
    }
  }
  if (failures.length > 0) {
    throw new TypeError(failures.join("\n"));
  }
  mkdirSync(join("node_modules", ".cache", "voicevox-task-tracker"), { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify({ key: cacheKey, entries: nextCache })}\n`);
}

main();

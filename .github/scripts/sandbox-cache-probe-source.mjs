import { execFileSync } from "node:child_process";
import { URL } from "node:url";

import { createAiCacheEntry } from "../../dist/codex/cache.js";
import { loadConfig } from "../../dist/config/index.js";
import { readFirstFileCacheProbeSource } from "../../dist/infrastructure/tracking-run/sandbox-cache-probe-source.js";
import { parseStateSnapshot } from "../../dist/persistence/snapshot-v23.js";

/** F1のsnapshotと実file cacheから候補を読み取る。 */
export async function firstFileCacheProbeSource(repositoryPath, revision, firstRunId) {
  const readFile = (path) =>
    execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const snapshot = parseStateSnapshot(readFile("state/snapshot.json"));
  if (snapshot.run.id !== firstRunId) {
    throw new TypeError("firstのsnapshotとtracking run IDが一致しません");
  }
  const config = await loadConfig(new URL("../../config.yml", import.meta.url));
  const cacheDirectory = config.state.aiCacheDirectory;
  const paths = new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", cacheDirectory], {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .trim()
      .split("\n"),
  );
  return readFirstFileCacheProbeSource(snapshot, {
    read: async (cacheKey) => {
      const path = `${cacheDirectory}/${cacheKey.slice("sha256:".length)}.json`;
      if (!paths.has(path)) {
        return { status: "miss" };
      }
      return { status: "hit", entry: createAiCacheEntry(JSON.parse(readFile(path))) };
    },
  });
}

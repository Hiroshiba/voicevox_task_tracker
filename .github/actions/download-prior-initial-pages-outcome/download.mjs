import { Buffer } from "node:buffer";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

const artifactName = "initial-pages-deployment-record";
const expectedFileName = "initial-pages-deployment.json";
const pageSize = 100;
const maximumPages = 1000;
const maximumArchiveBytes = 4 * 1024 * 1024;
const maximumOutcomeBytes = 1024 * 1024;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

async function request(url, headers) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await globalThis.fetch(url, { headers, redirect: "manual" });
    } catch (error) {
      if (attempt === 2) {
        throw new Error("Actions artifact取得の通信に失敗しました", { cause: error });
      }
      await setTimeout(1000 * (attempt + 1));
      continue;
    }
    if (isTransientStatus(response.status) && attempt < 2) {
      await response.body?.cancel();
      await setTimeout(1000 * (attempt + 1));
      continue;
    }
    if (!response.ok && response.status !== 302) {
      throw new Error(`Actions artifact取得がHTTP ${response.status}で失敗しました`);
    }
    return response;
  }
  throw new TypeError("Actions artifact取得の再試行が完了しませんでした");
}

function parseArtifactPage(value) {
  if (
    value == null ||
    typeof value !== "object" ||
    !Array.isArray(value.artifacts) ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0
  ) {
    throw new TypeError("Actions artifact一覧の形式が不正です");
  }
  const artifacts = value.artifacts.map((artifact) => {
    if (
      artifact == null ||
      typeof artifact !== "object" ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id < 1 ||
      typeof artifact.name !== "string"
    ) {
      throw new TypeError("Actions artifactの識別子が不正です");
    }
    return { id: artifact.id, name: artifact.name };
  });
  return { totalCount: value.total_count, artifacts };
}

async function listPriorArtifact(apiUrl, repository, runId, token) {
  const matches = [];
  let totalCount;
  let listed = 0;
  for (let page = 1; page <= maximumPages; page += 1) {
    const url = new URL(
      `repos/${repository}/actions/runs/${runId}/artifacts?per_page=${pageSize}&page=${page}`,
      `${apiUrl.replace(/\/$/u, "")}/`,
    );
    const response = await request(url, {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    });
    const raw = await response.json();
    const result = parseArtifactPage(raw);
    if (totalCount == null) {
      totalCount = result.totalCount;
    }
    const artifacts = result.artifacts;
    listed += artifacts.length;
    if (
      result.totalCount !== totalCount ||
      listed > totalCount ||
      (listed < totalCount && artifacts.length !== pageSize)
    ) {
      throw new TypeError("Actions artifact一覧のページ数が一致しません");
    }
    matches.push(...artifacts.filter((artifact) => artifact.name === artifactName));
    if (matches.length > 1) {
      throw new TypeError("保存済み初回Pages公開結果が重複しています");
    }
    if (listed === totalCount) {
      return matches[0]?.id;
    }
  }
  throw new TypeError("Actions artifact一覧の全ページを確認できませんでした");
}

async function archiveBytes(apiUrl, repository, artifactId, token) {
  const url = new URL(
    `repos/${repository}/actions/artifacts/${artifactId}/zip`,
    `${apiUrl.replace(/\/$/u, "")}/`,
  );
  let response = await request(url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  });
  for (let redirect = 0; response.status === 302 && redirect < 5; redirect += 1) {
    const location = response.headers.get("location");
    if (location == null) {
      throw new TypeError("Actions artifactのdownload先がありません");
    }
    response = await request(new URL(location, url), {});
  }
  if (response.status === 302) {
    throw new TypeError("Actions artifactのdownload先を確定できません");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumArchiveBytes) {
    throw new TypeError("保存済み初回Pages artifactが許容byte数を超えています");
  }
  const reader = response.body?.getReader();
  if (reader == null) {
    throw new TypeError("Actions artifactのdownload結果がありません");
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks);
    }
    total += value.byteLength;
    if (total > maximumArchiveBytes) {
      await reader.cancel();
      throw new TypeError("保存済み初回Pages artifactが許容byte数を超えています");
    }
    chunks.push(value);
  }
}

function extractOutcome(archive) {
  let endOffset = -1;
  for (
    let offset = archive.byteLength - 22;
    offset >= Math.max(0, archive.byteLength - 65557);
    offset -= 1
  ) {
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.byteLength
    ) {
      endOffset = offset;
      break;
    }
  }
  if (
    endOffset < 0 ||
    archive.readUInt16LE(endOffset + 4) !== 0 ||
    archive.readUInt16LE(endOffset + 6) !== 0 ||
    archive.readUInt16LE(endOffset + 8) !== 1 ||
    archive.readUInt16LE(endOffset + 10) !== 1
  ) {
    throw new TypeError("保存済み初回Pages artifactのZIP構造が不正です");
  }
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    centralSize < 46 ||
    centralOffset + centralSize !== endOffset ||
    archive.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    throw new TypeError("保存済み初回Pages artifactのZIP索引が不正です");
  }
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const checksum = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const expectedName = Buffer.from(expectedFileName);
  if (
    flags & 1 ||
    (method !== 0 && method !== 8) ||
    uncompressedSize === 0 ||
    uncompressedSize > maximumOutcomeBytes ||
    centralSize !== 46 + nameLength + extraLength + commentLength ||
    !archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).equals(expectedName) ||
    localOffset + 30 > centralOffset ||
    archive.readUInt32LE(localOffset) !== 0x04034b50 ||
    archive.readUInt16LE(localOffset + 6) !== flags ||
    archive.readUInt16LE(localOffset + 8) !== method
  ) {
    throw new TypeError("保存済み初回Pages artifactのZIP内容が不正です");
  }
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  if (
    !archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(expectedName) ||
    dataOffset + compressedSize > centralOffset
  ) {
    throw new TypeError("保存済み初回Pages artifactのZIP本文が不正です");
  }
  const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
  const outcome =
    method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: maximumOutcomeBytes + 1 });
  if (outcome.byteLength !== uncompressedSize || crc32(outcome) !== checksum) {
    throw new TypeError("保存済み初回Pages artifactのZIP検査値が一致しません");
  }
  return outcome;
}

async function main() {
  const apiUrl = requiredEnvironment("GITHUB_API_URL");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const runId = requiredEnvironment("PRIOR_OUTCOME_RUN_ID");
  const token = requiredEnvironment("ACTIONS_READ_TOKEN");
  const outputPath = resolve(requiredEnvironment("PRIOR_OUTCOME_PATH"));
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  const githubEnvironment = requiredEnvironment("GITHUB_ENV");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !/^[1-9][0-9]*$/u.test(runId)) {
    throw new TypeError("Actions runの指定が不正です");
  }
  if (basename(outputPath) !== expectedFileName) {
    throw new TypeError("保存済み初回Pages公開結果の保存先が不正です");
  }
  const artifactId = await listPriorArtifact(apiUrl, repository, runId, token);
  const status = artifactId == null ? "no_previous" : "downloaded";
  if (artifactId != null) {
    const outcome = extractOutcome(await archiveBytes(apiUrl, repository, artifactId, token));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, outcome, { flag: "wx" });
  }
  await appendFile(githubOutput, `status=${status}\n`);
  await appendFile(githubEnvironment, `VOICEVOX_PREVIOUS_INITIAL_OUTCOME_STATUS=${status}\n`);
}

await main();

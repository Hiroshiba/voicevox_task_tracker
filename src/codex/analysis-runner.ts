import { z } from "zod";

import {
  selectAiAnalysisCandidates,
  type AiAnalysisCandidate,
  type AiAnalysisFingerprint,
  type AiAnalysisSkipReason,
  type PreparedAiAnalysisCandidate,
} from "./analysis-selection.js";
import { planAiAnalysisBudget, type AiAnalysisDeferReason, type AiRunBudget } from "./budget.js";
import {
  createAiCacheEntry,
  createAiCacheKey,
  determineAiCacheReuse,
  type AiCacheIdentity,
  type AiCacheStore,
} from "./cache.js";
import { hashCanonicalJson } from "./canonical-json.js";
import { type CodexAnalysisInput } from "./input.js";
import { createUtcIsoDateTime, type AnalysisMetadata } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

/** AI実行とcache再現性を固定するversion情報。 */
export type AiAnalysisRunIdentity = Readonly<{
  deterministicRulesVersion: string;
  model: string;
  backendVersion: string;
  promptVersion: string;
  schemaVersion: string;
}>;

/** 1 runのAI cacheと予算管理設定。 */
export type AiAnalysisRunConfiguration = Readonly<{
  identity: AiAnalysisRunIdentity;
  budget: AiRunBudget;
}>;

/** AI分析runへ注入する副作用境界。 */
export type AiAnalysisRunDependencies = Readonly<{
  cache: AiCacheStore;
  execute: (input: CodexAnalysisInput) => Promise<unknown>;
  executedAt: () => string;
}>;

/** cache再利用または新規実行で取得したAI結果。 */
export type AiAnalysisRunItemResult = Readonly<{
  candidateId: string;
  origin: "cache" | "executed";
  fingerprint: AiAnalysisFingerprint;
  output: unknown;
  metadata: AnalysisMetadata;
}>;

/** 1 runのAI分析、抑止、延期と予算使用量。 */
export type AiAnalysisRunResult = Readonly<{
  results: readonly AiAnalysisRunItemResult[];
  skipped: readonly Readonly<{
    candidateId: string;
    reason: AiAnalysisSkipReason;
  }>[];
  deferred: readonly Readonly<{
    candidateId: string;
    reason: AiAnalysisDeferReason;
  }>[];
  usage: Readonly<{
    calls: number;
    inputCharacters: number;
    estimatedCostUsd: number;
  }>;
}>;

type CacheMissCandidate = Readonly<{
  candidate: PreparedAiAnalysisCandidate;
  identity: AiCacheIdentity;
}>;

const jsonValueSchema = z.json();

function createCacheIdentity(
  candidate: PreparedAiAnalysisCandidate,
  identity: AiAnalysisRunIdentity,
): AiCacheIdentity {
  return Object.freeze({
    model: identity.model,
    backendVersion: identity.backendVersion,
    promptVersion: identity.promptVersion,
    schemaVersion: identity.schemaVersion,
    inputHash: candidate.fingerprint.inputHash,
  });
}

function createResult(
  candidate: PreparedAiAnalysisCandidate,
  origin: AiAnalysisRunItemResult["origin"],
  output: unknown,
  metadata: AnalysisMetadata,
): AiAnalysisRunItemResult {
  return Object.freeze({
    candidateId: candidate.id,
    origin,
    fingerprint: candidate.fingerprint,
    output,
    metadata,
  });
}

async function resolveCacheEntries(
  candidates: readonly PreparedAiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  cache: AiCacheStore,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    misses: readonly CacheMissCandidate[];
  }>
> {
  const results: AiAnalysisRunItemResult[] = [];
  const misses: CacheMissCandidate[] = [];
  for (const candidate of candidates) {
    const identity = createCacheIdentity(candidate, configuration.identity);
    const cacheKey = createAiCacheKey(identity);
    const cached = await cache.read(cacheKey);
    if (cached.status === "hit") {
      const reuse = determineAiCacheReuse(cached.entry, identity, candidate.fingerprint.sourceHash);
      if (reuse.status === "reusable") {
        results.push(createResult(candidate, "cache", reuse.entry.output, reuse.entry.metadata));
        continue;
      }
    }
    misses.push(
      Object.freeze({
        candidate,
        identity,
      }),
    );
  }
  return Object.freeze({
    results: Object.freeze(results),
    misses: Object.freeze(misses),
  });
}

function findCacheMiss(
  cacheMisses: readonly CacheMissCandidate[],
  candidate: PreparedAiAnalysisCandidate,
): CacheMissCandidate {
  const cacheMiss = cacheMisses.find((value) => value.candidate.id === candidate.id);
  assertNonNullable(cacheMiss, `Codex分析候補のcache miss情報がありません。対象: ${candidate.id}`);
  return cacheMiss;
}

async function executeSelectedCandidates(
  selected: readonly PreparedAiAnalysisCandidate[],
  cacheMisses: readonly CacheMissCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<readonly AiAnalysisRunItemResult[]> {
  const results: AiAnalysisRunItemResult[] = [];
  for (const candidate of selected) {
    const cacheMiss = findCacheMiss(cacheMisses, candidate);
    const output = jsonValueSchema.parse(await dependencies.execute(candidate.input));
    const metadata = Object.freeze({
      deterministicRulesVersion: configuration.identity.deterministicRulesVersion,
      model: configuration.identity.model,
      backendVersion: configuration.identity.backendVersion,
      promptVersion: configuration.identity.promptVersion,
      schemaVersion: configuration.identity.schemaVersion,
      inputHash: candidate.fingerprint.inputHash,
      outputHash: hashCanonicalJson(output),
      executedAt: createUtcIsoDateTime(dependencies.executedAt()),
    }) satisfies AnalysisMetadata;
    const entry = createAiCacheEntry({
      cacheKey: createAiCacheKey(cacheMiss.identity),
      sourceHash: candidate.fingerprint.sourceHash,
      metadata,
      output,
    });
    await dependencies.cache.write(entry);
    results.push(createResult(candidate, "executed", entry.output, entry.metadata));
  }
  return Object.freeze(results);
}

/** 曖昧な変更項目だけをcacheとrun予算の範囲でCodex分析する。 */
export async function runAiAnalyses(
  candidates: readonly AiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  const selection = selectAiAnalysisCandidates(candidates);
  const cached = await resolveCacheEntries(selection.selected, configuration, dependencies.cache);
  const budgetPlan = planAiAnalysisBudget(
    cached.misses.map((value) => value.candidate),
    configuration.budget,
  );
  const executed = await executeSelectedCandidates(
    budgetPlan.selected,
    cached.misses,
    configuration,
    dependencies,
  );

  return Object.freeze({
    results: Object.freeze([...cached.results, ...executed]),
    skipped: Object.freeze(
      selection.skipped.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    deferred: Object.freeze(
      budgetPlan.deferred.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    usage: budgetPlan.usage,
  });
}

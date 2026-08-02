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
  type AiCacheKey,
  type AiCacheStore,
} from "./cache.js";
import { hashCanonicalJson } from "./canonical-json.js";
import { CodexOutputValidationError, type CodexNonZeroExitDiagnostic } from "./errors.js";
import { type CodexAnalysisInput } from "./input.js";
import { type ValidatedCodexAnalysisOutput } from "./output-types.js";
import { validateCodexAnalysisOutput } from "./output-validation.js";
import { executeValidatedCodexAnalysis, type CodexUnavailableReason } from "./reducer.js";
import {
  createUtcIsoDateTime,
  type AnalysisMetadata,
  type ReasoningEffort,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

/** AI実行とcache再現性を固定する実行設定とversion情報。 */
export type AiAnalysisRunIdentity = Readonly<{
  deterministicRulesVersion: string;
  model: string;
  reasoningEffort: ReasoningEffort;
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
  cacheKey: AiCacheKey;
  fingerprint: AiAnalysisFingerprint;
  output: ValidatedCodexAnalysisOutput;
  metadata: AnalysisMetadata;
}>;

/** Codex実行または出力検証に失敗してfallbackする項目。 */
export type AiAnalysisRunFailure = Readonly<{
  candidateId: string;
  reason: CodexUnavailableReason;
  errorType: string;
  diagnostic?: CodexNonZeroExitDiagnostic;
}>;

/** 1 runのAI分析、抑止、延期と予算使用量。 */
export type AiAnalysisRunResult = Readonly<{
  results: readonly AiAnalysisRunItemResult[];
  failures: readonly AiAnalysisRunFailure[];
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

function createCacheIdentity(
  candidate: PreparedAiAnalysisCandidate,
  identity: AiAnalysisRunIdentity,
): AiCacheIdentity {
  return Object.freeze({
    model: identity.model,
    reasoningEffort: identity.reasoningEffort,
    backendVersion: identity.backendVersion,
    promptVersion: identity.promptVersion,
    schemaVersion: identity.schemaVersion,
    inputHash: candidate.fingerprint.inputHash,
  });
}

function createResult(
  candidate: PreparedAiAnalysisCandidate,
  origin: AiAnalysisRunItemResult["origin"],
  cacheKey: AiCacheKey,
  output: ValidatedCodexAnalysisOutput,
  metadata: AnalysisMetadata,
): AiAnalysisRunItemResult {
  return Object.freeze({
    candidateId: candidate.id,
    origin,
    cacheKey,
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
        try {
          const output = validateCodexAnalysisOutput(reuse.entry.output, candidate.input);
          results.push(
            createResult(candidate, "cache", reuse.entry.cacheKey, output, reuse.entry.metadata),
          );
          continue;
        } catch (error: unknown) {
          if (!(error instanceof CodexOutputValidationError)) {
            throw error;
          }
        }
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

function assertUnchangedCandidatesAreCached(
  cacheMisses: readonly CacheMissCandidate[],
  selectedCandidateIds: ReadonlySet<string>,
): void {
  const missing = cacheMisses.find((value) => !selectedCandidateIds.has(value.candidate.id));
  if (missing != null) {
    throw new TypeError(
      `未変更のCodex分析候補に対応するcacheがありません。対象: ${missing.candidate.id}`,
    );
  }
}

async function executeSelectedCandidates(
  selected: readonly PreparedAiAnalysisCandidate[],
  cacheMisses: readonly CacheMissCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    failures: readonly AiAnalysisRunFailure[];
  }>
> {
  const results: AiAnalysisRunItemResult[] = [];
  const failures: AiAnalysisRunFailure[] = [];
  for (const candidate of selected) {
    const cacheMiss = findCacheMiss(cacheMisses, candidate);
    const attempt = await executeValidatedCodexAnalysis(candidate.input, dependencies.execute);
    if (attempt.status === "unavailable") {
      failures.push(
        Object.freeze({
          candidateId: candidate.id,
          reason: attempt.reason,
          errorType: attempt.errorType,
          ...(attempt.diagnostic == null ? {} : { diagnostic: attempt.diagnostic }),
        }),
      );
      continue;
    }
    const output = attempt.output;
    const metadata = Object.freeze({
      deterministicRulesVersion: configuration.identity.deterministicRulesVersion,
      model: configuration.identity.model,
      reasoningEffort: configuration.identity.reasoningEffort,
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
    results.push(createResult(candidate, "executed", entry.cacheKey, output, entry.metadata));
  }
  return Object.freeze({
    results: Object.freeze(results),
    failures: Object.freeze(failures),
  });
}

/** 曖昧な変更項目だけをcacheとrun予算の範囲でCodex分析する。 */
export async function runAiAnalyses(
  candidates: readonly AiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  const selection = selectAiAnalysisCandidates(candidates);
  const unchangedCandidates = selection.skipped.flatMap((value) =>
    value.reason === "unchanged" ? [value.candidate] : [],
  );
  const cached = await resolveCacheEntries(
    [...selection.selected, ...unchangedCandidates],
    configuration,
    dependencies.cache,
  );
  const selectedCandidateIds = new Set(selection.selected.map((candidate) => candidate.id));
  assertUnchangedCandidatesAreCached(cached.misses, selectedCandidateIds);
  const selectedCacheMisses = cached.misses.filter((value) =>
    selectedCandidateIds.has(value.candidate.id),
  );
  const budgetPlan = planAiAnalysisBudget(
    selectedCacheMisses.map((value) => value.candidate),
    configuration.budget,
  );
  const executed = await executeSelectedCandidates(
    budgetPlan.selected,
    selectedCacheMisses,
    configuration,
    dependencies,
  );

  return Object.freeze({
    results: Object.freeze([...cached.results, ...executed.results]),
    failures: executed.failures,
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

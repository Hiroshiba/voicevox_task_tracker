import {
  AI_ANALYSIS_ELEMENTS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
  type AiAnalysisElementResult,
} from "./analysis-elements.js";
import {
  type AiAnalysisTarget,
  type AiAnalysisRunIdentity,
  type AiAnalysisSkipReason,
  type PreparedAiAnalysisCandidate,
} from "./analysis-selection.js";
import type { GenericAiPlan } from "../application/tracking-run/stages/generic-ai-plan.js";
import { summarizeAiBudgetLedger } from "../application/tracking-run/contracts/ai-budget-ledger.js";
import {
  planAiAnalysisBudget,
  planAiAnalysisBudgetWithPreflight,
  type AiAnalysisDeferReason,
  type AiBudgetUsage,
  type AiPreflightBudget,
  type AiRunBudget,
} from "./budget.js";
import {
  CodexAttemptBudgetExceededError,
  prepareCodexInitialAttempts,
  type CodexAttemptBudget,
  type CodexInitialAttemptTicket,
} from "./attempt-budget.js";
import {
  createAiCacheEntry,
  createAiCacheKey,
  determineAiCacheReuse,
  type AiCacheEntry,
  type AiCacheIdentity,
  type AiCacheKey,
  type AiCacheStore,
} from "./cache.js";
import { hashCanonicalJson, parseSha256Hash } from "../canonical-json/index.js";
import {
  CodexAttemptError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
  CodexNonZeroExitError,
  type CodexNonZeroExitDiagnostic,
  type CodexOutputValidationDiagnostic,
} from "./errors.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "./diagnostics.js";
import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import { createCodexAnalysisInput, type CodexAnalysisInput } from "./input.js";
import { type SchemaValidCodexElementOutput } from "./element-output.js";
import { CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION } from "./element-output-schema.js";
import { aiAnalysisElementGenerationSchema } from "./analysis-elements.js";
import { classifyCodexUnavailableReason, type CodexUnavailableReason } from "./reducer.js";
import { validateCodexAnalysisSemantics } from "./semantic-validation.js";
import { type CodexSemanticValidationIssueCode } from "./semantic-validation-issues.js";
import { createUtcIsoDateTime, type AnalysisMetadata } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

/** 1 runのAI cache、予算、実行方針の設定。 */
export type AiAnalysisRunConfiguration = Readonly<{
  identity: AiAnalysisRunIdentity;
  budget: AiRunBudget;
  initialUsage: AiBudgetUsage;
  maxConcurrentCalls: number;
}>;

/** AI分析前に実行するCodex認証preflight。 */
export type AiAnalysisPreflight = Readonly<
  AiPreflightBudget & {
    execute: (ticket: CodexInitialAttemptTicket) => Promise<void>;
  }
>;

/** AI分析runへ注入する副作用境界。 */
export type AiAnalysisRunDependencies = Readonly<{
  cache: AiCacheStore;
  attemptBudget: CodexAttemptBudget;
  ensureReady: () => Promise<void>;
  execute: (input: CodexAnalysisInput, context: AiAnalysisExecutionContext) => Promise<unknown>;
  executedAt: () => string;
  preflight?: AiAnalysisPreflight;
  diagnostics?: CodexDiagnosticsContext;
}>;

/** AI分析の実行候補を識別し、今回の選択要素を伝えるcontext。 */
export type AiAnalysisExecutionContext = Readonly<{
  candidateId: string;
  selectedElements: readonly AiAnalysisElement[];
  initialAttemptTicket: CodexInitialAttemptTicket;
}>;

/** cache再利用または新規実行で取得した要素別AI結果。 */
export type AiAnalysisRunElementResult = Readonly<{
  element: AiAnalysisElement;
  origin: "cache" | "executed";
  cacheKey: AiCacheKey;
  generation: AiAnalysisElementGeneration;
}>;

/** 一つのIssueまたはPull Requestについて取得したAI結果。 */
export type AiAnalysisRunItemResult = Readonly<{
  candidateId: string;
  origin: "cache" | "executed" | "mixed";
  elements: readonly AiAnalysisRunElementResult[];
}>;

/** Codex実行または出力検証に失敗してfallbackする項目。 */
export type AiAnalysisRunFailure = Readonly<{
  candidateId: string;
  reason: CodexUnavailableReason;
  errorType: string;
  diagnostic?: CodexNonZeroExitDiagnostic;
  validationDiagnostic?: CodexOutputValidationDiagnostic;
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
  usage: AiBudgetUsage;
  authenticationPreflightExecuted: boolean;
}>;

type CandidateCacheState = Readonly<{
  candidate: PreparedAiAnalysisCandidate;
  cached: readonly AiAnalysisRunElementResult[];
  misses: readonly PreparedAiAnalysisCandidate["selectedElements"][number][];
}>;

type CandidateExecutionOutcome =
  | Readonly<{
      status: "result";
      result: AiAnalysisRunItemResult;
    }>
  | Readonly<{
      status: "failure";
      failure: AiAnalysisRunFailure;
    }>
  | Readonly<{
      status: "deferred";
      candidateId: string;
    }>;

function candidateDiagnosticsContext(
  context: CodexDiagnosticsContext | undefined,
  candidateId: string,
): CodexDiagnosticsContext | undefined {
  if (context == null) {
    return undefined;
  }
  return Object.freeze({
    ...context,
    candidateId,
  });
}

function validationFailureEvent(error: unknown): string {
  if (error instanceof CodexOutputSchemaValidationError) {
    return "codex.output.schema_validation_failed";
  }
  if (error instanceof CodexOutputSemanticValidationError) {
    return "codex.output.semantic_validation_failed";
  }
  if (error instanceof CodexAttemptError) {
    return "codex.fallback";
  }
  return "codex.analysis.failed";
}

async function recordCandidateFailure(
  context: CodexDiagnosticsContext | undefined,
  candidateId: string,
  error: unknown,
  phase: "execution" | "cache",
): Promise<void> {
  const candidateContext = candidateDiagnosticsContext(context, candidateId);
  const details: Record<string, DiagnosticsJsonValue> = {
    phase,
    errorType: error instanceof Error ? error.name : typeof error,
  };
  if (error instanceof CodexAttemptError) {
    details["attempt"] = error.attempts;
  }
  if (error instanceof CodexOutputValidationError) {
    details["issueCount"] = error.issues.length;
    details["issues"] = Object.freeze(
      error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
        Object.freeze({
          path: issue.path,
          code: issue.code,
        }),
      ),
    );
  }
  await recordCodexDiagnostic(candidateContext, validationFailureEvent(error), details, error);
}

function createCacheIdentity(
  identity: AiAnalysisRunIdentity,
  elementCandidate: PreparedAiAnalysisCandidate["selectedElements"][number],
): AiCacheIdentity {
  return Object.freeze({
    ...identity,
    element: elementCandidate.element,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[elementCandidate.element],
    inputFingerprint: parseSha256Hash(elementCandidate.inputFingerprint),
    executionFingerprint: parseSha256Hash(elementCandidate.executionFingerprint),
  });
}

function resultForElement(
  output: SchemaValidCodexElementOutput,
  element: AiAnalysisElement,
): AiAnalysisElementResult {
  function requiredResult<T>(value: T | undefined, message: string): T {
    assertNonNullable(value, message);
    return value;
  }

  switch (element) {
    case "status":
      return requiredResult(output.status, "検証済みCodex出力のstatusがありません");
    case "waitingOn":
      return requiredResult(output.waitingOn, "検証済みCodex出力のwaitingOnがありません");
    case "nextAction":
      return requiredResult(output.nextAction, "検証済みCodex出力のnextActionがありません");
    case "relations":
      return requiredResult(output.relations, "検証済みCodex出力のrelationsがありません");
    case "progress":
      return requiredResult(output.progress, "検証済みCodex出力のprogressがありません");
    case "importance":
      return requiredResult(output.importance, "検証済みCodex出力のimportanceがありません");
    case "deadline":
      return requiredResult(output.deadline, "検証済みCodex出力のdeadlineがありません");
    case "notification":
      return requiredResult(output.notification, "検証済みCodex出力のnotificationがありません");
    case "selfCommitment":
      return requiredResult(output.selfCommitment, "検証済みCodex出力のselfCommitmentがありません");
    default:
      throw new TypeError(`未知のAI判定要素です。対象: ${String(element)}`);
  }
}

function assertOutputItemMatchesInput(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
): void {
  if (output.item.nodeId === input.item.nodeId && output.item.url === input.item.url) {
    return;
  }
  throw new CodexOutputSemanticValidationError([
    Object.freeze({
      path: "/item",
      code: "item_mismatch" satisfies CodexSemanticValidationIssueCode,
      message: "Codex出力のitemが入力対象と一致しません",
    }),
  ]);
}

function validateComposedOutput(
  input: CodexAnalysisInput,
  elements: readonly AiAnalysisRunElementResult[],
): SchemaValidCodexElementOutput {
  const value: Record<string, unknown> = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  for (const element of elements) {
    value[element.element] = element.generation.result;
  }
  const selectedElements = elements.map((element) => element.element);
  const selectedSet = new Set<string>(selectedElements);
  const lockedElements: Record<string, unknown> = {};
  for (const [element, result] of Object.entries(input.lockedElements)) {
    if (!selectedSet.has(element)) {
      lockedElements[element] = result;
    }
  }
  const composedInput = createCodexAnalysisInput({
    ...input,
    selectedElements,
    lockedElements,
  });
  return validateCodexAnalysisSemantics(value, composedInput);
}

function createElementGeneration(
  candidate: PreparedAiAnalysisCandidate,
  elementCandidate: PreparedAiAnalysisCandidate["selectedElements"][number],
  result: AiAnalysisElementResult,
  identity: AiAnalysisRunIdentity,
  generatedAt: string,
): AiAnalysisElementGeneration {
  const metadata = Object.freeze({
    ...identity,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[elementCandidate.element],
    inputFingerprint: parseSha256Hash(elementCandidate.inputFingerprint),
    executionFingerprint: parseSha256Hash(elementCandidate.executionFingerprint),
    promptFingerprint: parseSha256Hash(candidate.promptFingerprint),
    outputHash: hashCanonicalJson(result),
    generatedAt: createUtcIsoDateTime(generatedAt),
  }) satisfies AnalysisMetadata;
  return aiAnalysisElementGenerationSchema.parse({
    metadata,
    result,
  });
}

function createRunElementResult(
  element: AiAnalysisElement,
  origin: "cache" | "executed",
  cacheKey: AiCacheKey,
  generation: AiAnalysisElementGeneration,
): AiAnalysisRunElementResult {
  return Object.freeze({
    element,
    origin,
    cacheKey,
    generation,
  });
}

function createRunItemResult(
  candidateId: string,
  elements: readonly AiAnalysisRunElementResult[],
): AiAnalysisRunItemResult {
  if (elements.length === 0) {
    throw new TypeError(`AI分析結果の要素がありません。対象: ${candidateId}`);
  }
  const hasCache = elements.some((value) => value.origin === "cache");
  const hasExecuted = elements.some((value) => value.origin === "executed");
  const origin = hasCache && hasExecuted ? "mixed" : hasCache ? "cache" : "executed";
  return Object.freeze({
    candidateId,
    origin,
    elements: Object.freeze([...elements]),
  });
}

function createFailure(error: unknown, candidateId: string): AiAnalysisRunFailure {
  const diagnostic =
    error instanceof CodexNonZeroExitError
      ? Object.freeze({
          exitCode: error.exitCode,
          apiError: error.apiError,
        })
      : undefined;
  const validationDiagnostic =
    error instanceof CodexOutputValidationError
      ? Object.freeze({
          issueCount: error.issues.length,
          issues: Object.freeze(
            error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
              Object.freeze({
                path: issue.path,
                code: issue.code,
              }),
            ),
          ),
        })
      : undefined;
  return Object.freeze({
    candidateId,
    reason: classifyCodexUnavailableReason(error),
    errorType: error instanceof Error ? error.name : typeof error,
    ...(diagnostic == null ? {} : { diagnostic }),
    ...(validationDiagnostic == null ? {} : { validationDiagnostic }),
  });
}

async function resolveCacheEntries(
  candidates: readonly PreparedAiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  cache: AiCacheStore,
  target: AiAnalysisTarget | undefined,
): Promise<
  Readonly<{
    states: readonly CandidateCacheState[];
  }>
> {
  const states: CandidateCacheState[] = [];
  for (const candidate of candidates) {
    const cached: AiAnalysisRunElementResult[] = [];
    const misses: PreparedAiAnalysisCandidate["selectedElements"][number][] = [];
    for (const elementCandidate of candidate.selectedElements) {
      if (target?.nodeId === candidate.id && target.elements.includes(elementCandidate.element)) {
        misses.push(elementCandidate);
        continue;
      }
      const identity = createCacheIdentity(configuration.identity, elementCandidate);
      const cacheKey = createAiCacheKey(identity);
      const cachedValue = await cache.read(cacheKey);
      if (cachedValue.status === "hit") {
        const reuse = determineAiCacheReuse(cachedValue.entry, identity);
        if (reuse.status === "reusable") {
          const result = createRunElementResult(
            elementCandidate.element,
            "cache",
            reuse.entry.cacheKey,
            reuse.entry.generation,
          );
          cached.push(result);
          continue;
        }
      }
      misses.push(elementCandidate);
    }
    states.push(
      Object.freeze({
        candidate,
        cached: Object.freeze(cached),
        misses: Object.freeze(misses),
      }),
    );
  }
  return Object.freeze({
    states: Object.freeze(states),
  });
}

function selectPlannedCandidates(plan: GenericAiPlan): Readonly<{
  selected: readonly PreparedAiAnalysisCandidate[];
  skipped: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }>[];
}> {
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (ids.has(item.nodeId) || item.candidate.id !== item.nodeId) {
      throw new TypeError(`AI計画の候補IDが不正です。対象: ${item.nodeId}`);
    }
    ids.add(item.nodeId);
    const plannedElements = new Set(item.elements.map((value) => value.element));
    const candidateElements = new Set(item.candidate.elements.map((value) => value.element));
    if (
      item.elements.length !== AI_ANALYSIS_ELEMENTS.length ||
      plannedElements.size !== AI_ANALYSIS_ELEMENTS.length ||
      item.candidate.elements.length !== AI_ANALYSIS_ELEMENTS.length ||
      candidateElements.size !== AI_ANALYSIS_ELEMENTS.length ||
      AI_ANALYSIS_ELEMENTS.some((element) => !plannedElements.has(element))
    ) {
      throw new TypeError(`AI計画の要素集合が9要素と一致しません。対象: ${item.nodeId}`);
    }
    const selected = item.candidate.selectedElements.map((value) => value.element);
    const selectedFromPlan = item.elements
      .filter((element) => element.selected)
      .map((element) => element.element);
    if (
      new Set(selected).size !== selected.length ||
      selected.length !== item.selectedElements.length ||
      selected.some((element, index) => element !== item.selectedElements[index]) ||
      selected.some((element, index) => element !== item.candidate.input.selectedElements[index]) ||
      item.candidate.input.selectedElements.length !== selected.length ||
      selectedFromPlan.length !== selected.length ||
      selectedFromPlan.some((element, index) => element !== selected[index])
    ) {
      throw new TypeError(`AI計画の選択要素が候補入力と一致しません。対象: ${item.nodeId}`);
    }
    for (const element of item.elements) {
      const candidate = item.candidate.elements.find((value) => value.element === element.element);
      if (candidate?.inputFingerprint !== element.inputFingerprint) {
        throw new TypeError(
          `AI計画のfingerprintが候補と一致しません。対象: ${item.nodeId}/${element.element}`,
        );
      }
    }
  }
  return Object.freeze({
    selected: Object.freeze(
      plan.items.filter((item) => item.selectedElements.length > 0).map((item) => item.candidate),
    ),
    skipped: Object.freeze(
      plan.items
        .filter((item) => item.selectedElements.length === 0)
        .map((item) =>
          Object.freeze({ candidate: item.candidate, reason: "not_required" as const }),
        ),
    ),
  });
}

function assertTargetWasExecuted(run: AiAnalysisRunResult, target: AiAnalysisTarget): void {
  const result = run.results.find((candidate) => candidate.candidateId === target.nodeId);
  if (result == null) {
    const failure = run.failures.find((candidate) => candidate.candidateId === target.nodeId);
    throw new TypeError(
      `指定したAI分析対象の実推論結果がありません。対象: ${target.nodeId}`,
      failure == null ? {} : { cause: failure },
    );
  }
  for (const element of target.elements) {
    const elementResult = result.elements.find((candidate) => candidate.element === element);
    if (elementResult?.origin !== "executed") {
      throw new TypeError(
        `指定したAI分析対象の要素が実推論されていません。対象: ${target.nodeId} 要素: ${element}`,
      );
    }
  }
}

async function executeCandidate(
  state: CandidateCacheState,
  identity: AiAnalysisRunIdentity,
  dependencies: AiAnalysisRunDependencies,
  ticket: CodexInitialAttemptTicket,
): Promise<CandidateExecutionOutcome> {
  const candidate = state.candidate;
  try {
    const output = validateCodexAnalysisSemantics(
      await dependencies.execute(candidate.input, {
        candidateId: candidate.id,
        selectedElements: Object.freeze(candidate.selectedElements.map((value) => value.element)),
        initialAttemptTicket: ticket,
      }),
      candidate.input,
    );
    assertOutputItemMatchesInput(output, candidate.input);
    const generatedAt = dependencies.executedAt();
    const executedResults: AiAnalysisRunElementResult[] = [];
    const entries: AiCacheEntry[] = [];
    for (const elementCandidate of candidate.selectedElements) {
      const result = resultForElement(output, elementCandidate.element);
      const generation = createElementGeneration(
        candidate,
        elementCandidate,
        result,
        identity,
        generatedAt,
      );
      const cacheKey = createAiCacheKey(createCacheIdentity(identity, elementCandidate));
      const entry = createAiCacheEntry({
        cacheKey,
        element: elementCandidate.element,
        generation,
      });
      entries.push(entry);
      executedResults.push(
        createRunElementResult(
          elementCandidate.element,
          "executed",
          entry.cacheKey,
          entry.generation,
        ),
      );
    }
    validateComposedOutput(candidate.input, [...state.cached, ...executedResults]);
    for (const entry of entries) {
      await dependencies.cache.write(entry);
    }
    return Object.freeze({
      status: "result",
      result: createRunItemResult(candidate.id, [...state.cached, ...executedResults]),
    });
  } catch (error: unknown) {
    if (error instanceof CodexAttemptBudgetExceededError) {
      return Object.freeze({ status: "deferred", candidateId: candidate.id });
    }
    if (!(error instanceof CodexAttemptError || error instanceof CodexOutputValidationError)) {
      throw error;
    }
    await recordCandidateFailure(dependencies.diagnostics, candidate.id, error, "execution");
    return Object.freeze({
      status: "failure",
      failure: createFailure(error, candidate.id),
    });
  }
}

async function executeSelectedCandidates(
  states: readonly CandidateCacheState[],
  selected: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    ticket: CodexInitialAttemptTicket;
  }>[],
  maxConcurrentCalls: number,
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    failures: readonly AiAnalysisRunFailure[];
    deferred: readonly string[];
  }>
> {
  if (!Number.isSafeInteger(maxConcurrentCalls) || maxConcurrentCalls <= 0) {
    throw new RangeError("Codexの最大同時呼び出し数は正の安全な整数にしてください");
  }
  const outcomes = new Map<number, CandidateExecutionOutcome>();
  let nextCandidateIndex = 0;
  let stopped = false;
  const workers = Array.from(
    { length: Math.min(maxConcurrentCalls, selected.length) },
    async () => {
      while (!stopped) {
        const candidateIndex = nextCandidateIndex;
        if (candidateIndex >= selected.length) {
          return;
        }
        nextCandidateIndex += 1;
        const reserved = selected.at(candidateIndex);
        assertNonNullable(reserved, "Codex分析候補を予算計画順に取得できませんでした");
        const { candidate, ticket } = reserved;
        const state = states.find((value) => value.candidate.id === candidate.id);
        assertNonNullable(state, `Codex分析候補のcache stateがありません。対象: ${candidate.id}`);
        try {
          outcomes.set(
            candidateIndex,
            await executeCandidate(state, configuration.identity, dependencies, ticket),
          );
        } catch (error: unknown) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  const settledWorkers = await Promise.allSettled(workers);
  for (const reserved of selected) {
    dependencies.attemptBudget.releaseInitialAttempt(reserved.ticket);
  }
  for (const settledWorker of settledWorkers) {
    if (settledWorker.status === "rejected") {
      throw settledWorker.reason;
    }
  }
  const results: AiAnalysisRunItemResult[] = [];
  const failures: AiAnalysisRunFailure[] = [];
  const deferred: string[] = [];
  for (const candidateIndex of selected.keys()) {
    const outcome = outcomes.get(candidateIndex);
    assertNonNullable(outcome, "Codex分析候補の実行結果がありません");
    if (outcome.status === "result") {
      results.push(outcome.result);
    } else if (outcome.status === "failure") {
      failures.push(outcome.failure);
    } else {
      deferred.push(outcome.candidateId);
    }
  }
  return Object.freeze({
    results: Object.freeze(results),
    failures: Object.freeze(failures),
    deferred: Object.freeze(deferred),
  });
}

/** 確定済みplanの選択要素だけを項目ごとに一回のCodex呼び出しで分析する。 */
export async function runPlannedAiAnalyses(
  plan: GenericAiPlan,
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  const target = plan.target;
  if (configuration.identity !== plan.identity) {
    throw new TypeError("AI実行設定のidentityが計画と一致しません");
  }
  const selection = selectPlannedCandidates(plan);
  const resolved = await resolveCacheEntries(
    selection.selected,
    configuration,
    dependencies.cache,
    target,
  );
  const cachedOnlyResults = resolved.states
    .filter((state) => state.misses.length === 0)
    .map((state) => {
      validateComposedOutput(state.candidate.input, state.cached);
      return createRunItemResult(state.candidate.id, state.cached);
    });
  const executionCandidates = resolved.states
    .filter((state) => state.misses.length !== 0)
    .map((state) => state.candidate);
  const budgetPlan =
    dependencies.preflight == null
      ? planAiAnalysisBudget(executionCandidates, configuration.budget, configuration.initialUsage)
      : planAiAnalysisBudgetWithPreflight(
          executionCandidates,
          configuration.budget,
          configuration.initialUsage,
          dependencies.preflight,
        );
  const reserved = await prepareCodexInitialAttempts(
    budgetPlan.selected,
    dependencies.attemptBudget,
    dependencies.ensureReady,
    "generic_initial",
    dependencies.preflight,
  );
  const executed = await executeSelectedCandidates(
    resolved.states,
    reserved.selected,
    configuration.maxConcurrentCalls,
    configuration,
    dependencies,
  );
  const summary = summarizeAiBudgetLedger(dependencies.attemptBudget.snapshot);
  const itemOrder = new Map<string, number>(plan.items.map((item, index) => [item.nodeId, index]));
  function byPlanOrder(left: string, right: string): number {
    const leftIndex = itemOrder.get(left);
    const rightIndex = itemOrder.get(right);
    assertNonNullable(leftIndex, `AI結果の候補が計画にありません。対象: ${left}`);
    assertNonNullable(rightIndex, `AI結果の候補が計画にありません。対象: ${right}`);
    return leftIndex - rightIndex;
  }
  const result = Object.freeze({
    results: Object.freeze(
      [...cachedOnlyResults, ...executed.results].sort((left, right) =>
        byPlanOrder(left.candidateId, right.candidateId),
      ),
    ),
    failures: Object.freeze(
      [...executed.failures].sort((left, right) =>
        byPlanOrder(left.candidateId, right.candidateId),
      ),
    ),
    skipped: Object.freeze(
      selection.skipped.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    deferred: Object.freeze(
      [
        ...budgetPlan.deferred.map((value) =>
          Object.freeze({
            candidateId: value.candidate.id,
            reason: value.reason,
          }),
        ),
        ...reserved.deferred.map((candidate): AiAnalysisRunResult["deferred"][number] =>
          Object.freeze({ candidateId: candidate.id, reason: "call_limit" }),
        ),
        ...executed.deferred.map((candidateId): AiAnalysisRunResult["deferred"][number] =>
          Object.freeze({ candidateId, reason: "call_limit" }),
        ),
      ].sort((left, right) => byPlanOrder(left.candidateId, right.candidateId)),
    ),
    usage: Object.freeze({
      calls: summary.logicalCandidateCount + summary.authenticationPreflightAttemptCount,
      inputCharacters: summary.inputCharacters,
      estimatedCostUsd: summary.estimatedCostUsd,
    }),
    authenticationPreflightExecuted: reserved.authenticationPreflightExecuted,
  });
  if (target != null) {
    assertTargetWasExecuted(result, target);
  }
  return result;
}

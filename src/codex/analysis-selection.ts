import { hashCanonicalJson, serializeCanonicalJson, type Sha256Hash } from "./canonical-json.js";
import { type CodexAnalysisInput } from "./input.js";

/** Codex分析候補の決定論的な確定状態。 */
export type DeterministicAnalysisResolution = "high_confidence" | "ambiguous";

/** Codex分析の再実行と旧結果再利用を判定するhash一式。 */
export type AiAnalysisFingerprint = Readonly<{
  sourceHash: Sha256Hash;
  inputHash: Sha256Hash;
  graphNeighborhoodHash: Sha256Hash;
}>;

/** 前回のCodex分析fingerprint。 */
export type PreviousAiAnalysisFingerprint =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      fingerprint: AiAnalysisFingerprint;
    }>;

/** 予算不足時のCodex分析優先順位。 */
export type AiAnalysisPriority = Readonly<{
  severityCandidate: boolean;
  ownerUnknown: boolean;
  changedBlocker: boolean;
  downstreamImpact: Readonly<{
    openNodeCount: number;
    repositoryCount: number;
  }>;
}>;

/** Codexへ送る可能性がある項目。 */
export type AiAnalysisCandidate = Readonly<{
  id: string;
  deterministicResolution: DeterministicAnalysisResolution;
  input: CodexAnalysisInput;
  graphNeighborhood: unknown;
  previousFingerprint: PreviousAiAnalysisFingerprint;
  priority: AiAnalysisPriority;
  estimatedCostUsd: number;
}>;

/** hashと入力文字数を確定したCodex分析候補。 */
export type PreparedAiAnalysisCandidate = AiAnalysisCandidate &
  Readonly<{
    fingerprint: AiAnalysisFingerprint;
    normalizedInput: string;
    inputCharacters: number;
  }>;

/** Codexへ送らない理由。 */
export type AiAnalysisSkipReason = "determined_with_high_confidence" | "unchanged";

/** Codex呼び出し対象の純粋な選別結果。 */
export type AiAnalysisSelection = Readonly<{
  selected: readonly PreparedAiAnalysisCandidate[];
  skipped: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }>[];
}>;

/** 前回AI結果の安全な再利用判定。 */
export type PreviousAiResultReuseDecision<Result> =
  | Readonly<{
      status: "reusable";
      result: Result;
    }>
  | Readonly<{
      status: "stale";
      reason: "source_hash_changed" | "input_hash_changed";
    }>;

function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.length === 0) {
      throw new TypeError("空のUnicode文字を検出しました");
    }
    count += 1;
  }
  return count;
}

function validateCandidateId(id: string): void {
  if (id.length === 0) {
    throw new TypeError("Codex分析候補IDは空にできません");
  }
}

/** Codex分析候補の正規化入力、source、グラフ隣接hashを生成する。 */
export function prepareAiAnalysisCandidate(
  candidate: AiAnalysisCandidate,
): PreparedAiAnalysisCandidate {
  validateCandidateId(candidate.id);
  const normalizedInput = `${serializeCanonicalJson(candidate.input)}\n`;
  const graphNeighborhoodHash = hashCanonicalJson(candidate.graphNeighborhood);
  const fingerprint = Object.freeze({
    sourceHash: hashCanonicalJson(candidate.input.sources),
    inputHash: hashCanonicalJson({
      graphNeighborhood: candidate.graphNeighborhood,
      input: candidate.input,
    }),
    graphNeighborhoodHash,
  });
  return Object.freeze({
    ...candidate,
    fingerprint,
    normalizedInput,
    inputCharacters: countUnicodeCharacters(normalizedInput),
  });
}

function shouldSelectCandidate(candidate: PreparedAiAnalysisCandidate): boolean {
  if (candidate.deterministicResolution === "high_confidence") {
    return false;
  }
  if (candidate.previousFingerprint.status === "unavailable") {
    return true;
  }
  return (
    candidate.fingerprint.inputHash !== candidate.previousFingerprint.fingerprint.inputHash ||
    candidate.fingerprint.graphNeighborhoodHash !==
      candidate.previousFingerprint.fingerprint.graphNeighborhoodHash
  );
}

function determineSkipReason(candidate: PreparedAiAnalysisCandidate): AiAnalysisSkipReason {
  if (candidate.deterministicResolution === "high_confidence") {
    return "determined_with_high_confidence";
  }
  return "unchanged";
}

/** 高信頼の確定項目と未変更項目を除き、曖昧な変更項目だけを選ぶ。 */
export function selectAiAnalysisCandidates(
  candidates: readonly AiAnalysisCandidate[],
): AiAnalysisSelection {
  const candidateIds = new Set<string>();
  const selected: PreparedAiAnalysisCandidate[] = [];
  const skipped: {
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }[] = [];

  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`Codex分析候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    const prepared = prepareAiAnalysisCandidate(candidate);
    if (shouldSelectCandidate(prepared)) {
      selected.push(prepared);
    } else {
      skipped.push({
        candidate: prepared,
        reason: determineSkipReason(prepared),
      });
    }
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped.map((value) => Object.freeze(value))),
  });
}

/** sourceと正規化入力のhashが一致する前回AI結果だけを再利用する。 */
export function determinePreviousAiResultReuse<Result>(
  currentFingerprint: AiAnalysisFingerprint,
  previousFingerprint: AiAnalysisFingerprint,
  previousResult: Result,
): PreviousAiResultReuseDecision<Result> {
  if (currentFingerprint.sourceHash !== previousFingerprint.sourceHash) {
    return Object.freeze({
      status: "stale",
      reason: "source_hash_changed",
    });
  }
  if (currentFingerprint.inputHash !== previousFingerprint.inputHash) {
    return Object.freeze({
      status: "stale",
      reason: "input_hash_changed",
    });
  }
  return Object.freeze({
    status: "reusable",
    result: previousResult,
  });
}

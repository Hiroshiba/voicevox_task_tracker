const NON_SCHEME_URL_LIKE_START_PATTERN =
  /(?<![A-Za-z0-9+.-])(?:mailto|javascript|data|urn|tel|blob|about):|(?<![:/])\/\/|(?<![A-Za-z0-9_.@/:%-])(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?=[/?#]|\b))/iu;
const URL_LIKE_START_PATTERN = new RegExp(
  `[A-Za-z][A-Za-z0-9+.-]*:\\/\\/|${NON_SCHEME_URL_LIKE_START_PATTERN.source}`,
  "giu",
);
const URL_LIKE_TEXT_PATTERN = new RegExp(
  `(?:${URL_LIKE_START_PATTERN.source})[^\\s<>"'\\x60]*`,
  "giu",
);
const SCHEME_FIRST_CHARACTER_PATTERN = /[A-Za-z]/iu;
const SCHEME_CHARACTER_PATTERN = /[A-Za-z0-9+.-]/iu;
const URL_LIKE_DELIMITER_PATTERN = /[\s<>"'`]/u;
const TRAILING_PUNCTUATION_CHARACTER_PATTERN = /[.,;:!?、。！？)\]}）］｝」』]/u;
const PERCENT_ENCODED_UTF8_CHARACTER_PATTERN = new RegExp(
  [
    "%[0-7][0-9a-f]",
    "%(?:c[2-9a-f]|d[0-9a-f])%[89ab][0-9a-f]",
    "%e0%[ab][0-9a-f]%[89ab][0-9a-f]",
    "%e[1-9a-cef](?:%[89ab][0-9a-f]){2}",
    "%ed%[89][0-9a-f]%[89ab][0-9a-f]",
    "%f0%[9ab][0-9a-f](?:%[89ab][0-9a-f]){2}",
    "%f[1-3](?:%[89ab][0-9a-f]){3}",
    "%f4%8[0-9a-f](?:%[89ab][0-9a-f]){2}",
  ].join("|"),
  "giu",
);

/** 理由要約にURL形式を含めないschema制約。 */
export const NO_URL_LIKE_TEXT_PATTERN = new RegExp(
  `^(?![\\s\\S]*${URL_LIKE_TEXT_PATTERN.source})[\\s\\S]*$`,
  "iu",
);

type UrlLikeTextScan =
  | Readonly<{ status: "valid"; candidates: readonly string[]; decodedTexts: readonly string[] }>
  | Readonly<{
      status: "invalid";
      reason:
        | "text_limit"
        | "invalid_encoding"
        | "candidate_characters_limit"
        | "candidate_count_limit"
        | "decode_depth_limit";
    }>;

function* urlLikeStartIndices(value: string): Generator<number> {
  const nonSchemeStart = new RegExp(NON_SCHEME_URL_LIKE_START_PATTERN.source, "iyu");
  let schemeEnd = 0;
  for (let index = 0; index < value.length;) {
    if (SCHEME_FIRST_CHARACTER_PATTERN.test(value.charAt(index))) {
      if (index >= schemeEnd) {
        schemeEnd = index + 1;
        while (schemeEnd < value.length && SCHEME_CHARACTER_PATTERN.test(value.charAt(schemeEnd))) {
          schemeEnd += 1;
        }
      }
      if (value.startsWith("://", schemeEnd)) {
        yield index;
        index = schemeEnd + 3;
        continue;
      }
    }
    nonSchemeStart.lastIndex = index;
    const match = nonSchemeStart.exec(value);
    if (match != null) {
      yield index;
      index = nonSchemeStart.lastIndex;
      continue;
    }
    index += 1;
  }
}

function* urlLikeCandidates(value: string): Generator<string> {
  let token:
    | Readonly<{ status: "unscanned" }>
    | Readonly<{ status: "scanned"; end: number; candidateEnd: number }> = { status: "unscanned" };
  for (const index of urlLikeStartIndices(value)) {
    if (token.status === "unscanned" || index >= token.end) {
      let end = index;
      while (end < value.length && !URL_LIKE_DELIMITER_PATTERN.test(value.charAt(end))) {
        end += 1;
      }
      let candidateEnd = end;
      while (
        candidateEnd > index &&
        TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(candidateEnd - 1))
      ) {
        candidateEnd -= 1;
      }
      token = { status: "scanned", end, candidateEnd };
    }
    yield value.slice(index, token.candidateEnd);
  }
}

/** URLの全開始位置と有界な復号段階を検査し、候補内の曖昧な符号化を拒否する。 */
export function scanUrlLikeText(value: string): UrlLikeTextScan {
  const candidates = new Set<string>();
  const decodedTexts: string[] = [];
  let current = value;
  let candidateCharacters = 0;
  for (let depth = 0; ; depth += 1) {
    if (current.length > 1_000_000)
      return Object.freeze({ status: "invalid", reason: "text_limit" });
    decodedTexts.push(current);
    for (const candidate of urlLikeCandidates(current)) {
      try {
        decodeURIComponent(candidate);
      } catch (error: unknown) {
        if (!(error instanceof URIError)) throw error;
        return Object.freeze({ status: "invalid", reason: "invalid_encoding" });
      }
      candidateCharacters += candidate.length;
      if (candidateCharacters > 1_000_000)
        return Object.freeze({ status: "invalid", reason: "candidate_characters_limit" });
      candidates.add(candidate);
      if (candidates.size > 4096)
        return Object.freeze({ status: "invalid", reason: "candidate_count_limit" });
    }
    const decoded = current.replaceAll(PERCENT_ENCODED_UTF8_CHARACTER_PATTERN, (encoded) =>
      decodeURIComponent(encoded),
    );
    if (decoded === current) {
      return Object.freeze({
        status: "valid",
        candidates: Object.freeze([...candidates]),
        decodedTexts: Object.freeze(decodedTexts),
      });
    }
    if (depth === 4) return Object.freeze({ status: "invalid", reason: "decode_depth_limit" });
    current = decoded;
  }
}

/** 自然文にURL形式の候補または解釈不能な符号化があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  const scan = scanUrlLikeText(value);
  return scan.status === "invalid" || scan.candidates.length > 0;
}

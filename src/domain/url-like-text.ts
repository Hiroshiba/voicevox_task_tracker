const URL_LIKE_START_PATTERN =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?<![A-Za-z0-9+.-])(?:mailto|javascript|data|urn|tel|blob|about):|(?<![:/])\/\/|(?<![A-Za-z0-9_.@/:%-])(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?=[/?#]|\b))/giu;
const URL_LIKE_TEXT_PATTERN = new RegExp(
  `(?:${URL_LIKE_START_PATTERN.source})[^\\s<>"'\\x60]*`,
  "giu",
);
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?、。！？)\]}）］｝」』]+$/u;

/** 理由要約にURL形式を含めないschema制約。 */
export const NO_URL_LIKE_TEXT_PATTERN = new RegExp(
  `^(?![\\s\\S]*${URL_LIKE_TEXT_PATTERN.source})[\\s\\S]*$`,
  "iu",
);

type UrlLikeTextScan =
  | Readonly<{ status: "valid"; candidates: readonly string[]; decodedTexts: readonly string[] }>
  | Readonly<{ status: "invalid" }>;

/** URLの全開始位置と有界な復号段階を検査し、曖昧な符号化を拒否する。 */
export function scanUrlLikeText(value: string): UrlLikeTextScan {
  const candidates = new Set<string>();
  const decodedTexts: string[] = [];
  let current = value;
  let candidateCharacters = 0;
  for (let depth = 0; ; depth += 1) {
    if (current.length > 1_000_000) return Object.freeze({ status: "invalid" });
    decodedTexts.push(current);
    for (const match of current.matchAll(URL_LIKE_START_PATTERN)) {
      const suffix = current.slice(match.index);
      const end = suffix.search(/[\s<>"'`]/u);
      const candidate = (end < 0 ? suffix : suffix.slice(0, end)).replace(
        TRAILING_PUNCTUATION_PATTERN,
        "",
      );
      if (/%(?![0-9A-Fa-f]{2})/u.test(candidate)) {
        return Object.freeze({ status: "invalid" });
      }
      candidateCharacters += candidate.length;
      if (candidateCharacters > 1_000_000) return Object.freeze({ status: "invalid" });
      candidates.add(candidate);
      if (candidates.size > 4096) return Object.freeze({ status: "invalid" });
    }
    if (!/%[0-9A-Fa-f]{2}/u.test(current)) {
      return Object.freeze({
        status: "valid",
        candidates: Object.freeze([...candidates]),
        decodedTexts: Object.freeze(decodedTexts),
      });
    }
    if (depth === 4) return Object.freeze({ status: "invalid" });
    try {
      current = current.replaceAll(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) =>
        decodeURIComponent(encoded),
      );
    } catch (error: unknown) {
      if (!(error instanceof URIError)) throw error;
      return Object.freeze({ status: "invalid" });
    }
    if (/%(?![0-9A-Fa-f]{2})/u.test(current)) {
      return Object.freeze({ status: "invalid" });
    }
  }
}

/** 自然文にURL形式の候補または解釈不能な符号化があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  const scan = scanUrlLikeText(value);
  return scan.status === "invalid" || scan.candidates.length > 0;
}

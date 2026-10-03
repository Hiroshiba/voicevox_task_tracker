const URL_LIKE_TEXT_PATTERN =
  /(?<![A-Za-z0-9_.@/-])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:mailto|javascript|data|urn|tel|blob|about):|\/\/|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?=[/?#]|\b))[^\s<>"'`]*/giu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?、。！？)\]}）］｝」』]+$/u;

/** 理由要約にURL形式を含めないschema制約。 */
export const NO_URL_LIKE_TEXT_PATTERN = new RegExp(
  `^(?![\\s\\S]*${URL_LIKE_TEXT_PATTERN.source})[\\s\\S]*$`,
  "iu",
);

/** 自然文にあるURL形式の候補を取り出す。 */
export function urlLikeTextCandidates(value: string): readonly string[] {
  return Object.freeze(
    [...value.matchAll(URL_LIKE_TEXT_PATTERN)]
      .map(([candidate]) => candidate.replace(TRAILING_PUNCTUATION_PATTERN, ""))
      .filter((candidate) => candidate.length > 0),
  );
}

/** 自然文にURL形式の候補があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  return urlLikeTextCandidates(value).length > 0;
}

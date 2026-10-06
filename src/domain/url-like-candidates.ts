import { assertNonNullable } from "../util/index.js";

const SCHEME_FIRST_CHARACTER_PATTERN = /[A-Za-z]/u;
const SCHEME_CHARACTER_PATTERN = /[A-Za-z0-9+.-]/u;
const NON_SLASH_SCHEME_NAME_PATTERN = /^(?:mailto|javascript|data|urn|tel|blob|about)$/iu;
const AUTHORITY_SEPARATOR_PATTERN = /[<>"'`/?#&=;:,()[\]{}、！？）］｝「」『』]/u;
const AUTHORITY_DOT_OR_ESCAPE_PATTERN = /[.．。｡%]/u;
const DOMAIN_SUFFIX_PATTERN = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const URL_LIKE_DELIMITER_PATTERN = /[<>"'`]/u;
const TRAILING_PUNCTUATION_CHARACTER_PATTERN = /[.,;:!?、。！？)\]}）］｝」』]/u;
const URL_INPUT_DELETED_PATTERN = /[\t\n\r]/u;
const URL_INPUT_DELETED_GLOBAL_PATTERN = /[\t\n\r]/gu;
const WHITESPACE_PATTERN = /\s/u;
const hostIgnoredWhitespace = new Map<string, boolean>();

export type UrlLikeCandidate = Readonly<{ value: string; start: number; end: number }>;
export type UrlInputProjection = Readonly<{
  value: string;
  sourceIndices: readonly number[] | undefined;
}>;

/** WHATWG URL入力で取り除かれるTAB、LF、CRを除いた文字列を返す。 */
export function urlInputText(value: string): string {
  return value.replaceAll(URL_INPUT_DELETED_GLOBAL_PATTERN, "");
}

/** URL入力の削除文字を除き、各文字の元位置を保持する。 */
export function urlInputProjection(
  value: string,
  isHardBoundary: (index: number) => boolean,
): UrlInputProjection {
  if (!URL_INPUT_DELETED_PATTERN.test(value)) return { value, sourceIndices: undefined };
  const characters: string[] = [];
  const sourceIndices: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (URL_INPUT_DELETED_PATTERN.test(character) && !isHardBoundary(index)) continue;
    characters.push(character);
    sourceIndices.push(index);
  }
  return { value: characters.join(""), sourceIndices };
}

function nextUrlInputIndex(
  value: string,
  start: number,
  isHardBoundary: (index: number) => boolean,
): number {
  let index = start;
  while (
    index < value.length &&
    URL_INPUT_DELETED_PATTERN.test(value.charAt(index)) &&
    !isHardBoundary(index)
  ) {
    index += 1;
  }
  return index;
}

function previousUrlInputIndex(
  value: string,
  start: number,
  isHardBoundary: (index: number) => boolean,
): number {
  let index = start;
  while (
    index >= 0 &&
    URL_INPUT_DELETED_PATTERN.test(value.charAt(index)) &&
    !isHardBoundary(index)
  ) {
    index -= 1;
  }
  return index;
}

function isHostIgnoredWhitespace(character: string): boolean {
  if (!WHITESPACE_PATTERN.test(character)) return false;
  const cached = hostIgnoredWhitespace.get(character);
  if (cached != null) return cached;
  const probe = `https://a${character}b.invalid`;
  const ignored = URL.canParse(probe) && new URL(probe).hostname === "ab.invalid";
  hostIgnoredWhitespace.set(character, ignored);
  return ignored;
}

function isTextWhitespaceBoundary(character: string): boolean {
  return WHITESPACE_PATTERN.test(character) && !isHostIgnoredWhitespace(character);
}

function isAuthoritySeparator(
  value: string,
  index: number,
  isHardBoundary: (index: number) => boolean,
): boolean {
  const character = value.charAt(index);
  return (
    isHardBoundary(index) ||
    AUTHORITY_SEPARATOR_PATTERN.test(character) ||
    isTextWhitespaceBoundary(character)
  );
}

function isCandidateDelimiter(
  value: string,
  index: number,
  isHardBoundary: (index: number) => boolean,
): boolean {
  const character = value.charAt(index);
  return (
    isHardBoundary(index) ||
    URL_LIKE_DELIMITER_PATTERN.test(character) ||
    isTextWhitespaceBoundary(character)
  );
}

function isBareUrlLikeAuthority(authority: string): boolean {
  if (!AUTHORITY_DOT_OR_ESCAPE_PATTERN.test(authority)) return false;
  let hostname = authority;
  let absoluteUrl = `https://${hostname}`;
  if (!URL.canParse(absoluteUrl)) {
    const percentIndex = hostname.indexOf("%");
    if (percentIndex < 0) return false;
    hostname = hostname.slice(0, percentIndex);
    absoluteUrl = `https://${hostname}`;
    if (!URL.canParse(absoluteUrl)) return false;
  }
  const labels = new URL(absoluteUrl).hostname.replace(/\.$/u, "").split(".");
  const suffix = labels.at(-1);
  return labels.length > 1 && suffix != null && DOMAIN_SUFFIX_PATTERN.test(suffix);
}

function* urlLikeStartIndices(
  value: string,
  isHardBoundary: (index: number) => boolean,
): Generator<number> {
  let authorityStart = 0;
  let schemeEnd = 0;
  let coveredSchemeRelativeStart: number | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (isAuthoritySeparator(value, index, isHardBoundary)) authorityStart = index + 1;
    let startsBareAuthority = false;
    if (index === authorityStart) {
      let authorityEnd = index;
      while (
        authorityEnd < value.length &&
        !isAuthoritySeparator(value, authorityEnd, isHardBoundary)
      ) {
        authorityEnd += 1;
      }
      const previous = previousUrlInputIndex(value, index - 1, isHardBoundary);
      const beforePrevious = previousUrlInputIndex(value, previous - 1, isHardBoundary);
      startsBareAuthority =
        !(value.charAt(previous) === "/" && value.charAt(beforePrevious) === "/") &&
        isBareUrlLikeAuthority(value.slice(index, authorityEnd));
    }
    let startsScheme = false;
    if (index >= schemeEnd && SCHEME_FIRST_CHARACTER_PATTERN.test(character)) {
      schemeEnd = index + 1;
      while (schemeEnd < value.length) {
        if (URL_INPUT_DELETED_PATTERN.test(value.charAt(schemeEnd)) && !isHardBoundary(schemeEnd)) {
          schemeEnd += 1;
          continue;
        }
        if (!SCHEME_CHARACTER_PATTERN.test(value.charAt(schemeEnd))) break;
        schemeEnd += 1;
      }
      const colon = value.charAt(schemeEnd) === ":";
      const firstSlash = nextUrlInputIndex(value, schemeEnd + 1, isHardBoundary);
      const secondSlash = nextUrlInputIndex(value, firstSlash + 1, isHardBoundary);
      const startsSlashScheme =
        colon && value.charAt(firstSlash) === "/" && value.charAt(secondSlash) === "/";
      if (startsSlashScheme) coveredSchemeRelativeStart = firstSlash;
      startsScheme =
        startsSlashScheme ||
        (colon && NON_SLASH_SCHEME_NAME_PATTERN.test(urlInputText(value.slice(index, schemeEnd))));
    }
    let startsSchemeRelative = false;
    if (character === "/") {
      const secondSlash = nextUrlInputIndex(value, index + 1, isHardBoundary);
      const previous = previousUrlInputIndex(value, index - 1, isHardBoundary);
      startsSchemeRelative =
        value.charAt(secondSlash) === "/" &&
        index !== coveredSchemeRelativeStart &&
        value.charAt(previous) !== "/";
    }
    if (startsBareAuthority || startsScheme || startsSchemeRelative) yield index;
  }
}

/** URL形式の開始位置からMarkdown境界内の候補を列挙する。 */
export function* urlLikeCandidates(
  value: string,
  offsets: readonly number[],
  literalUrl: boolean,
  isHardBoundary: (index: number) => boolean,
): Generator<UrlLikeCandidate> {
  let boundaryIndex = 0;
  let token:
    | Readonly<{ status: "unscanned" }>
    | Readonly<{ status: "scanned"; end: number; candidateEnd: number }> = { status: "unscanned" };
  for (const index of urlLikeStartIndices(value, isHardBoundary)) {
    if (token.status === "unscanned" || index >= token.end) {
      let end = index;
      while (
        end < value.length &&
        (literalUrl || !isCandidateDelimiter(value, end, isHardBoundary))
      ) {
        end += 1;
      }
      let candidateEnd = end;
      while (
        candidateEnd > index &&
        !literalUrl &&
        TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(candidateEnd - 1))
      ) {
        candidateEnd -= 1;
      }
      token = { status: "scanned", end, candidateEnd };
    }
    for (; boundaryIndex < offsets.length; boundaryIndex += 1) {
      const boundary = offsets[boundaryIndex];
      assertNonNullable(boundary, "Markdown境界の位置を取得できません");
      if (boundary > index) break;
    }
    const boundary = offsets[boundaryIndex];
    const crossesBoundary = boundary != null && boundary < token.candidateEnd;
    let end = crossesBoundary ? boundary : token.candidateEnd;
    while (
      end > index &&
      !literalUrl &&
      TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(end - 1))
    ) {
      end -= 1;
    }
    yield { value: value.slice(index, end), start: index, end };
  }
}

/** 正規化済みのhostがGitHubか判定する。 */
export function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname === "github.com.";
}

/** URL候補のauthorityがGitHubか、解析不能でもGitHubになり得るか判定する。 */
export function mayHaveGitHubAuthority(candidate: string): boolean {
  const parsedInput = urlInputText(candidate);
  let absoluteUrl = parsedInput;
  if (parsedInput.startsWith("//")) absoluteUrl = `https:${parsedInput}`;
  else if (!URL_SCHEME_PATTERN.test(parsedInput)) absoluteUrl = `https://${parsedInput}`;
  if (URL.canParse(absoluteUrl)) {
    return isGitHubHost(new URL(absoluteUrl).hostname);
  }
  const source = parsedInput.replace(URL_SCHEME_PATTERN, "").replace(/^\/\//u, "");
  const [authority] = source.split(/[/?#]/u);
  const rawHostname = authority?.split("@").at(-1)?.split(":")[0];
  if (rawHostname == null) return false;
  const invalidPercent = /%(?![0-9a-f]{2})/iu.exec(rawHostname);
  const hostname =
    invalidPercent == null ? rawHostname : rawHostname.slice(0, invalidPercent.index);
  const possibleUrl = `https://${hostname}`;
  if (URL.canParse(possibleUrl)) {
    return isGitHubHost(new URL(possibleUrl).hostname);
  }
  const percentIndex = hostname.indexOf("%");
  if (percentIndex < 0) return false;
  const prefixUrl = `https://${hostname.slice(0, percentIndex)}`;
  if (!URL.canParse(prefixUrl)) return false;
  return isGitHubHost(new URL(prefixUrl).hostname);
}

import type { Nodes } from "mdast";
import { type CompileContext, fromMarkdown, type Token } from "mdast-util-from-markdown";

import { assertNonNullable } from "../util/index.js";

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
const PERCENT_ENCODED_BYTE_SEQUENCE_PATTERN = /(?:%[0-9a-f]{2})+/giu;
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
      reason: "invalid_encoding";
      failure: Readonly<{ candidate: string; originalCandidate: string; decodeDepth: number }>;
    }>
  | Readonly<{
      status: "invalid";
      reason:
        | "text_limit"
        | "candidate_characters_limit"
        | "candidate_count_limit"
        | "decode_depth_limit"
        | "markdown_boundary";
    }>;

type TextSpan = Readonly<{ start: number; end: number }>;
type MarkdownReferenceNode = Extract<
  Nodes,
  { type: "link" | "image" | "linkReference" | "imageReference" }
>;
type UrlLikeCandidate = Readonly<{
  value: string;
  start: number;
  end: number;
  ambiguousMarkdownBoundary: boolean;
}>;
type DecodedTextIndex = Readonly<{
  characters: readonly Readonly<{
    start: number;
    end: number;
    encodedEnd: number;
    lengthDifference: number;
  }>[];
  lengthDifference: number;
}>;

function markdownBoundaries(value: string): Readonly<{
  offsets: readonly number[];
  linkStarts: ReadonlySet<number>;
  ambiguousLabelEnds: ReadonlySet<number>;
}> {
  const offsets = new Set<number>();
  const linkStarts = new Set<number>();
  const ambiguousLabelEnds = new Set<number>();
  const labels: Readonly<{ node: MarkdownReferenceNode; end: number }>[] = [];
  if (!value.includes("[")) return { offsets: [], linkStarts, ambiguousLabelEnds };
  function tokenBoundaries(token: Token): void {
    offsets.add(token.start.offset);
    offsets.add(token.end.offset);
  }
  function bufferBoundaries(this: CompileContext, token: Token): void {
    tokenBoundaries(token);
    this.buffer();
  }
  function labelBoundaries(this: CompileContext, token: Token): void {
    tokenBoundaries(token);
    const node = this.stack.at(-2);
    assertNonNullable(node, "Markdownラベルのnodeを取得できません");
    if (node.type !== "link" && node.type !== "image") {
      throw new TypeError("Markdownラベルのnode種別を解釈できません");
    }
    labels.push({ node, end: token.end.offset });
  }
  function nodeBoundaries(
    node: MarkdownReferenceNode | Extract<Nodes, { type: "definition" }>,
  ): TextSpan {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    assertNonNullable(start, "Markdown境界の開始位置を取得できません");
    assertNonNullable(end, "Markdown境界の終了位置を取得できません");
    offsets.add(start);
    offsets.add(end);
    if (node.type === "link" || node.type === "linkReference") linkStarts.add(start);
    return { start, end };
  }
  const pending: Nodes[] = [
    fromMarkdown(value, {
      mdastExtensions: [
        {
          enter: {
            labelText: labelBoundaries,
            resourceDestinationString: bufferBoundaries,
            resourceTitleString: bufferBoundaries,
            definitionDestinationString: bufferBoundaries,
            definitionLabelString: bufferBoundaries,
            definitionTitleString: bufferBoundaries,
          },
        },
      ],
    }),
  ];
  while (pending.length > 0) {
    const node = pending.pop();
    assertNonNullable(node, "Markdown境界のnodeを取得できません");
    if (
      node.type === "link" ||
      node.type === "image" ||
      node.type === "linkReference" ||
      node.type === "imageReference" ||
      node.type === "definition"
    ) {
      nodeBoundaries(node);
    }
    if ("children" in node) pending.push(...node.children);
  }
  for (const label of labels) {
    const span = nodeBoundaries(label.node);
    if (label.node.type !== "link" && label.node.type !== "linkReference") continue;
    let tail = span.end;
    while (tail < value.length && TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(tail))) {
      tail += 1;
    }
    if (tail < value.length && !URL_LIKE_DELIMITER_PATTERN.test(value.charAt(tail))) {
      ambiguousLabelEnds.add(label.end);
    }
  }
  return {
    offsets: [...offsets].sort((left, right) => left - right),
    linkStarts,
    ambiguousLabelEnds,
  };
}

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

function* urlLikeCandidates(value: string): Generator<UrlLikeCandidate> {
  const markdown = markdownBoundaries(value);
  let boundaryIndex = 0;
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
    for (; boundaryIndex < markdown.offsets.length; boundaryIndex += 1) {
      const boundary = markdown.offsets[boundaryIndex];
      assertNonNullable(boundary, "Markdown境界の位置を取得できません");
      if (boundary > index) break;
    }
    const boundary = markdown.offsets[boundaryIndex];
    const crossesBoundary = boundary != null && boundary < token.candidateEnd;
    let end = crossesBoundary ? boundary : token.candidateEnd;
    while (end > index && TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(end - 1))) {
      end -= 1;
    }
    const candidate = value.slice(index, end);
    yield {
      value: candidate,
      start: index,
      end,
      ambiguousMarkdownBoundary:
        crossesBoundary &&
        (markdown.linkStarts.has(boundary) || markdown.ambiguousLabelEnds.has(boundary)),
    };
  }
}

function originalTextIndex(
  mapping: DecodedTextIndex,
  index: number,
  edge: "start" | "end",
): number {
  let left = 0;
  let right = mapping.characters.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const character = mapping.characters[middle];
    assertNonNullable(character, "復号位置の対応を取得できません");
    if (index >= character.end) left = middle + 1;
    else right = middle;
  }
  const character = mapping.characters[left];
  if (character == null) return index + mapping.lengthDifference;
  if (index <= character.start) return index + character.lengthDifference;
  return edge === "start" ? character.start + character.lengthDifference : character.encodedEnd;
}

function originalUrlLikeCandidate(
  value: string,
  mappings: readonly DecodedTextIndex[],
  candidate: UrlLikeCandidate,
): string {
  let { start, end } = candidate;
  for (const mapping of mappings.toReversed()) {
    start = originalTextIndex(mapping, start, "start");
    end = originalTextIndex(mapping, end, "end");
  }
  return value.slice(start, end);
}

/** URLの全開始位置と有界な復号段階を検査し、候補内の曖昧な符号化を拒否する。 */
export function scanUrlLikeText(value: string): UrlLikeTextScan {
  const candidates = new Set<string>();
  const decodedTexts: string[] = [];
  const mappings: DecodedTextIndex[] = [];
  let current = value;
  let candidateCharacters = 0;
  for (let depth = 0; ; depth += 1) {
    if (current.length > 1_000_000)
      return Object.freeze({ status: "invalid", reason: "text_limit" });
    decodedTexts.push(current);
    for (const candidate of urlLikeCandidates(current)) {
      candidateCharacters += candidate.value.length;
      if (candidateCharacters > 1_000_000)
        return Object.freeze({ status: "invalid", reason: "candidate_characters_limit" });
      const originalCandidate = originalUrlLikeCandidate(value, mappings, candidate);
      try {
        decodeURIComponent(originalCandidate);
        if (depth > 0) {
          for (const match of candidate.value.matchAll(PERCENT_ENCODED_BYTE_SEQUENCE_PATTERN)) {
            decodeURIComponent(match[0]);
          }
        }
      } catch (error: unknown) {
        if (!(error instanceof URIError)) throw error;
        return Object.freeze({
          status: "invalid",
          reason: "invalid_encoding",
          failure: Object.freeze({
            candidate: candidate.value,
            originalCandidate,
            decodeDepth: depth,
          }),
        });
      }
      if (candidate.ambiguousMarkdownBoundary)
        return Object.freeze({ status: "invalid", reason: "markdown_boundary" });
      candidates.add(candidate.value);
      if (candidates.size > 4096)
        return Object.freeze({ status: "invalid", reason: "candidate_count_limit" });
    }
    const characters: DecodedTextIndex["characters"][number][] = [];
    let lengthDifference = 0;
    const decoded = current.replaceAll(
      PERCENT_ENCODED_UTF8_CHARACTER_PATTERN,
      (encoded: string, encodedStart: number) => {
        const character = decodeURIComponent(encoded);
        const start = encodedStart - lengthDifference;
        characters.push({
          start,
          end: start + character.length,
          encodedEnd: encodedStart + encoded.length,
          lengthDifference,
        });
        lengthDifference += encoded.length - character.length;
        return character;
      },
    );
    if (decoded === current) {
      return Object.freeze({
        status: "valid",
        candidates: Object.freeze([...candidates]),
        decodedTexts: Object.freeze(decodedTexts),
      });
    }
    if (depth === 4) return Object.freeze({ status: "invalid", reason: "decode_depth_limit" });
    mappings.push({ characters, lengthDifference });
    current = decoded;
  }
}

/** 自然文にURL形式の候補または解釈不能な符号化があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  const scan = scanUrlLikeText(value);
  return scan.status === "invalid" || scan.candidates.length > 0;
}

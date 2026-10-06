import type { Nodes } from "mdast";
import { type CompileContext, fromMarkdown, type Token } from "mdast-util-from-markdown";

import { assertNonNullable } from "../util/index.js";

const NON_SCHEME_URL_LIKE_START_PATTERN =
  /(?<![A-Za-z0-9+.-])(?:mailto|javascript|data|urn|tel|blob|about):|(?<![:/])\/\/|(?<![\p{L}\p{N}_.．。｡@/:%-])(?:[\p{L}\p{N}-]+(?:[.．。｡][\p{L}\p{N}-]+)*[.．。｡][\p{L}]{2,}(?![\p{L}\p{N}_]))/iu;
const URL_LIKE_START_PATTERN = new RegExp(
  `[A-Za-z][A-Za-z0-9+.-]*:\\/\\/|${NON_SCHEME_URL_LIKE_START_PATTERN.source}`,
  "giu",
);
const URL_LIKE_TEXT_PATTERN = new RegExp(
  `(?:${URL_LIKE_START_PATTERN.source})[^\\s<>"'\\x60]*`,
  "giu",
);
const SCHEME_FIRST_CHARACTER_PATTERN = /[A-Za-z]/u;
const SCHEME_CHARACTER_PATTERN = /[A-Za-z0-9+.-]/u;
const NON_SLASH_SCHEME_NAME_PATTERN = /^(?:mailto|javascript|data|urn|tel|blob|about)$/iu;
const AUTHORITY_SEPARATOR_PATTERN = /[\s<>"'`/?#&=;:,()[\]{}、！？）］｝「」『』]/u;
const AUTHORITY_DOT_OR_ESCAPE_PATTERN = /[.．。｡%]/u;
const DOMAIN_SUFFIX_PATTERN = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
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
}>;
type TextOrigin =
  | Readonly<{ kind: "copy"; original: TextSpan }>
  | Readonly<{
      kind: "replacement";
      original: readonly TextSpan[];
      literalPercent: boolean;
    }>;
type SourceTextSegment = TextSpan & TextOrigin;
type MappedText = Readonly<{ value: string; segments: readonly SourceTextSegment[] }>;
interface TextBuilder {
  chunks: string[];
  segments: SourceTextSegment[];
  length: number;
}
type MappedTextView = Readonly<{ text: MappedText; context: "markdown" | "url" | "text" }>;
type TextView = MappedTextView & Readonly<{ decodeDepth: number }>;
type MarkdownValueNode = Extract<Nodes, { type: "link" | "image" | "definition" }>;
type MarkdownField =
  | Readonly<{ node: MarkdownValueNode; field: "url" | "title"; span: TextSpan }>
  | Readonly<{ node: Extract<Nodes, { type: "definition" }>; field: "label"; span: TextSpan }>;
type TextTransformation =
  Readonly<{ status: "unchanged" }> | Readonly<{ status: "changed"; text: MappedText }>;
type MarkdownLayout =
  | Readonly<{ status: "invalid" }>
  | Readonly<{
      status: "valid";
      offsets: readonly number[];
      display: TextTransformation;
      fields: readonly MappedTextView[];
    }>;

function nodeTextSpan(node: Nodes): TextSpan {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  assertNonNullable(start, "Markdown境界の開始位置を取得できません");
  assertNonNullable(end, "Markdown境界の終了位置を取得できません");
  return { start, end };
}

function textBuilder(): TextBuilder {
  return { chunks: [], segments: [], length: 0 };
}

function mappedText(builder: TextBuilder): MappedText {
  return { value: builder.chunks.join(""), segments: builder.segments };
}

function appendSourceText(builder: TextBuilder, value: string, origin: TextOrigin): void {
  if (value.length === 0) return;
  if (origin.kind === "copy" && value.length !== origin.original.end - origin.original.start) {
    throw new TypeError("原文位置と文字数が一致しません");
  }
  if (origin.kind === "replacement" && origin.literalPercent && value !== "%") {
    throw new TypeError("percent復号の由来と文字が一致しません");
  }
  const start = builder.length;
  builder.chunks.push(value);
  builder.length += value.length;
  const previous = builder.segments.at(-1);
  if (
    origin.kind === "copy" &&
    previous?.kind === "copy" &&
    previous.original.end === origin.original.start
  ) {
    builder.segments[builder.segments.length - 1] = {
      ...previous,
      end: builder.length,
      original: { start: previous.original.start, end: origin.original.end },
    };
    return;
  }
  builder.segments.push({ ...origin, start, end: builder.length });
}

function firstSourceSegment(text: MappedText, start: number): number {
  let left = 0;
  let right = text.segments.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const segment = text.segments[middle];
    assertNonNullable(segment, "原文位置の対応を取得できません");
    if (start >= segment.end) left = middle + 1;
    else right = middle;
  }
  return left;
}

function slicedOrigin(segment: SourceTextSegment, start: number, end: number): TextOrigin {
  return segment.kind === "copy"
    ? {
        kind: "copy",
        original: {
          start: segment.original.start + start - segment.start,
          end: segment.original.start + end - segment.start,
        },
      }
    : { kind: "replacement", original: segment.original, literalPercent: segment.literalPercent };
}

function appendTextSlice(builder: TextBuilder, text: MappedText, span: TextSpan): void {
  let covered = span.start;
  for (let index = firstSourceSegment(text, span.start); index < text.segments.length; index += 1) {
    const segment = text.segments[index];
    assertNonNullable(segment, "原文位置の対応を取得できません");
    if (segment.start >= span.end) break;
    const start = Math.max(span.start, segment.start);
    const end = Math.min(span.end, segment.end);
    appendSourceText(builder, text.value.slice(start, end), slicedOrigin(segment, start, end));
    covered = end;
  }
  if (covered !== span.end) throw new TypeError("原文位置の対応に欠落があります");
}

function originalTextSpans(text: MappedText, span: TextSpan): readonly TextSpan[] {
  const originals: TextSpan[] = [];
  for (let index = firstSourceSegment(text, span.start); index < text.segments.length; index += 1) {
    const segment = text.segments[index];
    assertNonNullable(segment, "原文位置の対応を取得できません");
    if (segment.start >= span.end) break;
    const origin = slicedOrigin(
      segment,
      Math.max(span.start, segment.start),
      Math.min(span.end, segment.end),
    );
    for (const original of origin.kind === "copy" ? [origin.original] : origin.original) {
      const previous = originals.at(-1);
      if (previous != null && original.start <= previous.end) {
        if (original.start < previous.start) throw new TypeError("原文位置の順序が一致しません");
        originals[originals.length - 1] = {
          start: previous.start,
          end: Math.max(previous.end, original.end),
        };
      } else {
        originals.push(original);
      }
    }
  }
  return originals;
}

function isDecodedLiteralPercent(text: MappedText, index: number): boolean {
  const segment = text.segments[firstSourceSegment(text, index)];
  assertNonNullable(segment, "percentの原文位置を取得できません");
  return segment.kind === "replacement" && segment.literalPercent;
}

function textWithoutMarkdownPrefixes(
  text: MappedText,
  span: TextSpan,
  prefixes: readonly TextSpan[],
): MappedText {
  const builder = textBuilder();
  let left = 0;
  let right = prefixes.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const prefix = prefixes[middle];
    assertNonNullable(prefix, "Markdown prefixの位置を取得できません");
    if (prefix.end <= span.start) left = middle + 1;
    else right = middle;
  }
  let start = span.start;
  for (let index = left; index < prefixes.length; index += 1) {
    const prefix = prefixes[index];
    assertNonNullable(prefix, "Markdown prefixの位置を取得できません");
    if (prefix.start >= span.end) break;
    appendTextSlice(builder, text, { start, end: Math.max(start, prefix.start) });
    start = Math.min(span.end, prefix.end);
  }
  appendTextSlice(builder, text, { start, end: span.end });
  return mappedText(builder);
}

function appendRenderedText(
  builder: TextBuilder,
  text: MappedText,
  span: TextSpan,
  expected: string,
): boolean {
  const raw = text.value.slice(span.start, span.end);
  if (raw === expected) {
    appendTextSlice(builder, text, span);
    return true;
  }
  const chunkStart = builder.chunks.length;
  let start = span.start;
  const replacements =
    /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][0-9a-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/giu;
  for (const match of raw.matchAll(replacements)) {
    const replacementStart = span.start + match.index;
    const replacementEnd = replacementStart + match[0].length;
    appendTextSlice(builder, text, { start, end: replacementStart });
    if (match[0].startsWith("\\")) {
      appendTextSlice(builder, text, { start: replacementStart + 1, end: replacementEnd });
      start = replacementEnd;
      continue;
    }
    const paragraph = fromMarkdown(match[0]).children[0];
    assertNonNullable(paragraph, "文字参照の表示値を取得できません");
    if (paragraph.type !== "paragraph" || paragraph.children.length !== 1) {
      throw new TypeError("文字参照の表示値を解釈できません");
    }
    const child = paragraph.children[0];
    assertNonNullable(child, "文字参照の表示値を取得できません");
    if (child.type !== "text") throw new TypeError("文字参照の表示値を解釈できません");
    appendSourceText(builder, child.value, {
      kind: "replacement",
      original: originalTextSpans(text, { start: replacementStart, end: replacementEnd }),
      literalPercent: false,
    });
    start = replacementEnd;
  }
  appendTextSlice(builder, text, { start, end: span.end });
  return builder.chunks.slice(chunkStart).join("") === expected;
}

function appendInlineCode(
  builder: TextBuilder,
  source: MappedText,
  node: Extract<Nodes, { type: "inlineCode" }>,
  prefixes: readonly TextSpan[],
): boolean {
  const text = textWithoutMarkdownPrefixes(source, nodeTextSpan(node), prefixes);
  const span = { start: 0, end: text.value.length };
  const raw = text.value;
  const fence = /^`+/u.exec(raw)?.[0];
  if (fence == null || !raw.endsWith(fence)) return false;
  const inner = { start: span.start + fence.length, end: span.end - fence.length };
  const content = textBuilder();
  appendTextSlice(content, text, inner);
  const code = mappedText(content);
  const trim = code.value.startsWith(" ") && code.value.endsWith(" ") && /[^ ]/u.test(code.value);
  const displayed = { start: trim ? 1 : 0, end: code.value.length - Number(trim) };
  if (code.value.slice(displayed.start, displayed.end) !== node.value) return false;
  appendTextSlice(builder, code, displayed);
  return true;
}

function appendHtmlBoundary(
  builder: TextBuilder,
  text: MappedText,
  node: Extract<Nodes, { type: "html" }>,
  boundaries: TextSpan[],
  displayStart: number,
): void {
  const start = builder.length - displayStart;
  appendTextSlice(builder, text, nodeTextSpan(node));
  const previous = boundaries.at(-1);
  const end = builder.length - displayStart;
  if (previous?.end === start) {
    boundaries[boundaries.length - 1] = { start: previous.start, end };
  } else {
    boundaries.push({ start, end });
  }
}

function isReferenceFragment(character: string): boolean {
  return (
    /[A-Za-z0-9_.:/%+-]/u.test(character.normalize("NFKC")) ||
    /[\p{Mark}\p{Format}]/u.test(character)
  );
}

function appendInlineDisplayText(
  builder: TextBuilder,
  text: MappedText,
  nodes: readonly Nodes[],
  labels: ReadonlyMap<MarkdownReferenceNode, readonly Nodes[]>,
  prefixes: readonly TextSpan[],
  mode: "text" | "link" | "alt",
): boolean {
  type Entry =
    | Readonly<{ kind: "node"; node: Nodes; mode: "text" | "link" | "alt" }>
    | Readonly<{ kind: "verify"; chunkStart: number; expected: string }>;
  const pending: Entry[] = nodes.toReversed().map((node) => ({ kind: "node", node, mode }));
  const htmlTags: string[] = [];
  const htmlBoundaries: TextSpan[] = [];
  const chunkStart = builder.chunks.length;
  const displayStart = builder.length;
  while (pending.length > 0) {
    const entry = pending.pop();
    assertNonNullable(entry, "Markdownラベルのnodeを取得できません");
    if (entry.kind === "verify") {
      if (builder.chunks.slice(entry.chunkStart).join("") !== entry.expected) return false;
      continue;
    }
    const node = entry.node;
    if (node.type === "text") {
      const literal = textWithoutMarkdownPrefixes(text, nodeTextSpan(node), prefixes);
      if (
        !appendRenderedText(builder, literal, { start: 0, end: literal.value.length }, node.value)
      )
        return false;
    } else if (node.type === "inlineCode") {
      if (!appendInlineCode(builder, text, node, prefixes)) return false;
    } else if (node.type === "break") {
      appendSourceText(builder, "\n", {
        kind: "replacement",
        original: originalTextSpans(text, nodeTextSpan(node)),
        literalPercent: false,
      });
    } else if (node.type === "image" || node.type === "imageReference") {
      if (entry.mode === "text") {
        appendSourceText(builder, " ", {
          kind: "replacement",
          original: originalTextSpans(text, nodeTextSpan(node)),
          literalPercent: false,
        });
        continue;
      }
      const children = labels.get(node);
      if (children == null) return false;
      assertNonNullable(node.alt, "Markdown画像のaltを取得できません");
      pending.push({ kind: "verify", chunkStart: builder.chunks.length, expected: node.alt });
      pending.push(
        ...children
          .toReversed()
          .map((child): Entry => ({ kind: "node", node: child, mode: "alt" })),
      );
    } else if (node.type === "html") {
      if (entry.mode === "alt") {
        appendTextSlice(builder, text, nodeTextSpan(node));
        continue;
      }
      if (/^<(?:br\s*\/?|\/?p)>$/iu.test(node.value)) {
        appendSourceText(builder, "\n", {
          kind: "replacement",
          original: originalTextSpans(text, nodeTextSpan(node)),
          literalPercent: false,
        });
        continue;
      }
      const tag = /^<(\/?)(code|kbd|samp|span|strong|em|b|i|s|del|sub|sup|mark)>$/iu.exec(
        node.value,
      );
      if (tag == null) {
        if (entry.mode === "link") return false;
        appendHtmlBoundary(builder, text, node, htmlBoundaries, displayStart);
        continue;
      }
      const name = tag[2];
      assertNonNullable(name, "MarkdownラベルのHTML tagを取得できません");
      if (tag[1] === "/") {
        if (htmlTags.at(-1) !== name.toLowerCase()) {
          if (entry.mode === "link") return false;
          appendHtmlBoundary(builder, text, node, htmlBoundaries, displayStart);
          continue;
        }
        htmlTags.pop();
      } else {
        htmlTags.push(name.toLowerCase());
      }
    } else if ("children" in node) {
      const childMode =
        entry.mode !== "alt" && (node.type === "link" || node.type === "linkReference")
          ? "link"
          : entry.mode;
      pending.push(
        ...node.children
          .toReversed()
          .map((child): Entry => ({ kind: "node", node: child, mode: childMode })),
      );
    } else {
      return false;
    }
  }
  const display = builder.chunks.slice(chunkStart).join("");
  if (
    htmlBoundaries.some(
      (span) =>
        isReferenceFragment(display.charAt(span.start - 1)) &&
        isReferenceFragment(display.charAt(span.end)),
    )
  )
    return false;
  return htmlTags.length === 0;
}

function markdownLayout(text: MappedText): MarkdownLayout {
  const value = text.value;
  const offsets = new Set<number>();
  const labels = new Map<MarkdownReferenceNode, readonly Nodes[]>();
  const sourceFields: MarkdownField[] = [];
  const sourcePrefixes: TextSpan[] = [];
  if (
    !value.includes("[") &&
    !value.includes("<") &&
    !value.includes("&") &&
    !value.includes("\\") &&
    !value.includes("*") &&
    !value.includes("_") &&
    !value.includes("`")
  ) {
    return { status: "valid", offsets: [], display: { status: "unchanged" }, fields: [] };
  }
  function tokenBoundaries(token: Token): void {
    offsets.add(token.start.offset);
    offsets.add(token.end.offset);
  }
  function prefixSpan(token: Token): void {
    sourcePrefixes.push({ start: token.start.offset, end: token.end.offset });
  }
  function bufferBoundaries(this: CompileContext, token: Token): void {
    tokenBoundaries(token);
    const node = this.stack.at(-1);
    assertNonNullable(node, "Markdown fieldのnodeを取得できません");
    if (node.type !== "link" && node.type !== "image" && node.type !== "definition") {
      throw new TypeError("Markdown fieldのnode種別を解釈できません");
    }
    const span = { start: token.start.offset, end: token.end.offset };
    if (token.type === "definitionLabelString") {
      if (node.type !== "definition") throw new TypeError("Markdown definitionを取得できません");
      sourceFields.push({ node, field: "label", span });
    } else if (
      token.type === "resourceDestinationString" ||
      token.type === "definitionDestinationString"
    ) {
      sourceFields.push({ node, field: "url", span });
    } else if (token.type === "resourceTitleString" || token.type === "definitionTitleString") {
      sourceFields.push({ node, field: "title", span });
    } else {
      throw new TypeError("Markdown fieldのtoken種別を解釈できません");
    }
    this.buffer();
  }
  function labelBoundaries(this: CompileContext, token: Token): void {
    tokenBoundaries(token);
    const node = this.stack.at(-2);
    assertNonNullable(node, "Markdownラベルのnodeを取得できません");
    if (node.type !== "link" && node.type !== "image") {
      throw new TypeError("Markdownラベルのnode種別を解釈できません");
    }
    const fragment = this.stack.at(-1);
    assertNonNullable(fragment, "Markdownラベルのfragmentを取得できません");
    if (!("children" in fragment)) throw new TypeError("Markdownラベルのfragmentを解釈できません");
    labels.set(node, fragment.children);
  }
  const displayedNodes: Extract<Nodes, { type: "paragraph" | "heading" }>[] = [];
  const images: Extract<MarkdownReferenceNode, { type: "image" | "imageReference" }>[] = [];
  const pending: Nodes[] = [
    fromMarkdown(value, {
      mdastExtensions: [
        {
          enter: {
            linePrefix: prefixSpan,
            lineSuffix: prefixSpan,
            blockQuotePrefix: prefixSpan,
            listItemPrefix: prefixSpan,
            listItemIndent: prefixSpan,
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
      const span = nodeTextSpan(node);
      offsets.add(span.start);
      offsets.add(span.end);
    }
    if (node.type === "paragraph" || node.type === "heading") {
      displayedNodes.push(node);
    }
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if ("children" in node) pending.push(...node.children);
  }
  const prefixes: TextSpan[] = [];
  for (const prefix of sourcePrefixes.sort((left, right) => left.start - right.start)) {
    const previous = prefixes.at(-1);
    if (previous != null && prefix.start <= previous.end) {
      prefixes[prefixes.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, prefix.end),
      };
    } else {
      prefixes.push(prefix);
    }
  }
  const labelNodes: Nodes[] = [
    ...[...labels.values()].flat(),
    ...displayedNodes.flatMap((node) => node.children),
  ];
  while (labelNodes.length > 0) {
    const node = labelNodes.pop();
    assertNonNullable(node, "Markdownラベルの境界を取得できません");
    const span = nodeTextSpan(node);
    offsets.add(span.start);
    offsets.add(span.end);
    if ("children" in node) labelNodes.push(...node.children);
  }
  const fields: MappedTextView[] = [];
  for (const field of sourceFields) {
    const expected = field.field === "label" ? field.node.label : field.node[field.field];
    assertNonNullable(expected, "Markdown fieldの表示値を取得できません");
    const builder = textBuilder();
    const literal = textWithoutMarkdownPrefixes(text, field.span, prefixes);
    if (!appendRenderedText(builder, literal, { start: 0, end: literal.value.length }, expected))
      return { status: "invalid" };
    fields.push({ text: mappedText(builder), context: field.field === "url" ? "url" : "text" });
  }
  for (const image of images) {
    const children = labels.get(image);
    if (children == null) return { status: "invalid" };
    const builder = textBuilder();
    if (!appendInlineDisplayText(builder, text, children, labels, prefixes, "alt"))
      return { status: "invalid" };
    const alt = mappedText(builder);
    if (alt.value !== image.alt) return { status: "invalid" };
    fields.push({ text: alt, context: "text" });
  }
  const boundaries = [...offsets].sort((left, right) => left - right);
  if (displayedNodes.length === 0)
    return { status: "valid", offsets: boundaries, display: { status: "unchanged" }, fields };
  const display = textBuilder();
  let start = 0;
  for (const node of displayedNodes.sort(
    (left, right) => nodeTextSpan(left).start - nodeTextSpan(right).start,
  )) {
    const span = nodeTextSpan(node);
    if (span.start < start) {
      if (span.end <= start) continue;
      return { status: "invalid" };
    }
    appendTextSlice(display, text, { start, end: span.start });
    if (!appendInlineDisplayText(display, text, node.children, labels, prefixes, "text"))
      return { status: "invalid" };
    start = span.end;
  }
  appendTextSlice(display, text, { start, end: value.length });
  const result = mappedText(display);
  if (result.value === value)
    return { status: "valid", offsets: boundaries, display: { status: "unchanged" }, fields };
  return {
    status: "valid",
    offsets: boundaries,
    display: { status: "changed", text: result },
    fields,
  };
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

function* urlLikeStartIndices(value: string): Generator<number> {
  let authorityStart = 0;
  let schemeEnd = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (AUTHORITY_SEPARATOR_PATTERN.test(character)) authorityStart = index + 1;
    let startsBareAuthority = false;
    if (index === authorityStart) {
      let authorityEnd = index;
      while (
        authorityEnd < value.length &&
        !AUTHORITY_SEPARATOR_PATTERN.test(value.charAt(authorityEnd))
      ) {
        authorityEnd += 1;
      }
      startsBareAuthority =
        !value.slice(Math.max(0, index - 2), index).endsWith("//") &&
        isBareUrlLikeAuthority(value.slice(index, authorityEnd));
    }
    let startsScheme = false;
    if (index >= schemeEnd && SCHEME_FIRST_CHARACTER_PATTERN.test(character)) {
      schemeEnd = index + 1;
      while (schemeEnd < value.length && SCHEME_CHARACTER_PATTERN.test(value.charAt(schemeEnd))) {
        schemeEnd += 1;
      }
      startsScheme =
        value.startsWith("://", schemeEnd) ||
        (value.charAt(schemeEnd) === ":" &&
          NON_SLASH_SCHEME_NAME_PATTERN.test(value.slice(index, schemeEnd)));
    }
    const startsSchemeRelative =
      character === "/" &&
      value.startsWith("//", index) &&
      value.charAt(index - 1) !== ":" &&
      value.charAt(index - 1) !== "/";
    if (startsBareAuthority || startsScheme || startsSchemeRelative) yield index;
  }
}

function* urlLikeCandidates(
  value: string,
  offsets: readonly number[],
  literalUrl: boolean,
): Generator<UrlLikeCandidate> {
  let boundaryIndex = 0;
  let token:
    | Readonly<{ status: "unscanned" }>
    | Readonly<{ status: "scanned"; end: number; candidateEnd: number }> = { status: "unscanned" };
  for (const index of urlLikeStartIndices(value)) {
    if (token.status === "unscanned" || index >= token.end) {
      let end = index;
      while (
        end < value.length &&
        (literalUrl || !URL_LIKE_DELIMITER_PATTERN.test(value.charAt(end)))
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
    const candidate = value.slice(index, end);
    yield { value: candidate, start: index, end };
  }
}

/** 正規化済みのhostがGitHubか判定する。 */
export function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname === "github.com.";
}

/** URL候補のauthorityがGitHubか、解析不能でもGitHubになり得るか判定する。 */
export function mayHaveGitHubAuthority(candidate: string): boolean {
  let absoluteUrl = candidate;
  if (candidate.startsWith("//")) absoluteUrl = `https:${candidate}`;
  else if (!URL_SCHEME_PATTERN.test(candidate)) absoluteUrl = `https://${candidate}`;
  if (URL.canParse(absoluteUrl)) {
    return isGitHubHost(new URL(absoluteUrl).hostname);
  }
  const source = candidate.replace(URL_SCHEME_PATTERN, "").replace(/^\/\//u, "");
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

function percentDecodedText(text: MappedText): TextTransformation {
  const builder = textBuilder();
  let start = 0;
  for (const match of text.value.matchAll(PERCENT_ENCODED_UTF8_CHARACTER_PATTERN)) {
    const end = match.index + match[0].length;
    appendTextSlice(builder, text, { start, end: match.index });
    const character = decodeURIComponent(match[0]);
    appendSourceText(builder, character, {
      kind: "replacement",
      original: originalTextSpans(text, { start: match.index, end }),
      literalPercent: character === "%",
    });
    start = end;
  }
  if (start === 0) return { status: "unchanged" };
  appendTextSlice(builder, text, { start, end: text.value.length });
  return { status: "changed", text: mappedText(builder) };
}

function sameSourceSegments(
  left: readonly SourceTextSegment[],
  right: readonly SourceTextSegment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    assertNonNullable(other, "原文位置の照合対象を取得できません");
    if (segment.start !== other.start || segment.end !== other.end) return false;
    if (segment.kind === "copy" && other.kind === "copy") {
      return (
        segment.original.start === other.original.start &&
        segment.original.end === other.original.end
      );
    }
    if (segment.kind !== "replacement" || other.kind !== "replacement") return false;
    return (
      segment.literalPercent === other.literalPercent &&
      segment.original.length === other.original.length &&
      segment.original.every((span, originalIndex) => {
        const otherSpan = other.original[originalIndex];
        assertNonNullable(otherSpan, "原文位置の照合対象を取得できません");
        return span.start === otherSpan.start && span.end === otherSpan.end;
      })
    );
  });
}

/** URLの全開始位置と有界な復号段階を検査し、GitHub候補の曖昧な符号化を拒否する。 */
export function scanUrlLikeText(value: string): UrlLikeTextScan {
  const candidates = new Set<string>();
  const decodedTexts = new Set<string>();
  const pending: TextView[] = [];
  const seen = new Map<string, Map<string, readonly (readonly SourceTextSegment[])[]>>();
  let textCharacters = 0;
  let candidateCharacters = 0;
  function enqueue(view: TextView): boolean {
    const key = `${view.context}:${String(view.decodeDepth)}`;
    const texts = seen.get(key) ?? new Map<string, readonly (readonly SourceTextSegment[])[]>();
    const origins = texts.get(view.text.value) ?? [];
    if (origins.some((segments) => sameSourceSegments(segments, view.text.segments))) return true;
    textCharacters += view.text.value.length;
    if (textCharacters > 1_000_000) return false;
    texts.set(view.text.value, [...origins, view.text.segments]);
    seen.set(key, texts);
    pending.push(view);
    return true;
  }
  const source = textBuilder();
  appendSourceText(source, value, { kind: "copy", original: { start: 0, end: value.length } });
  if (!enqueue({ text: mappedText(source), context: "markdown", decodeDepth: 0 }))
    return Object.freeze({ status: "invalid", reason: "text_limit" });
  for (const view of pending) {
    const layout: MarkdownLayout =
      view.context === "markdown"
        ? markdownLayout(view.text)
        : { status: "valid", offsets: [], display: { status: "unchanged" }, fields: [] };
    if (layout.status === "invalid")
      return Object.freeze({ status: "invalid", reason: "markdown_boundary" });
    decodedTexts.add(view.text.value);
    for (const candidate of urlLikeCandidates(
      view.text.value,
      layout.offsets,
      view.context === "url",
    )) {
      candidateCharacters += candidate.value.length;
      if (candidateCharacters > 1_000_000)
        return Object.freeze({ status: "invalid", reason: "candidate_characters_limit" });
      if (mayHaveGitHubAuthority(candidate.value)) {
        const originals = originalTextSpans(view.text, candidate).map((span) =>
          value.slice(span.start, span.end),
        );
        for (const original of originals) {
          try {
            decodeURIComponent(original);
          } catch (error: unknown) {
            if (!(error instanceof URIError)) throw error;
            return Object.freeze({
              status: "invalid",
              reason: "invalid_encoding",
              failure: Object.freeze({
                candidate: candidate.value,
                originalCandidate: original,
                decodeDepth: view.decodeDepth,
              }),
            });
          }
        }
        const originalCandidate = originals.join("");
        for (const match of candidate.value.matchAll(/%(?![0-9a-f]{2})/giu)) {
          if (!isDecodedLiteralPercent(view.text, candidate.start + match.index)) {
            return Object.freeze({
              status: "invalid",
              reason: "invalid_encoding",
              failure: Object.freeze({
                candidate: candidate.value,
                originalCandidate,
                decodeDepth: view.decodeDepth,
              }),
            });
          }
        }
        try {
          for (const match of candidate.value.matchAll(PERCENT_ENCODED_BYTE_SEQUENCE_PATTERN))
            decodeURIComponent(match[0]);
        } catch (error: unknown) {
          if (!(error instanceof URIError)) throw error;
          return Object.freeze({
            status: "invalid",
            reason: "invalid_encoding",
            failure: Object.freeze({
              candidate: candidate.value,
              originalCandidate,
              decodeDepth: view.decodeDepth,
            }),
          });
        }
      }
      candidates.add(candidate.value);
      if (candidates.size > 4096)
        return Object.freeze({ status: "invalid", reason: "candidate_count_limit" });
    }
    const decoded = percentDecodedText(view.text);
    if (decoded.status === "changed") {
      if (view.decodeDepth === 4)
        return Object.freeze({ status: "invalid", reason: "decode_depth_limit" });
      if (
        !enqueue({ text: decoded.text, context: view.context, decodeDepth: view.decodeDepth + 1 })
      )
        return Object.freeze({ status: "invalid", reason: "text_limit" });
    }
    if (
      layout.display.status === "changed" &&
      !enqueue({ text: layout.display.text, context: "text", decodeDepth: view.decodeDepth })
    )
      return Object.freeze({ status: "invalid", reason: "text_limit" });
    for (const field of layout.fields) {
      if (!enqueue({ ...field, decodeDepth: view.decodeDepth }))
        return Object.freeze({ status: "invalid", reason: "text_limit" });
    }
  }
  return Object.freeze({
    status: "valid",
    candidates: Object.freeze([...candidates]),
    decodedTexts: Object.freeze([...decodedTexts]),
  });
}

/** 自然文にURL形式の候補または解釈不能な符号化があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  const scan = scanUrlLikeText(value);
  return scan.status === "invalid" || scan.candidates.length > 0;
}

import { fromMarkdown } from "mdast-util-from-markdown";

import { assertNonNullable } from "../util/index.js";

/** 原文位置を保持して復号するHTML文字参照のpattern。 */
export const HTML_CHARACTER_REFERENCE_PATTERN =
  /&(?:#[xX][0-9a-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/giu;

type HtmlAnchorTag =
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "close" }>
  | Readonly<{
      kind: "open";
      attributes: readonly Readonly<{
        name: string;
        span: Readonly<{ start: number; end: number }>;
        value: string;
      }>[];
    }>;

/** HTML文字参照をMarkdownのparserと同じ規則で復号する。 */
export function decodeHtmlCharacterReference(value: string): string {
  const paragraph = fromMarkdown(value).children[0];
  assertNonNullable(paragraph, "文字参照の表示値を取得できません");
  if (paragraph.type !== "paragraph" || paragraph.children.length !== 1) {
    throw new TypeError("文字参照の表示値を解釈できません");
  }
  const child = paragraph.children[0];
  assertNonNullable(child, "文字参照の表示値を取得できません");
  if (child.type !== "text") throw new TypeError("文字参照の表示値を解釈できません");
  return child.value;
}

function decodedHtmlAttribute(
  value: string,
): Readonly<{ status: "valid"; value: string }> | Readonly<{ status: "invalid" }> {
  const completeReference = /^&(?:#[xX][0-9a-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});$/iu;
  for (const match of value.matchAll(/&(?:#[^&;\t\r\n "'<>]*;?|[A-Za-z][A-Za-z0-9]*;?)/gu)) {
    const reference = match[0];
    if (reference.startsWith("&#")) {
      if (!completeReference.test(reference)) return { status: "invalid" };
    } else if (
      !reference.endsWith(";") &&
      !/[A-Za-z0-9=]/u.test(value.charAt(match.index + reference.length)) &&
      decodeHtmlCharacterReference(`${reference};`) !== `${reference};`
    ) {
      return { status: "invalid" };
    }
  }
  return {
    status: "valid",
    value: value.replaceAll(HTML_CHARACTER_REFERENCE_PATTERN, decodeHtmlCharacterReference),
  };
}

function decodedAnchorAttributes(
  attributes: Extract<HtmlAnchorTag, { kind: "open" }>["attributes"],
): Extract<HtmlAnchorTag, { kind: "open" | "invalid" }> {
  const interpreted: Extract<HtmlAnchorTag, { kind: "open" }>["attributes"][number][] = [];
  for (const attribute of attributes) {
    const decoded = decodedHtmlAttribute(attribute.value);
    if (decoded.status === "invalid") return { kind: "invalid" };
    interpreted.push({ ...attribute, value: decoded.value });
  }
  return { kind: "open", attributes: interpreted };
}

/** 完全なHTML anchor tagから属性値と原文範囲を取得する。 */
export function htmlAnchorTag(value: string): HtmlAnchorTag {
  if (/^<\/a[ \t\r\n]*>$/iu.test(value)) return { kind: "close" };
  if (!/^<a(?=[ \t\r\n/>])/iu.test(value)) return { kind: "other" };
  const spacing = /[ \t\r\n]+/uy;
  const attribute =
    /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)'|([^ \t\r\n"'=<>`]+)))?/duy;
  const attributes: Extract<HtmlAnchorTag, { kind: "open" }>["attributes"][number][] = [];
  let index = 2;
  while (index < value.length) {
    spacing.lastIndex = index;
    const space = spacing.exec(value);
    if (space != null) index = spacing.lastIndex;
    if (
      (value.charAt(index) === ">" && index + 1 === value.length) ||
      (value.charAt(index) === "/" && value.charAt(index + 1) === ">" && index + 2 === value.length)
    ) {
      return decodedAnchorAttributes(attributes);
    }
    if (space == null) return { kind: "other" };
    attribute.lastIndex = index;
    const matched = attribute.exec(value);
    if (matched == null) return { kind: "other" };
    const name = matched[1];
    assertNonNullable(name, "HTML属性名を取得できません");
    const span = matched.indices?.[2] ?? matched.indices?.[3] ?? matched.indices?.[4];
    if (span != null) {
      attributes.push({
        name: name.toLowerCase(),
        span: { start: span[0], end: span[1] },
        value: value.slice(span[0], span[1]),
      });
    }
    index = attribute.lastIndex;
  }
  return { kind: "other" };
}

/** 表示textのHTML境界として扱うtagの種別を取得する。 */
export function htmlDisplayTag(
  value: string,
):
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "anchor" }>
  | Readonly<{ kind: "break" }>
  | Readonly<{ kind: "decoration"; name: string; closing: boolean }> {
  const anchor = htmlAnchorTag(value);
  if (anchor.kind !== "other") return { kind: anchor.kind === "invalid" ? "invalid" : "anchor" };
  if (/^<(?:br\s*\/?|\/?p)>$/iu.test(value)) return { kind: "break" };
  const tag = /^<(\/?)(code|kbd|samp|span|strong|em|b|i|s|del|sub|sup|mark)>$/iu.exec(value);
  if (tag == null) return { kind: "other" };
  const name = tag[2];
  assertNonNullable(name, "MarkdownラベルのHTML tagを取得できません");
  return { kind: "decoration", name: name.toLowerCase(), closing: tag[1] === "/" };
}

/** 連続するHTMLの表示範囲を一つの境界へまとめる。 */
export function appendHtmlBoundarySpan(
  boundaries: Readonly<{ start: number; end: number }>[],
  start: number,
  end: number,
): void {
  const previous = boundaries.at(-1);
  if (previous?.end === start) {
    boundaries[boundaries.length - 1] = { start: previous.start, end };
  } else {
    boundaries.push({ start, end });
  }
}

/** HTMLの前後で参照断片を連結し得る文字か判定する。 */
export function isHtmlReferenceFragment(character: string): boolean {
  return (
    /[A-Za-z0-9_.:/%+-]/u.test(character.normalize("NFKC")) ||
    /[\p{Mark}\p{Format}]/u.test(character)
  );
}

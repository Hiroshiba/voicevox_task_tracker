import { z } from "zod";

const SOURCE_ID_KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;

const sourceIdSchema = z.string().min(3).brand<"SourceId">();

/** 種別とURI component化した元IDをコロンで結ぶ安定したsource ID。 */
export type SourceId = z.output<typeof sourceIdSchema>;

/** source IDを構成する種別と元ID。 */
export type SourceIdParts = Readonly<{
  kind: string;
  originalId: string;
}>;

function validateKind(kind: string): void {
  if (!SOURCE_ID_KIND_PATTERN.test(kind)) {
    throw new TypeError(
      "source IDの種別は小文字英数字、ハイフン、アンダースコアで指定してください",
    );
  }
}

function encodeOriginalId(originalId: string): string {
  return encodeURIComponent(originalId).replaceAll("%3A", ":");
}

/** 種別と元IDから決定論的なsource IDを組み立てる。 */
export function buildSourceId(kind: string, originalId: string): SourceId {
  validateKind(kind);
  if (originalId.length === 0) {
    throw new TypeError("source IDの元IDは空にできません");
  }

  return sourceIdSchema.parse(`${kind}:${encodeOriginalId(originalId)}`);
}

/** source IDを種別と元IDへ分解し、非正規表現を拒否する。 */
export function parseSourceId(sourceId: string): SourceIdParts {
  const separatorIndex = sourceId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === sourceId.length - 1) {
    throw new TypeError("source IDは種別と元IDをコロンで区切ってください");
  }

  const kind = sourceId.slice(0, separatorIndex);
  validateKind(kind);

  const encodedOriginalId = sourceId.slice(separatorIndex + 1);
  let originalId: string;
  try {
    originalId = decodeURIComponent(encodedOriginalId);
  } catch (error: unknown) {
    throw new TypeError("source IDの元IDを復号できません", { cause: error });
  }

  const canonicalSourceId = buildSourceId(kind, originalId);
  if (canonicalSourceId !== sourceId) {
    throw new TypeError("source IDが正規形式ではありません");
  }

  return {
    kind,
    originalId,
  };
}

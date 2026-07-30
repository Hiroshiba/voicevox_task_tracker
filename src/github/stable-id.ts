/** 安定IDが同じ値を最後に観測した1件へ畳み込む。 */
export function deduplicateByStableId<Value>(
  values: readonly Value[],
  getStableId: (value: Value) => string,
): readonly Value[] {
  const valuesByStableId = new Map<string, Value>();

  for (const value of values) {
    const stableId = getStableId(value);
    if (!/^\S+$/u.test(stableId)) {
      throw new TypeError("安定IDには空白を含まない空でない文字列を指定してください");
    }
    valuesByStableId.set(stableId, value);
  }

  return Object.freeze([...valuesByStableId.values()]);
}

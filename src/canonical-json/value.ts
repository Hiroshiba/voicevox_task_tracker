function serializeString(value: string): string {
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("JSONの数値は有限値にしてください");
  }
  return JSON.stringify(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function serializeValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value == null) {
    if (typeof value === "undefined") {
      throw new TypeError("JSONへ直列化できない値です。型: undefined");
    }
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("循環参照を含む値はJSONへ直列化できません");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => serializeValue(item, ancestors)).join(",")}]`;
        }

        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype != null) {
          throw new TypeError("JSONへ直列化できるのはplain objectだけです");
        }
        const properties = Object.entries(value)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(
            ([key, propertyValue]) =>
              `${serializeString(key)}:${serializeValue(propertyValue, ancestors)}`,
          );
        return `{${properties.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`JSONへ直列化できない値です。型: ${typeof value}`);
  }
  throw new TypeError("JSONへ直列化できない値です");
}

/** JSON値をobjectのキー順に依存しない文字列へ正規化する。 */
export function serializeCanonicalJson(value: unknown): string {
  return serializeValue(value, new WeakSet<object>());
}

/** JSON値を末尾改行付きcanonical JSONへ直列化する。 */
export function serializeCanonicalJsonLine(value: unknown): string {
  return `${serializeCanonicalJson(value)}\n`;
}

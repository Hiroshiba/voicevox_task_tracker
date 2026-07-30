/** 値がnullまたはundefinedでないことを表明する。 */
export function assertNonNullable<T>(value: T, message: string): asserts value is NonNullable<T> {
  if (value == null) {
    throw new TypeError(message);
  }
}

import { goldenEvalOutputSchema, type StandardGoldenOutput } from "./golden-schema.js";

const MINIMUM_CRITICAL_URGENT_RECALL = 0.95;
const MAXIMUM_FALSE_NOTIFICATION_RATE = 0.1;

/** fixture名と期待値および実測値の組。 */
export type GoldenEvaluationPair = Readonly<{
  name: string;
  expected: unknown;
  actual: unknown;
}>;

/** critical・urgent再現率と誤通知率の回帰判定。 */
export type GoldenRegressionSummary = Readonly<{
  status: "passed" | "failed";
  criticalUrgentRecall: Readonly<{
    truePositiveCount: number;
    expectedPositiveCount: number;
    value: number;
    minimum: typeof MINIMUM_CRITICAL_URGENT_RECALL;
    passed: boolean;
  }>;
  falseNotificationRate: Readonly<{
    falsePositiveCount: number;
    predictedPositiveCount: number;
    value: number;
    maximum: typeof MAXIMUM_FALSE_NOTIFICATION_RATE;
    passed: boolean;
  }>;
}>;

type ParsedPair = Readonly<{
  name: string;
  expected: StandardGoldenOutput;
  actual: StandardGoldenOutput | undefined;
}>;

function parseStandardPairs(pairs: readonly GoldenEvaluationPair[]): readonly ParsedPair[] {
  const expectedOutputs = pairs.map((pair) => goldenEvalOutputSchema.safeParse(pair.expected));
  const structuredCount = expectedOutputs.filter((result) => result.success).length;
  if (structuredCount === 0) {
    return Object.freeze([]);
  }
  if (structuredCount !== pairs.length) {
    throw new TypeError("golden evalの期待結果形式が混在しています");
  }

  const parsed: ParsedPair[] = [];
  for (const [index, pair] of pairs.entries()) {
    const expectedResult = expectedOutputs[index];
    if (!expectedResult?.success) {
      throw new TypeError("golden evalの期待結果を取得できません");
    }
    if (expectedResult.data.kind === "large") {
      continue;
    }
    const actualResult = goldenEvalOutputSchema.safeParse(pair.actual);
    parsed.push(
      Object.freeze({
        name: pair.name,
        expected: expectedResult.data,
        actual:
          actualResult.success && actualResult.data.kind === "standard"
            ? actualResult.data
            : undefined,
      }),
    );
  }
  return Object.freeze(parsed);
}

function isCriticalOrUrgent(severity: StandardGoldenOutput["items"][number]["severity"]): boolean {
  return severity === "critical" || severity === "urgent";
}

function itemKey(fixtureName: string, nodeId: string): string {
  return JSON.stringify([fixtureName, nodeId]);
}

function notificationKey(fixtureName: string, itemNodeId: string, reasonCode: string): string {
  return JSON.stringify([fixtureName, itemNodeId, reasonCode]);
}

function listNotificationKeys(
  fixtureName: string,
  output: StandardGoldenOutput,
): readonly string[] {
  return Object.freeze(
    output.notifications.flatMap((notification) =>
      notification.reasonCodes.map((reasonCode) =>
        notificationKey(fixtureName, notification.itemNodeId, reasonCode),
      ),
    ),
  );
}

/** 構造化golden結果から回帰基準を集計する。 */
export function evaluateGoldenRegression(
  pairs: readonly GoldenEvaluationPair[],
): GoldenRegressionSummary | undefined {
  const parsedPairs = parseStandardPairs(pairs);
  if (parsedPairs.length === 0) {
    return undefined;
  }

  const expectedPositiveKeys = new Set<string>();
  const actualPositiveKeys = new Set<string>();
  const expectedNotificationKeys = new Set<string>();
  const actualNotificationKeys = new Set<string>();
  for (const pair of parsedPairs) {
    for (const item of pair.expected.items) {
      if (isCriticalOrUrgent(item.severity)) {
        expectedPositiveKeys.add(itemKey(pair.name, item.nodeId));
      }
    }
    for (const notification of listNotificationKeys(pair.name, pair.expected)) {
      expectedNotificationKeys.add(notification);
    }
    if (pair.actual == null) {
      continue;
    }
    for (const item of pair.actual.items) {
      if (isCriticalOrUrgent(item.severity)) {
        actualPositiveKeys.add(itemKey(pair.name, item.nodeId));
      }
    }
    for (const notification of listNotificationKeys(pair.name, pair.actual)) {
      actualNotificationKeys.add(notification);
    }
  }

  if (expectedPositiveKeys.size === 0) {
    throw new TypeError("criticalまたはurgentの期待項目がgolden fixtureにありません");
  }
  const truePositiveCount = [...expectedPositiveKeys].filter((key) =>
    actualPositiveKeys.has(key),
  ).length;
  const recall = truePositiveCount / expectedPositiveKeys.size;
  const falsePositiveCount = [...actualNotificationKeys].filter(
    (key) => !expectedNotificationKeys.has(key),
  ).length;
  const falseNotificationRate =
    actualNotificationKeys.size === 0 ? 0 : falsePositiveCount / actualNotificationKeys.size;
  const recallPassed = recall >= MINIMUM_CRITICAL_URGENT_RECALL;
  const falseNotificationRatePassed = falseNotificationRate <= MAXIMUM_FALSE_NOTIFICATION_RATE;

  return Object.freeze({
    status: recallPassed && falseNotificationRatePassed ? "passed" : "failed",
    criticalUrgentRecall: Object.freeze({
      truePositiveCount,
      expectedPositiveCount: expectedPositiveKeys.size,
      value: recall,
      minimum: MINIMUM_CRITICAL_URGENT_RECALL,
      passed: recallPassed,
    }),
    falseNotificationRate: Object.freeze({
      falsePositiveCount,
      predictedPositiveCount: actualNotificationKeys.size,
      value: falseNotificationRate,
      maximum: MAXIMUM_FALSE_NOTIFICATION_RATE,
      passed: falseNotificationRatePassed,
    }),
  });
}

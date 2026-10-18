import { SANDBOX_FIXED_SOURCE_DATASET } from "./dataset.js";
import type { SandboxFixedSource } from "./source.js";

/** 固定sourceの開始時刻と評価後の各段階時刻を返す。 */
export function createSandboxFixedSourceRunClock(source: SandboxFixedSource): Readonly<{
  startedAt: () => Date;
  now: () => Date;
}> {
  const times = SANDBOX_FIXED_SOURCE_DATASET.clock[source.descriptor.runSlot];
  return Object.freeze({
    startedAt: () => new Date(times.startedAt),
    now: () => new Date(times.evaluatedAt),
  });
}

import { type Severity } from "./types.js";

type SeverityRank = 0 | 1 | 2 | 3;

function getSeverityRank(severity: Severity): SeverityRank {
  switch (severity) {
    case "none":
      return 0;
    case "watch":
      return 1;
    case "urgent":
      return 2;
    case "critical":
      return 3;
  }
}

/** severityをnone、watch、urgent、criticalの順で比較する。 */
export function compareSeverity(left: Severity, right: Severity): -1 | 0 | 1 {
  const difference = getSeverityRank(left) - getSeverityRank(right);
  if (difference < 0) {
    return -1;
  }
  if (difference > 0) {
    return 1;
  }
  return 0;
}

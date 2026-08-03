import { formatDateTime, formatRelativeTime } from "./model.js";

type TimeDisplayProps = Readonly<{
  label: string;
  locale: string;
  now: Date;
  timezone: string;
  value: string;
}>;

/** 絶対時刻と相対時刻を並べて表示する。 */
export function TimeDisplay({ label, locale, now, timezone, value }: TimeDisplayProps) {
  return (
    <span class="time-display">
      <span class="time-label">{label}</span>
      <time dateTime={value}>{formatDateTime(value, timezone, locale)}</time>
      <span class="relative-time">{formatRelativeTime(value, now, locale)}</span>
    </span>
  );
}

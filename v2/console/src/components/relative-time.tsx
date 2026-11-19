import { Hint } from "@/components/hint";
import { formatDateTime, formatRelative } from "@/lib/format";

/**
 * A moment as how long ago or how soon it is, e.g. `3 days ago` or `in 1 hour`,
 * with the exact date and time a hover away.
 */
export function RelativeTime({ value }: { value: string }) {
  return (
    <Hint content={formatDateTime(value)}>
      <time dateTime={value}>{formatRelative(value)}</time>
    </Hint>
  );
}

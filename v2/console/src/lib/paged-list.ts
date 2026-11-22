/**
 * One list's filters, the days it reads and its pages, held as one state.
 *
 * A page cursor belongs to the exact query it was read under. So every change
 * of a filter, or of the days, starts the pages again in the same update: a
 * cursor can never outlive its query, whatever changes and in what order
 *. Each cursor also carries the exact days it was
 * read for. When the days move on their own, at UTC midnight, a cursor read
 * for other days is never sent: the render shows page one (round 4), and an
 * "Older" click carrying a cursor read for yesterday's days goes to page one
 * of today's instead (round 5). Every paged list in the console holds its
 * state here, so this kind of bug cannot come back list by list.
 */
import { useMemo, useState } from "react";
import { windowAt, type DateWindow } from "@/components/date-window";

interface State<F> {
  filters: F;
  /** The date window, 0 for the newest days. */
  step: number;
  /** The `before` cursors of the pages read so far, each with the days it was read for; the last is the page shown. */
  cursors: Page[];
}

/** A `before` cursor and the days of the read that returned it. */
interface Page {
  cursor: string;
  from: string;
  to: string;
}

const sameDays = (page: Page, range: DateWindow) => page.from === range.from && page.to === range.to;

export interface PagedList<F> {
  filters: F;
  range: DateWindow;
  /** The `before` cursor for the page shown, if it is not the first. */
  before: string | undefined;
  canNewer: boolean;
  /** Changes some filters; a change starts again at the newest days and page one. Unchanged values change nothing. */
  setFilters: (patch: Partial<F>) => void;
  earlier: () => void;
  later: () => void;
  /** Goes to the page before `next`, a cursor read for the days `readFor` (the range shown with it). */
  older: (next: string, readFor: DateWindow) => void;
  newer: () => void;
}

export function usePagedList<F extends Record<string, unknown>>(initial: F): PagedList<F> {
  const [state, setState] = useState<State<F>>({ filters: initial, step: 0, cursors: [] });
  // Built once: they only ever call `setState`, so effects may depend on them safely.
  const actions = useMemo(
    () => ({
      setFilters: (patch: Partial<F>) =>
        setState((current) => {
          const changed = Object.entries(patch).some(([key, value]) => current.filters[key] !== value);
          return changed ? { filters: { ...current.filters, ...patch }, step: 0, cursors: [] } : current;
        }),
      earlier: () => setState((current) => (windowAt(current.step).canEarlier ? { ...current, step: current.step + 1, cursors: [] } : current)),
      later: () => setState((current) => (current.step > 0 ? { ...current, step: current.step - 1, cursors: [] } : current)),
      older: (next: string, readFor: DateWindow) =>
        setState((current) => {
          const days = windowAt(current.step);
          const page = { cursor: next, from: readFor.from, to: readFor.to };
          // A cursor read for other days than today's window (the click came after
          // UTC midnight) is dropped: page one of the current days, never a skip.
          if (!sameDays(page, days)) return { ...current, cursors: [] };
          const kept = current.cursors.filter((earlier) => sameDays(earlier, days));
          return { ...current, cursors: [...kept, page] };
        }),
      newer: () => setState((current) => ({ ...current, cursors: current.cursors.slice(0, -1) })),
    }),
    [],
  );
  const range = windowAt(state.step);
  // Cursors belong to the days they were read for: once the days move, at UTC
  // midnight, they are not sent again, in this very render.
  const cursors = state.cursors.every((page) => sameDays(page, range)) ? state.cursors : [];
  return {
    filters: state.filters,
    range,
    before: cursors.at(-1)?.cursor,
    canNewer: cursors.length > 0,
    ...actions,
  };
}

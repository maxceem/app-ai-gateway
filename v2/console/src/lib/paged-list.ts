/**
 * One list's filters, the days it reads and its pages, held as one state.
 *
 * A page cursor belongs to the exact query it was read under. So every change
 * of a filter, or of the days, starts the pages again in the same update: a
 * cursor can never outlive its query, whatever changes and in what order
 * (Sol 7b-6 rounds 2 and 3). The cursors also remember the exact days they
 * were read for: when the days move on their own, at UTC midnight, the same
 * render starts at page one again (Sol 7b-6 round 4). Every paged list in the
 * console holds its state here, so this kind of bug cannot come back list by list.
 */
import { useMemo, useState } from "react";
import { windowAt, type DateWindow } from "@/components/date-window";

interface State<F> {
  filters: F;
  /** The date window, 0 for the newest days. */
  step: number;
  /** The `before` cursors of the pages read so far; the last is the page shown. */
  cursors: string[];
  /** The days the cursors were read for, as `from..to`. */
  cursorsFor: string;
}

const daysOf = (range: DateWindow) => `${range.from}..${range.to}`;

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
  older: (next: string) => void;
  newer: () => void;
}

export function usePagedList<F extends Record<string, unknown>>(initial: F): PagedList<F> {
  const [state, setState] = useState<State<F>>({ filters: initial, step: 0, cursors: [], cursorsFor: "" });
  // Built once: they only ever call `setState`, so effects may depend on them safely.
  const actions = useMemo(
    () => ({
      setFilters: (patch: Partial<F>) =>
        setState((current) => {
          const changed = Object.entries(patch).some(([key, value]) => current.filters[key] !== value);
          return changed ? { filters: { ...current.filters, ...patch }, step: 0, cursors: [], cursorsFor: "" } : current;
        }),
      earlier: () => setState((current) => (windowAt(current.step).canEarlier ? { ...current, step: current.step + 1, cursors: [] } : current)),
      later: () => setState((current) => (current.step > 0 ? { ...current, step: current.step - 1, cursors: [] } : current)),
      older: (next: string) =>
        setState((current) => {
          const days = daysOf(windowAt(current.step));
          // Cursors read for other days (the window moved at midnight) are dropped, never mixed.
          const kept = current.cursorsFor === days ? current.cursors : [];
          return { ...current, cursors: [...kept, next], cursorsFor: days };
        }),
      newer: () => setState((current) => ({ ...current, cursors: current.cursors.slice(0, -1) })),
    }),
    [],
  );
  const range = windowAt(state.step);
  // Cursors belong to the days they were read for: once the days move, at UTC
  // midnight, they are not sent again, in this very render.
  const cursors = state.cursorsFor === daysOf(range) ? state.cursors : [];
  return {
    filters: state.filters,
    range,
    before: cursors.at(-1),
    canNewer: cursors.length > 0,
    ...actions,
  };
}

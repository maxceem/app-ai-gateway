import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { isLeavingForAccountSwitch } from "@/lib/tab-account";

/**
 * The guards holding unsaved changes now, each by the way it asks the person.
 * Something about to leave the page without a route change, such as an
 * account switch, asks here first (`confirmLeaving`).
 */
const dirtyGuards = new Set<() => Promise<boolean>>();

/**
 * Asks the person, in the page, whether to leave unsaved changes behind: true
 * when there are none or they confirm, false when they stay. Ask before doing
 * anything that cannot be taken back, such as starting an account switch.
 */
export function confirmLeaving(): Promise<boolean> {
  const ask = dirtyGuards.values().next().value;
  return ask === undefined ? Promise.resolve(true) : ask();
}

/**
 * Stops a person walking away from unsaved changes without noticing (v1's
 * `useLeaveGuard`). Three ways out of a page: a move inside the console,
 * which the router holds while the page asks; an account switch, which asks
 * through `confirmLeaving` before it starts; and closing or reloading the tab,
 * where the browser asks in its own words. Moving to another tab of the same
 * app counts too: each tab keeps its own draft, and leaving it drops it.
 *
 * `dirty` is read through a ref, so a page that saves and moves on in the
 * same breath is never stopped by the value of an earlier render.
 */
export function LeaveGuard({ dirty, releaseRef }: { dirty: boolean; releaseRef?: { current: (() => void) | null } }) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Set by a page about to leave on purpose, such as after deleting what it edits: the next move goes unasked.
  const released = useRef(false);
  if (releaseRef) releaseRef.current = () => {
    released.current = true;
  };
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (released.current) {
      released.current = false;
      return false;
    }
    return dirtyRef.current && currentLocation.pathname !== nextLocation.pathname;
  });

  // A question asked through `confirmLeaving`, waiting for the person's answer.
  const [asking, setAsking] = useState<((leave: boolean) => void) | null>(null);
  const ask = useRef(() => new Promise<boolean>((resolve) => setAsking(() => resolve)));
  useEffect(() => {
    if (!dirty) return;
    const mine = ask.current;
    dirtyGuards.add(mine);
    return () => {
      dirtyGuards.delete(mine);
    };
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      // An account switch the person already confirmed reloads without asking again.
      if (isLeavingForAccountSwitch()) return;
      event.preventDefault();
      // Older browsers ask only when this is set; the text itself is ignored.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const answer = (leave: boolean) => {
    if (asking !== null) {
      asking(leave);
      setAsking(null);
    } else if (blocker.state === "blocked") {
      if (leave) blocker.proceed();
      else blocker.reset();
    }
  };

  return (
    <ConfirmDialog
      open={blocker.state === "blocked" || asking !== null}
      onOpenChange={(open) => {
        if (!open) answer(false);
      }}
      title="Leave without saving?"
      description={<p>Your changes on this page are not saved. Leaving throws them away.</p>}
      confirmLabel="Leave"
      destructive
      onConfirm={() => answer(true)}
    />
  );
}

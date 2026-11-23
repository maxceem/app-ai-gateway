import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * Stops a person walking away from unsaved changes without noticing (v1's
 * `useLeaveGuard`). Two ways out of a page: a move inside the console,
 * which the router holds while the page asks, and closing or reloading the
 * tab, where the browser asks in its own words. Moving to another tab of the
 * same app counts too: each tab keeps its own draft, and leaving it drops it.
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

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set; the text itself is ignored.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset();
      }}
      title="Leave without saving?"
      description={<p>Your changes on this page are not saved. Leaving throws them away.</p>}
      confirmLabel="Leave"
      destructive
      onConfirm={() => {
        if (blocker.state === "blocked") blocker.proceed();
      }}
    />
  );
}

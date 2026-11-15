import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Explains an element on hover with the console's tooltip rather than the
 * browser's: it opens at once and reads like the rest of the page. With no
 * `content` the element is shown as it is.
 */
export function Hint({ content, description, children }: {
  content: ReactNode;
  /** The hint in plain words, where `content` is more than text; see below. */
  description?: string;
  children: ReactElement;
}) {
  if (!content) return children;
  return (
    <Tooltip>
      {/* The hint in plain words is also the element's description, which a
          screen reader reads where a pointer would hover. */}
      <TooltipTrigger asChild aria-description={description ?? (typeof content === "string" ? content : undefined)}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}

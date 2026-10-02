import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Explains an element on hover with the console's tooltip rather than the
 * browser's: it opens at once and reads like the rest of the page. With no
 * `content` the element is shown as it is.
 */
export function Hint({ content, children }: { content: ReactNode; children: ReactElement }) {
  if (!content) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}

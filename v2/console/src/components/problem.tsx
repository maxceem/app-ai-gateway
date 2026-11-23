/** What is wrong with a field, said under it. Nothing when there is nothing wrong. */
export function Problem({ children, className }: { children: string | null | undefined; className?: string }) {
  return children ? (
    <p role="alert" className={className ?? "text-xs text-destructive"}>
      {children}
    </p>
  ) : null;
}

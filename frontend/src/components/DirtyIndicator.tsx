import { cn } from "../lib/utils";

interface DirtyIndicatorProps {
  className?: string;
  size?: "sm" | "md";
  hidden?: boolean;
}

/**
 * Standardized dirty/unsaved changes indicator.
 * Uses theme primary color (accent) to indicate unsaved state.
 * Always reserves layout space so text doesn't shift when toggling.
 */
export function DirtyIndicator({ className, size = "sm", hidden }: DirtyIndicatorProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        size === "sm" && "h-1.5 w-1.5",
        size === "md" && "h-2 w-2",
        hidden ? "invisible" : "visible",
        className
      )}
      aria-label="Unsaved changes"
      role="status"
    >
      <span className={cn("block rounded-full bg-primary w-full h-full", hidden && "invisible")} />
    </span>
  );
}

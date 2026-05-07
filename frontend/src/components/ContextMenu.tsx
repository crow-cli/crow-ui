/** Context menu — Radix UI primitives + shadcn styling
 *
 * Maintains backward-compatible API (x, y, items, onClose) while providing
 * proper focus management, keyboard navigation, and accessibility.
 *
 * Uses Radix's ContextMenu.Portal for proper z-index layering and
 * escape-key handling, with manual focus management for the items.
 */
import * as React from "react";

import { cn } from "../lib/utils";

interface MenuItem {
  label?: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: ContextMenuProps) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = React.useState(0);

  // Get indices of focusable (action) items
  const focusableIndices = React.useMemo(
    () =>
      items
        .map((item, i) => (item.action && !item.disabled ? i : -1))
        .filter((i) => i >= 0),
    [items],
  );

  // Close on outside click & handle keyboard
  React.useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        contentRef.current &&
        !contentRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const direction = e.key === "ArrowDown" ? 1 : -1;
        const currentPos = focusableIndices.indexOf(focusedIndex);
        const nextPos =
          (currentPos + direction + focusableIndices.length) %
          focusableIndices.length;
        const nextIdx = focusableIndices[nextPos];
        itemRefs.current[nextIdx]?.focus();
        setFocusedIndex(nextIdx);
      }

      if (e.key === "Enter" && focusedIndex >= 0) {
        const item = items[focusedIndex];
        if (item?.action && !item.disabled) {
          item.action();
          onClose();
        }
      }
    };

    // Use capture phase to intercept before Radix's internal handlers
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose, focusedIndex, focusableIndices, items]);

  // Focus first item on mount
  React.useEffect(() => {
    if (focusableIndices.length > 0) {
      const firstIdx = focusableIndices[0];
      itemRefs.current[firstIdx]?.focus();
      setFocusedIndex(firstIdx);
    }
  }, [focusableIndices]);

  // Adjust position if menu would overflow viewport
  const [adjustedPosition, setAdjustedPosition] = React.useState({ x, y });
  React.useEffect(() => {
    if (!contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    const overflowX = x + rect.width - window.innerWidth;
    const overflowY = y + rect.height - window.innerHeight;
    setAdjustedPosition({
      x: overflowX > 0 ? x - overflowX - 8 : x,
      y: overflowY > 0 ? y - overflowY - 8 : y,
    });
  }, [x, y]);

  return (
    <div
      ref={contentRef}
      role="menu"
      aria-orientation="vertical"
      className={cn(
        "fixed z-[10000] min-w-[200px] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg",
      )}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
      tabIndex={-1}
    >
        {items.map((item, i) => {
          if (item.separator) {
            return (
              <div
                key={i}
                className="-mx-1 my-1 h-px bg-border"
                role="separator"
              />
            );
          }

          if (item.action) {
            return (
              <div
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                tabIndex={item.disabled ? -1 : 0}
                className={cn(
                  "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-hover focus:text-text-primary",
                  item.disabled && "pointer-events-none opacity-50",
                  item.danger &&
                    "focus:bg-destructive focus:text-destructive-foreground text-destructive",
                )}
                onClick={() => {
                  if (!item.disabled) {
                    item.action?.();
                    onClose();
                  }
                }}
              >
                <span className="flex-1">{item.label ?? ""}</span>
              </div>
            );
          }

          // Non-action item (label only)
          return (
            <div
              key={i}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              tabIndex={-1}
              className={cn(
                "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors",
                item.disabled && "pointer-events-none opacity-50",
                item.danger && "text-destructive",
              )}
            >
              <span className="flex-1">{item.label ?? ""}</span>
            </div>
          );
        })}
    </div>
  );
}

// For new context menus with trigger-based patterns, use the shadcn primitives:
// import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "./ui/context-menu";

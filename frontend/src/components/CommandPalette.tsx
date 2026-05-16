import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { cn } from "../lib/utils";

export interface Command {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  commands: Command[];
  isOpen: boolean;
  onClose: () => void;
}

function fuzzyMatch(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score++;
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/") score += 2;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

export default function CommandPalette({
  commands,
  isOpen,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const scored = commands
      .map((cmd) => ({
        cmd,
        score: fuzzyMatch(query, cmd.label + " " + cmd.category),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [query, commands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      // Focus on next frame after modal renders
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  const execute = useCallback(
    (cmd: Command) => {
      cmd.action();
      onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[selectedIndex];
        if (cmd) execute(cmd);
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isOpen, filtered, selectedIndex, execute, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Palette */}
      <div
        className="relative w-[600px] max-w-[90vw] rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={{
          backgroundColor: "var(--theme-surface-elevated)",
          border: "1px solid var(--theme-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="px-3 py-2.5 border-b" style={{ borderColor: "var(--theme-border)" }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            className="w-full bg-transparent border-none outline-none text-[14px] text-text-primary placeholder:text-text-secondary"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-[13px] text-text-secondary text-center">
              No matching commands
            </div>
          )}
          {filtered.map((cmd, i) => {
            const isSelected = i === selectedIndex;
            return (
              <button
                key={cmd.id}
                onClick={() => execute(cmd)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  "w-full text-left px-3 py-1.5 flex items-center gap-3 text-[13px] border-none cursor-pointer transition-colors",
                  isSelected
                    ? "text-text-primary"
                    : "text-text-secondary bg-transparent",
                )}
                style={
                  isSelected
                    ? { backgroundColor: "var(--theme-accent-15)" }
                    : undefined
                }
              >
                <span className="flex-1 truncate">{cmd.label}</span>
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: "var(--theme-surface-30)",
                    color: "var(--theme-text-secondary)",
                  }}
                >
                  {cmd.category}
                </span>
                {cmd.shortcut && (
                  <span className="text-[11px] font-mono text-text-secondary">
                    {cmd.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

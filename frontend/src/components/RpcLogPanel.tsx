/**
 * RPC Log panel — displays raw ACP notifications in a searchable, copyable format.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as acpStore from "../lib/acp-store";

export default function RpcLogPanel() {
  const [notifications, setNotifications] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  useEffect(() => {
    const s = acpStore.getState();
    setNotifications(s.notifications);
    const unsub = acpStore.subscribe(() => {
      setNotifications(acpStore.getState().notifications);
    });
    return unsub;
  }, []);

  // Auto-expand all by default, auto-scroll on new entries
  useEffect(() => {
    if (notifications.length > prevLen.current) {
      // Expand new entries
      const newIds = notifications.slice(prevLen.current).map((n: any) => n.id);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.add(id);
        return next;
      });
      // Scroll to bottom
      listRef.current?.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevLen.current = notifications.length;
  }, [notifications.length]);

  const filtered = useMemo(() => {
    if (!filter) return notifications;
    const lower = filter.toLowerCase();
    return notifications.filter((n) =>
      JSON.stringify(n).toLowerCase().includes(lower)
    );
  }, [notifications, filter]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpanded(new Set(filtered.map((n: any) => n.id)));
  }, [filtered]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const copyEntry = useCallback((entry: any) => {
    navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).catch(() => {});
  }, []);

  const copyAll = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(filtered, null, 2)).catch(() => {});
  }, [filtered]);

  const clearLog = useCallback(() => {
    acpStore.clearNotifications();
  }, []);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-background)] text-[var(--color-foreground)] font-sans text-sm overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-background-dark)] flex-shrink-0 gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)] whitespace-nowrap">
          ACP Log ({notifications.length})
        </span>
        <div className="flex gap-1 items-center">
          <button onClick={expandAll} className="px-2 py-0.5 text-[10px] rounded border border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)] cursor-pointer whitespace-nowrap hover:bg-[var(--color-border)] transition-colors">
            Expand All
          </button>
          <button onClick={collapseAll} className="px-2 py-0.5 text-[10px] rounded border border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)] cursor-pointer whitespace-nowrap hover:bg-[var(--color-border)] transition-colors">
            Collapse
          </button>
          <button onClick={copyAll} className="px-2 py-0.5 text-[10px] rounded border border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)] cursor-pointer whitespace-nowrap hover:bg-[var(--color-border)] transition-colors">
            Copy All
          </button>
          <button onClick={clearLog} className="px-2 py-0.5 text-[10px] rounded border border-[var(--color-border)] bg-transparent text-[var(--color-red)] cursor-pointer whitespace-nowrap hover:bg-[var(--color-border)] transition-colors">
            Clear
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--color-border)] flex-shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by type, content, or method…"
          className="flex-1 px-2 py-1 text-xs bg-[var(--color-active)] border border-[var(--color-border)] rounded text-[var(--color-foreground)] outline-none font-mono focus:border-[var(--color-primary)] transition-colors"
        />
        <span className="text-[10px] text-[var(--color-muted-foreground)] whitespace-nowrap">
          {filter ? `${filtered.length} of ${notifications.length}` : `${notifications.length} entries`}
        </span>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto font-mono">
        {filtered.length === 0 && (
          <div className="p-6 text-center text-[var(--color-muted-foreground)] text-xs">
            No notifications{filter ? " matching filter" : ""}
          </div>
        )}
        {filtered.map((n: any) => {
          const isExpanded = expanded.has(n.id);
          const update = n.data?.update;
          const stype = update?.sessionUpdate || update?.type || n.type || "unknown";
          const ts = new Date(parseInt(n.id.split("-")[0])).toLocaleTimeString();

          return (
            <div key={n.id} className="border-b border-[var(--color-border)]">
              <div
                onClick={() => toggle(n.id)}
                className={`flex items-center gap-1.5 px-2 py-0.5 cursor-pointer select-none ${isExpanded ? "bg-[var(--color-active)]" : "bg-transparent"} hover:bg-[var(--color-hover)] transition-colors`}
              >
                <span className="text-[var(--color-muted-foreground)] text-[9px] w-3 text-center">{isExpanded ? "▼" : "▶"}</span>
                <span className="text-[var(--color-foreground)] text-[11px] font-mono">{stype}</span>
                <span className="text-[var(--color-muted-foreground)] text-[10px] ml-auto">{ts}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); copyEntry(n); }}
                  className="bg-none border-none cursor-pointer text-[11px] px-1 opacity-60 hover:opacity-100 transition-opacity"
                  title="Copy this entry"
                >
                  📋
                </button>
              </div>
              {isExpanded && (
                <pre className="m-0 px-2 py-1.5 pl-7 whitespace-pre-wrap break-all text-[var(--color-muted-foreground)] text-[10px] leading-relaxed bg-black/20">
                  {JSON.stringify(n, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

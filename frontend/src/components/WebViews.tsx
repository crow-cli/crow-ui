/**
 * WebFetchView — rendered markdown preview for web_fetch tool results.
 * WebSearchView — search results list for web_search tool results.
 */

import { Streamdown } from "streamdown";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { MarkdownCode } from "./MarkdownCode";
import "katex/dist/katex.min.css";

// ─── WebFetchView ────────────────────────────────────────────────────────────

interface WebFetchViewProps {
  url: string;
  content: string;
}

export function WebFetchView({ url, content }: WebFetchViewProps) {
  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-background-dark)] text-xs">
      <div className="px-3 py-1 border-b border-[var(--color-border)] bg-[var(--color-background-dark)] flex items-center gap-1.5">
        <span className="text-[var(--color-primary)] text-xs">🌐</span>
        <span className="text-[11px] font-mono text-[var(--color-foreground)] overflow-hidden text-ellipsis whitespace-nowrap">
          {url}
        </span>
      </div>
      <div className="p-2 max-h-[300px] overflow-y-auto text-xs leading-relaxed text-[var(--color-foreground)]">
        <Streamdown
          plugins={{ mermaid, math }}
          components={{ code: MarkdownCode }}
          linkSafety={{ enabled: false }}
        >
          {content}
        </Streamdown>
      </div>
    </div>
  );
}

// ─── WebSearchView ───────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchViewProps {
  query: string;
  results: SearchResult[];
}

export function WebSearchView({ query, results }: WebSearchViewProps) {
  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-background-dark)] text-xs">
      <div className="px-3 py-1 border-b border-[var(--color-border)] bg-[var(--color-background-dark)] flex items-center gap-1.5">
        <span className="text-[var(--color-primary)] text-xs">🔍</span>
        <span className="text-[11px] text-[var(--color-foreground-muted)]">Search:</span>
        <span className="text-[11px] text-[var(--color-foreground)] overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          {query}
        </span>
        <span className="ml-auto text-[10px] text-[var(--color-foreground-muted)]">
          {results.length} results
        </span>
      </div>
      <div className="max-h-[300px] overflow-y-auto flex flex-col">
        {results.map((result, i) => (
          <div
            key={i}
            className={`px-3 py-1.5 cursor-pointer ${
              i < results.length - 1 ? "border-b border-[var(--color-border)]" : ""
            }`}
            onClick={() => window.open(result.url, "_blank")}
          >
            <div className="text-xs text-[var(--color-blue)] font-medium mb-0.5">{result.title}</div>
            <div className="text-[10px] text-[var(--color-foreground-muted)] font-mono mb-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {result.url}
            </div>
            <div className="text-[11px] text-[var(--color-foreground)] leading-snug opacity-80">
              {result.snippet}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

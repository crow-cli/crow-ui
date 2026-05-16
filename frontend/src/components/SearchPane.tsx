import { useState, useCallback, useRef, useEffect } from "react";
import { Search, Replace, CaseSensitive, WholeWord, Regex, ChevronDown, X } from "lucide-react";

interface SearchPaneProps {
  workspaceRoot: string | null;
}

interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

export default function SearchPane({ workspaceRoot }: SearchPaneProps) {
  const [query, setQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [includePattern, setIncludePattern] = useState("");
  const [excludePattern, setExcludePattern] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !workspaceRoot) return;
    setIsSearching(true);
    setHasSearched(true);

    // TODO: replace with real backend search (rg/fd integration)
    // For now, simulate a delay and show placeholder results
    await new Promise((r) => setTimeout(r, 300));
    setResults([
      { path: `${workspaceRoot}/src/main.ts`, line: 42, column: 5, text: `const ${query} = "..."` },
      { path: `${workspaceRoot}/src/lib/utils.ts`, line: 12, column: 1, text: `export function ${query}() {` },
    ]);
    setIsSearching(false);
  }, [query, workspaceRoot]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch();
    }
  };

  return (
    <div className="flex flex-col h-full text-[13px] text-text-primary overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b shrink-0" style={{ borderColor: "var(--theme-border)" }}>
        <div className="flex items-center gap-1.5 mb-2">
          <Search className="w-3.5 h-3.5 text-text-secondary" />
          <span className="text-[12px] font-medium text-text-secondary">Search</span>
        </div>

        {/* Search input */}
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-md"
          style={{ backgroundColor: "var(--theme-surface-30)", border: "1px solid var(--theme-border)" }}
        >
          <Search className="w-3.5 h-3.5 text-text-secondary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search across files..."
            className="flex-1 bg-transparent border-none outline-none text-[12px] text-text-primary placeholder:text-text-secondary min-w-0"
          />
          {query && (
            <button
              onClick={() => { setQuery(""); setResults([]); setHasSearched(false); }}
              className="p-0.5 rounded hover:bg-hover text-text-secondary cursor-pointer border-none"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Replace input (collapsible) */}
        {showReplace && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-md mt-1.5"
            style={{ backgroundColor: "var(--theme-surface-30)", border: "1px solid var(--theme-border)" }}
          >
            <Replace className="w-3.5 h-3.5 text-text-secondary shrink-0" />
            <input
              type="text"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              placeholder="Replace with..."
              className="flex-1 bg-transparent border-none outline-none text-[12px] text-text-primary placeholder:text-text-secondary min-w-0"
            />
          </div>
        )}

        {/* Toggle replace + options */}
        <div className="flex items-center gap-1 mt-2">
          <button
            onClick={() => setShowReplace((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary cursor-pointer border-none bg-transparent"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${showReplace ? "rotate-180" : ""}`} />
            {showReplace ? "Hide replace" : "Show replace"}
          </button>
          <div className="flex-1" />
          <ToggleBtn active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Match Case">
            <CaseSensitive className="w-3 h-3" />
          </ToggleBtn>
          <ToggleBtn active={wholeWord} onClick={() => setWholeWord((v) => !v)} title="Match Whole Word">
            <WholeWord className="w-3 h-3" />
          </ToggleBtn>
          <ToggleBtn active={useRegex} onClick={() => setUseRegex((v) => !v)} title="Use Regular Expression">
            <Regex className="w-3 h-3" />
          </ToggleBtn>
        </div>

        {/* Include / Exclude patterns */}
        <div className="flex gap-2 mt-2">
          <PatternInput
            value={includePattern}
            onChange={setIncludePattern}
            placeholder="files to include"
          />
          <PatternInput
            value={excludePattern}
            onChange={setExcludePattern}
            placeholder="files to exclude"
          />
        </div>

        {/* Search button */}
        <button
          onClick={handleSearch}
          disabled={!query.trim() || isSearching}
          className="w-full mt-2 py-1 rounded text-[11px] font-medium cursor-pointer disabled:opacity-50 border-none"
          style={{
            backgroundColor: "var(--theme-accent-80)",
            color: "var(--theme-text-inverse)",
          }}
        >
          {isSearching ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!hasSearched && (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary text-[12px] gap-2">
            <Search className="w-8 h-8 opacity-30" />
            <span>Type a query and press Enter</span>
          </div>
        )}
        {hasSearched && results.length === 0 && !isSearching && (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary text-[12px] gap-2">
            <X className="w-8 h-8 opacity-30" />
            <span>No results found</span>
          </div>
        )}
        {results.map((res, i) => (
          <div
            key={i}
            className="px-3 py-1.5 border-b cursor-pointer hover:bg-hover"
            style={{ borderColor: "var(--theme-border)" }}
            onClick={() => {
              // TODO: open file at line
              console.log("Open:", res.path, res.line);
            }}
          >
            <div className="text-[11px] font-mono text-text-secondary truncate">
              {res.path.replace(workspaceRoot + "/", "")}:{res.line}:{res.column}
            </div>
            <div className="text-[12px] text-text-primary truncate mt-0.5">
              {res.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1 rounded cursor-pointer border-none transition-colors"
      style={
        active
          ? {
              backgroundColor: "var(--theme-accent-20)",
              color: "var(--theme-accent)",
            }
          : {
              backgroundColor: "transparent",
              color: "var(--theme-text-secondary)",
            }
      }
    >
      {children}
    </button>
  );
}

function PatternInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 px-2 py-0.5 rounded text-[11px] bg-transparent outline-none"
      style={{
        border: "1px solid var(--theme-border)",
        color: "var(--theme-text-primary)",
      }}
    />
  );
}

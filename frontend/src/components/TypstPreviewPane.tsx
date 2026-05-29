import { useEffect, useState, useCallback } from "react";
import { FileText, RefreshCw, AlertCircle } from "lucide-react";
import { documentApi } from "../lib/rpc";
import { ws } from "../lib/ws-client";

interface TypstPreviewPaneProps {
  path: string;
}

export default function TypstPreviewPane({ path }: TypstPreviewPaneProps) {
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const compile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await documentApi.typstCompile({ path });
      if (result.success) {
        setHtml(result.html);
      } else {
        setError(result.error || "Unknown compilation error");
      }
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  // Initial compile
  useEffect(() => {
    compile();
  }, [compile]);

  // Recompile when file changes via worktree events
  useEffect(() => {
    const unsubscribe = ws.onWorktreeEvent((method, params) => {
      if (
        (method === "worktree-file-changed" || method === "worktree-file-created") &&
        params.path === path
      ) {
        compile();
      }
    });
    return unsubscribe;
  }, [path, compile]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-text-secondary">
        <AlertCircle className="w-8 h-8 text-red-400" />
        <div className="text-sm font-medium text-red-400">Typst compilation failed</div>
        <pre className="text-xs text-text-secondary bg-surface p-3 rounded max-w-full overflow-auto">
          {error}
        </pre>
        <button
          onClick={compile}
          className="flex items-center gap-2 px-3 py-1.5 bg-hover hover:bg-hover/80 border border-border rounded text-xs cursor-pointer"
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <FileText className="w-3.5 h-3.5 text-violet-400" />
        <span className="text-[11px] text-text-secondary font-mono truncate flex-1">
          {path.split("/").pop()}
        </span>
        <button
          onClick={compile}
          disabled={loading}
          className="p-1 rounded hover:bg-hover text-text-secondary hover:text-text-primary cursor-pointer border-none disabled:opacity-50"
          title="Recompile"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {html ? (
        <iframe
          srcDoc={html}
          title="Typst Preview"
          className="flex-1 w-full border-none"
          sandbox="allow-scripts allow-same-origin"
        />
      ) : (
        <div className="flex items-center justify-center h-full text-text-secondary text-sm">
          {loading ? "Compiling..." : "No preview available"}
        </div>
      )}
    </div>
  );
}

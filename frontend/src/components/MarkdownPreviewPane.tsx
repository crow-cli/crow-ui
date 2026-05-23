import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { MarkdownCode } from "./MarkdownCode";
import "katex/dist/katex.min.css";
import { fsApi } from "../lib/rpc";
import { ws } from "../lib/ws-client";

interface MarkdownPreviewPaneProps {
  path: string;
}

export default function MarkdownPreviewPane({ path }: MarkdownPreviewPaneProps) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fsApi.readFile({ path })
      .then((result: any) => {
        if (cancelled) return;
        setContent(result.content as string);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => { cancelled = true; };
  }, [path]);

  // Live update when file changes via worktree events
  useEffect(() => {
    const unsubscribe = ws.onWorktreeEvent((method, params) => {
      if (
        (method === "worktree-file-changed" || method === "worktree-file-created") &&
        params.path === path &&
        typeof params.new_content === "string"
      ) {
        setContent(params.new_content);
      }
    });
    return unsubscribe;
  }, [path]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm">
        Failed to load preview: {error}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-4 text-text-primary">
      <Streamdown
        plugins={{ mermaid, math }}
        isAnimating={false}
        components={{ code: MarkdownCode }}
        linkSafety={{ enabled: false }}
      >
        {content}
      </Streamdown>
    </div>
  );
}

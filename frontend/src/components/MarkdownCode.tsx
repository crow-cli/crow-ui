import { memo, useEffect, useRef, useState } from "react";
import { ShikiCodeBlock } from "./ShikiCodeBlock";

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as any).props.children);
  }
  return String(children ?? "");
}

export const MarkdownCode = memo(function MarkdownCode(props: any) {
  const { className, children } = props;
  const match = /language-(\w+)/.exec(className ?? "");
  const lang = match?.[1];
  const code = extractText(children).trimEnd();

  // Inline code (no language class)
  if (!lang) {
    return (
      <code className="bg-violet-500/8 border border-violet-500/15 rounded px-1 py-0.5 font-mono text-[0.9em] text-violet-300">
        {code}
      </code>
    );
  }

  // Mermaid diagram — bypass Shiki and render as SVG
  if (lang === "mermaid") {
    return <MermaidBlock code={code} />;
  }

  // Code block
  return <ShikiCodeBlock code={code} lang={lang} className={className} />;
});

function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    async function render() {
      setIsLoading(true);
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          fontFamily: "monospace",
          suppressErrorRendering: true,
        });

        const id = `mmd-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
        const result = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram");
          setSvg(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    // Debounce: wait 600ms after code stops changing before rendering.
    // During streaming this prevents flickering from incomplete diagrams.
    timeoutId = setTimeout(() => {
      if (!cancelled) render();
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [code]);

  if (error) {
    return (
      <div className="my-4 rounded-xl border border-red-500/20 bg-red-500/5 p-3">
        <div className="text-red-400 text-xs font-mono mb-2">Mermaid Error: {error}</div>
        <pre className="text-xs text-text-secondary overflow-x-auto">{code}</pre>
      </div>
    );
  }

  return (
    <div className="my-4 rounded-xl border border-border bg-sidebar p-2">
      <div className="flex h-8 items-center text-muted-foreground text-xs">
        <span className="ml-1 font-mono lowercase">mermaid</span>
      </div>
      <div className="rounded-md border border-border bg-background p-2 overflow-x-auto">
        {svg ? (
          <div ref={containerRef} className="flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-xs">
            {isLoading && (
              <>
                <div className="h-3 w-3 animate-spin rounded-full border-current border-b-2 mr-2" />
                Rendering diagram…
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

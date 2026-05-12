import { useEffect, useRef, useState, memo } from "react";
import { codeToHtml } from "shiki";
import { getCurrentShikiTheme } from "../lib/themes";

interface ShikiCodeBlockProps {
  code: string;
  lang?: string;
  className?: string;
}

export const ShikiCodeBlock = memo(function ShikiCodeBlock({
  code,
  lang = "text",
  className,
}: ShikiCodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(code, {
      lang,
      theme: getCurrentShikiTheme(),
    }).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const isInline = !className?.includes("language-");
  if (isInline) {
    return (
      <code
        className="rounded px-1 py-0.5 font-mono text-[0.9em]"
        style={{
          backgroundColor: "var(--theme-accent-8)",
          border: "1px solid var(--theme-accent-15)",
          color: "var(--theme-accent-light)",
        }}
      >
        {code}
      </code>
    );
  }

  return (
    <div
      className="group relative my-3 rounded-lg backdrop-blur-sm overflow-hidden"
      style={{
        border: "1px solid var(--theme-accent-10)",
        backgroundColor: "var(--theme-bg-30)",
      }}
    >
      {/* Subtle copy button — appears on hover */}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-150 px-2 py-1 rounded text-[10px] font-medium"
        style={{
          backgroundColor: "var(--theme-accent-10)",
          border: "1px solid var(--theme-accent-20)",
          color: "var(--theme-accent-light)",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--theme-accent-20)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--theme-text-primary)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--theme-accent-10)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--theme-accent-light)";
        }}
        title="Copy code"
      >
        {copied ? "Copied" : "Copy"}
      </button>

      {/* Code content */}
      <div
        ref={codeRef}
        className="overflow-x-auto px-4 py-3 text-[12px] leading-relaxed"
      >
        {html ? (
          <div
            dangerouslySetInnerHTML={{ __html: html }}
            className="shiki-code [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!font-mono [&_code]:!text-[12px] [&_code]:!leading-relaxed"
          />
        ) : (
          <pre
            className="m-0 p-0 font-mono text-[12px] leading-relaxed"
            style={{ color: "var(--theme-text-primary)" }}
          >
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
});

import { memo } from "react";
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

  // Code block
  return <ShikiCodeBlock code={code} lang={lang} className={className} />;
});

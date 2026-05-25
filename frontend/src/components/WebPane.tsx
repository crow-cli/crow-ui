import { useEffect, useState } from "react";
import * as settings from "../lib/settings";

export default function WebPane() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    settings.getSetting<string>("web.searchUrl", "").then((v) => setUrl(v ?? null));
  }, []);

  if (url === null) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        Loading…
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-text-secondary text-sm">
        <span>No search URL configured.</span>
        <span className="text-[11px]">
          Add{" "}
          <code className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">
            {"\"web.searchUrl\": \"http://localhost:8080\""}
          </code>{" "}
          to ~/.crow/crow-ui-settings.json
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-[11px] text-text-secondary font-mono truncate flex-1">
          {url}
        </span>
      </div>
      <iframe
        src={url}
        title="Web"
        className="flex-1 w-full border-none"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

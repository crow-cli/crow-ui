import { useState, useEffect } from "react";
import * as acpStore from "../lib/acp-store";

interface ChatTab {
  id: string;
  label: string;
  agentName: string;
}

interface ChatTabsProps {
  onTabClick: (id: string) => void;
  activeTabId: string | null;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  minimized?: boolean;
  onToggleMinimize?: () => void;
}

export function ChatTabs({
  onTabClick,
  activeTabId,
  onNewTab,
  onCloseTab,
  minimized = false,
  onToggleMinimize,
}: ChatTabsProps) {
  const [tabs, setTabs] = useState<ChatTab[]>([]);

  useEffect(() => {
    const update = () => {
      const ids = acpStore.getSessionIds();
      const newTabs: ChatTab[] = ids.map((id) => {
        const state = acpStore.getSession(id);
        const label =
          state.sessionInfo?.initResponse?.agentInfo?.title ||
          state.agentConfig?.name ||
          "Agent";
        return { id, label, agentName: label };
      });
      setTabs(newTabs);
    };

    update();
    const unsub = acpStore.subscribeToMeta(() => update());
    return unsub;
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex bg-[var(--color-background-dark)] border-b border-[var(--color-border)] overflow-x-auto shrink-0 h-[35px] items-center"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onTabClick(tab.id)}
            className={`flex items-center gap-1.5 px-3 text-[13px] cursor-pointer select-none border-r border-[var(--color-border)] min-w-0 relative shrink-0 transition-colors ${
              isActive
                ? "bg-[var(--color-card)] text-[var(--color-foreground)]"
                : "bg-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-border)]"
            }`}
          >
            {isActive && (
              <div className="absolute top-0 left-0 right-0 h-[1px] bg-[var(--color-primary)]" />
            )}
            <span className="text-[12px]">🤖</span>
            <span
              className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[120px]"
              style={{ fontWeight: isActive ? 600 : 400 }}
            >
              {tab.agentName}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              className={`px-1 text-[16px] leading-none bg-none border-none cursor-pointer rounded shrink-0 transition-colors ${
                isActive ? "text-[var(--color-text-dim)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-border)]" : "text-transparent hover:text-[var(--color-destructive)]"
              }`}
            >
              ×
            </button>
          </div>
        );
      })}

      {onToggleMinimize && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleMinimize();
          }}
          className="px-2 text-[12px] leading-none text-[var(--color-muted-foreground)] bg-none border-none border-l border-[var(--color-border)] cursor-pointer shrink-0"
          title={minimized ? "Expand chat panel" : "Minimize chat panel"}
        >
          {minimized ? "▴" : "▾"}
        </button>
      )}

      <button
        onClick={onNewTab}
        className="px-3 text-[16px] leading-none text-[var(--color-muted-foreground)] bg-none border-none border-l border-[var(--color-border)] cursor-pointer shrink-0"
        title="New Agent Session"
      >
        +
      </button>
    </div>
  );
}

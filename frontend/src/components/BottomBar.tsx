/** Bottom bar — activity icons + status info + minimize toggles */
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  IconChat,
  IconExplorer,
  IconSearch,
  IconGit,
  IconExtensions,
  IconRpc,
  IconTerminal,
  IconEditor,
} from "../lib/icons";
import { globalOpenChat } from "../lib/workspace-context";

export type ActivityId =
  | "chat"
  | "explorer"
  | "search"
  | "git"
  | "terminal"
  | "extensions"
  | "rpc"
  | "settings";

interface BottomBarProps {
  active: ActivityId;
  onActivate: (id: ActivityId) => void;
  connected: boolean;
  saving: boolean;
  dirty: boolean;
  language: string;
  line: number;
  col: number;
  encoding: string;
  lineEnding: string;
  wordWrap: boolean;
  workspaceName: string;
  onToggleEditors: () => void;
  onToggleTerminals: () => void;
  editorsMinimized: boolean;
  terminalsMinimized: boolean;
  editorTileCount: number;
  terminalTileCount: number;
  onToggleChats: () => void;
  chatsMinimized: boolean;
  chatTileCount: number;
}

interface ActivityDef {
  id: ActivityId;
  Icon: React.FC<{ size?: number; color?: string }>;
  label: string;
  badge?: number;
}

const LEFT_ACTIVITIES: ActivityDef[] = [
  { id: "chat", Icon: IconChat, label: "Agent Chat" },
  { id: "search", Icon: IconSearch, label: "Search" },
  { id: "git", Icon: IconGit, label: "Source Control" },
  { id: "extensions", Icon: IconExtensions, label: "Extensions" },
  { id: "rpc", Icon: IconRpc, label: "ACP Log" },
];

function getActivitiesWithBadges(chatTileCount: number): ActivityDef[] {
  return LEFT_ACTIVITIES.map((a) =>
    a.id === "chat" && chatTileCount > 0 ? { ...a, badge: chatTileCount } : a,
  );
}

export default function BottomBar({
  active,
  onActivate,
  connected,
  saving,
  dirty,
  language,
  line,
  col,
  encoding,
  wordWrap,
  workspaceName,
  onToggleEditors,
  onToggleTerminals,
  onToggleChats,
  editorsMinimized,
  terminalsMinimized,
  chatsMinimized,
  editorTileCount,
  terminalTileCount,
  chatTileCount,
}: BottomBarProps) {
  const isActive = (id: ActivityId) => active === id;

  return (
    <div className="h-7 flex items-center px-4 text-xs shrink-0 font-medium select-none bg-background border-t border-white/5 text-muted-foreground">
      {/* Left: activity icons */}
      <div className="flex items-center gap-0.5">
        {getActivitiesWithBadges(chatTileCount).map(
          ({ id, Icon, label, badge }) => (
            <Button
              key={id}
              variant="ghost"
              size="icon"
              title={label}
              onClick={() => {
                if (id === "chat") globalOpenChat();
                else onActivate(id);
              }}
              className={`h-7 w-7 rounded-md relative ${isActive(id) ? "text-accent" : "text-text-secondary"}`}
            >
              <Icon size={14} />
              {badge !== undefined && badge > 0 && (
                <Badge
                  variant="accent"
                  className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full px-1 text-[8px] leading-none"
                >
                  {badge}
                </Badge>
              )}
            </Button>
          ),
        )}
      </div>

      {/* Workspace status */}
      <div className="flex items-center gap-3 ml-4">
        <span className="px-2 h-6 flex items-center cursor-default text-xs whitespace-nowrap text-text-secondary">
          {connected ? "✓" : "○"}{" "}
          {saving ? "Saving…" : workspaceName || "No Directory"}
        </span>
        {dirty && <span className="text-accent text-sm leading-none">●</span>}
      </div>

      {/* Right: status info + minimize toggles + explorer */}
      <div className="flex items-center gap-3 ml-auto mr-3">
        <span className="px-2 h-6 flex items-center cursor-default text-[11px] whitespace-nowrap text-text-secondary">
          Ln {line}, Col {col}
        </span>
        <span className="px-2 h-6 flex items-center cursor-default text-[11px] whitespace-nowrap text-text-secondary">
          {encoding}
        </span>
        {wordWrap && (
          <span className="px-2 h-6 flex items-center cursor-default text-[11px] whitespace-nowrap text-text-secondary">
            Wrap
          </span>
        )}
        <span className="px-2 h-6 flex items-center cursor-default text-[11px] whitespace-nowrap text-text-secondary">
          {language}
        </span>

        {/* Divider */}
        <div className="w-px h-3.5 bg-white/10 mx-1" />

        {/* Editor toggle */}
        <Button
          variant="ghost"
          size="icon"
          title={
            editorsMinimized
              ? `Restore editors (${editorTileCount} hidden)`
              : "Minimize all editors"
          }
          onClick={onToggleEditors}
          className={`h-7 w-7 rounded-md relative ${editorsMinimized ? "text-accent" : "text-text-secondary"}`}
        >
          <IconEditor size={14} />
          {editorTileCount > 0 && (
            <span className="absolute bottom-0 right-0 bg-muted text-text-secondary rounded-full w-3.5 h-3.5 text-[7px] font-bold flex items-center justify-center">
              {editorTileCount}
            </span>
          )}
        </Button>

        {/* Terminal toggle */}
        <Button
          variant="ghost"
          size="icon"
          title={
            terminalsMinimized
              ? `Restore terminals (${terminalTileCount} hidden)`
              : "Minimize all terminals"
          }
          onClick={onToggleTerminals}
          className={`h-7 w-7 rounded-md relative ${terminalsMinimized ? "text-accent" : "text-text-secondary"}`}
        >
          <IconTerminal size={14} />
          {terminalTileCount > 0 && (
            <span className="absolute bottom-0 right-0 bg-muted text-text-secondary rounded-full w-3.5 h-3.5 text-[7px] font-bold flex items-center justify-center">
              {terminalTileCount}
            </span>
          )}
        </Button>

        {/* Chat toggle */}
        <Button
          variant="ghost"
          size="icon"
          title={
            chatsMinimized
              ? `Restore chats (${chatTileCount} hidden)`
              : "Minimize all chats"
          }
          onClick={onToggleChats}
          className={`h-7 w-7 rounded-md relative ${chatsMinimized ? "text-accent" : "text-text-secondary"}`}
        >
          <IconChat size={14} />
          {chatTileCount > 0 && (
            <span className="absolute bottom-0 right-0 bg-muted text-text-secondary rounded-full w-3.5 h-3.5 text-[7px] font-bold flex items-center justify-center">
              {chatTileCount}
            </span>
          )}
        </Button>

        {/* Divider */}
        <div className="w-px h-3.5 bg-border/50 mx-1" />

        {/* Explorer toggle */}
        <Button
          variant="ghost"
          size="icon"
          title="Explorer"
          onClick={() => onActivate("explorer")}
          className={`h-7 w-7 rounded-md ${isActive("explorer") ? "text-accent" : "text-text-secondary"}`}
        >
          <IconExplorer size={14} />
        </Button>
      </div>
    </div>
  );
}

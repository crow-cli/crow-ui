import { FileIcon } from "../lib/file-icons";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { IconClose } from "../lib/icons";

export interface OpenFile {
  path: string;
  language: string;
}

interface TabBarProps {
  openFiles: OpenFile[];
  activePath: string | null;
  dirtyFiles: Set<string>;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
}

export function TabBar({
  openFiles,
  activePath,
  dirtyFiles,
  onTabClick,
  onTabClose,
}: TabBarProps) {
  if (openFiles.length === 0) return null;

  return (
    <div className="flex bg-[var(--color-background-dark)] border-b border-[rgba(100,95,160,0.15)] overflow-x-auto shrink-0 h-[35px]">
      {openFiles.map((file) => {
        const isActive = file.path === activePath;
        const isDirty = dirtyFiles.has(file.path);
        const fileName = file.path.split("/").pop() || file.path;

        return (
          <div
            key={file.path}
            className={`flex items-center gap-1.5 px-3 text-[13px] cursor-pointer select-none min-w-0 relative transition-colors ${
              isActive
                ? "bg-[var(--color-card)] text-[var(--color-foreground)]"
                : "bg-transparent text-[var(--color-foreground-dim)] hover:bg-[var(--color-border)]"
            }`}
            onClick={() => onTabClick(file.path)}
          >
            {isActive && (
              <div className="absolute top-0 left-0 right-0 h-[1px] bg-[var(--color-primary)]" />
            )}
            <FileIcon name={fileName} size={12} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[150px]">
              {fileName}
            </span>
            {isDirty && (
              <span className="text-[8px] leading-none text-[var(--color-primary)]">●</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className={`ml-auto h-5 w-5 p-0 rounded-sm hover:text-[var(--color-destructive)] hover:bg-[var(--color-border)] ${
                isActive ? "text-[var(--color-active)]" : "text-transparent"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(file.path);
              }}
            >
              <IconClose size={14} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

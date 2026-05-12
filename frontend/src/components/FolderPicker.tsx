import { useState, useEffect, useCallback, useRef } from "react";
import { ws } from "../lib/ws-client";
import { fsApi } from "../lib/rpc";
import { FileIcon } from "../lib/file-icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./ui/dialog";
import { cn } from "../lib/utils";
import * as settings from "../lib/settings";

import type { DirEntry } from "../bindings";

interface FolderPickerProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  open: boolean;
}

const HOME_PATH = "/home";

const QUICK_PICKS = [
  { label: "Home", path: HOME_PATH, icon: "⌂" },
  { label: "Root", path: "/", icon: "/" },
  { label: "Temp", path: "/tmp", icon: "📁" },
];

export function FolderPicker({
  initialPath,
  onSelect,
  onClose,
  open,
}: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || HOME_PATH);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isHidden = (name: string): boolean =>
    name.startsWith(".") && name !== "." && name !== "..";
  const showHidden = settings.getSettings().folderPicker.showHiddenFiles;

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fsApi.readDir({
        path,
      });
      const filtered = showHidden
        ? result.entries
        : result.entries.filter((e) => !isHidden(e.name));
      const sorted = [...filtered].sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
      setCurrentPath(path);
    } catch (e: any) {
      setError(`Cannot read directory: ${e.message || e}`);
      setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      loadDir(initialPath || HOME_PATH);
    }
  }, [open, initialPath, loadDir]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const navigateTo = (path: string) => loadDir(path);
  const navigateUp = () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    loadDir(parent === "/" ? "/" : parent);
  };

  const handlePathInput = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLInputElement;
      loadDir(target.value);
    }
  };

  const pathParts = currentPath.split("/").filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[700px] p-0 gap-0 border border-border bg-popover text-text-accent [&>button]:hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div>
            <DialogTitle className="text-[15px] font-semibold tracking-tight text-text-accent">
              Open Directory
            </DialogTitle>
            <DialogDescription className="text-[13px] text-text-secondary mt-1">
              Navigate to a directory and click "Select Directory" to open it
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-text-secondary hover:text-text-accent hover:bg-hover rounded-sm"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </Button>
          </DialogClose>
        </div>

        {/* Quick picks */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/40">
          <span className="text-[12px] text-text-secondary font-medium mr-2 tracking-wide">
            Quick access
          </span>
          {QUICK_PICKS.map((qp) => (
            <Button
              key={qp.path}
              variant={currentPath === qp.path ? "secondary" : "ghost"}
              size="sm"
              onClick={() => navigateTo(qp.path)}
              className={cn(
                "h-7 text-[12px] px-3 font-normal rounded-sm gap-1.5",
                currentPath === qp.path
                  ? "bg-hover text-text-primary"
                  : "text-text-secondary hover:text-text-accent",
              )}
            >
              <span className="opacity-70">{qp.icon}</span>
              {qp.label}
            </Button>
          ))}
        </div>

        {/* Path input */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-border">
          <Button
            variant="ghost"
            size="icon"
            onClick={navigateUp}
            disabled={currentPath === "/"}
            className="h-8 w-8 flex-shrink-0 disabled:opacity-30 rounded-sm text-text-secondary hover:text-text-accent hover:bg-hover"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </Button>
          <Input
            ref={inputRef as any}
            value={currentPath}
            onChange={(e) => setCurrentPath(e.target.value)}
            onKeyDown={handlePathInput}
            className="h-8 font-mono text-[13px] bg-input border-border rounded-sm"
          />
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-6 py-2.5 text-[12px] border-b border-border bg-muted/20 overflow-x-auto">
          <BreadcrumbLink
            path="/"
            currentPath={currentPath}
            onClick={navigateTo}
            className="font-medium"
          >
            /
          </BreadcrumbLink>
          {pathParts.map((part, i) => (
            <span key={i} className="flex items-center gap-1 flex-shrink-0">
              <span className="text-text-secondary/60">/</span>
              <BreadcrumbLink
                path={"/" + pathParts.slice(0, i + 1).join("/")}
                currentPath={currentPath}
                onClick={navigateTo}
                className={cn(
                  i === pathParts.length - 1 && "text-accent font-medium",
                )}
              >
                {part}
              </BreadcrumbLink>
            </span>
          ))}
        </div>

        {/* File list */}
        <div className="overflow-y-auto min-h-[280px] max-h-[360px] py-1">
          {loading && (
            <div className="flex items-center justify-center h-32 text-text-secondary text-[13px]">
              <svg
                className="animate-spin mr-2 h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
              Loading…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-32 text-destructive text-[13px] px-6">
              <svg
                className="mr-2 h-4 w-4 flex-shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="flex items-center justify-center h-32 text-text-secondary text-[13px]">
              Empty directory
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => entry.isDir && navigateTo(entry.path)}
              className={cn(
                "flex items-center gap-3 px-6 py-2 cursor-pointer transition-colors",
                entry.isDir
                  ? "hover:bg-hover/60 text-text-accent"
                  : "text-text-secondary cursor-default hover:bg-muted/40",
              )}
            >
              <div className="flex-shrink-0">
                <FileIcon name={entry.name} isDir={entry.isDir} size={16} />
              </div>
              <span
                className={cn(
                  "text-[13px] overflow-hidden text-ellipsis whitespace-nowrap",
                  entry.isDir && "font-medium",
                )}
              >
                {entry.name}
              </span>
              {entry.isDir && (
                <svg
                  className="ml-auto h-3.5 w-3.5 text-text-secondary/50 flex-shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/30">
          <span className="text-[12px] text-text-secondary tracking-wide">
            {entries.filter((e) => e.isDir).length} directories,{" "}
            {entries.filter((e) => !e.isDir).length} files
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-8 px-4 text-[13px] rounded-md border-border hover:bg-hover min-w-[80px]"
            >
              Cancel
            </Button>
            <Button
              onClick={() => onSelect(currentPath)}
              className="h-8 px-5 text-[13px] rounded-md font-medium min-w-[120px]"
            >
              Select Directory
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BreadcrumbLink({
  path,
  currentPath,
  onClick,
  className,
  children,
}: {
  path: string;
  currentPath: string;
  onClick: (p: string) => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const isCurrent = currentPath === path;
  return (
    <span
      className={cn(
        "cursor-pointer transition-colors hover:text-accent",
        isCurrent ? "text-accent" : "text-text-secondary",
        className,
      )}
      onClick={() => onClick(path)}
    >
      {children ?? path}
    </span>
  );
}

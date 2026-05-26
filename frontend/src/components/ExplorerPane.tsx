import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ws } from "../lib/ws-client";
import { fsApi } from "../lib/rpc";
import { FileIcon } from "../lib/file-icons";
import { cn } from "../lib/utils";
import ContextMenu from "./ContextMenu";
import { Button } from "./ui/button";
import { DirtyIndicator } from "./DirtyIndicator";
import * as settings from "../lib/settings";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface ExplorerPaneProps {
  root: string;
  onFileClick: (path: string, isDir: boolean) => void;
  dirtyFiles?: Set<string>;
  activeFile?: string | null;
}

export default function ExplorerPane({
  root,
  onFileClick,
  dirtyFiles,
  activeFile,
}: ExplorerPaneProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [childCache, setChildCache] = useState<Map<string, FileEntry[]>>(
    new Map(),
  );

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetPath: string;
    targetIsDir: boolean;
  } | null>(null);

  // Inline rename state
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Inline create (new file/folder) state
  const [creatingParentPath, setCreatingParentPath] = useState<string | null>(
    null,
  );
  const [creatingName, setCreatingName] = useState("");
  const [creatingIsDir, setCreatingIsDir] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation state
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState("");

  // Drag-and-drop state
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  // Read hidden files preference from settings
  const [showHiddenFiles, setShowHiddenFiles] = useState(
    settings.getSettings().explorer.showHiddenFiles,
  );

  useEffect(() => {
    const unsub = settings.subscribe(() => {
      setShowHiddenFiles(settings.getSettings().explorer.showHiddenFiles);
    });
    return unsub;
  }, []);

  // Explorer appearance settings (backend-driven)
  const [explorerBg, setExplorerBg] = useState("#18181b");
  const [explorerOpacity, setExplorerOpacity] = useState(1.0);
  const treeFontSize = settings.useWorkbenchFontSize("tree");

  const explorerBgRgba = useMemo(() => {
    const hex = explorerBg.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${explorerOpacity})`;
  }, [explorerBg, explorerOpacity]);

  useEffect(() => {
    settings.getSetting<string>("explorer.backgroundColor").then((v) => {
      if (v) setExplorerBg(v);
    });
    settings.getSetting<number>("explorer.backgroundOpacity").then((v) => {
      if (v !== undefined) setExplorerOpacity(v);
    });
  }, []);

  // Reload tree when setting changes
  useEffect(() => {
    setChildCache(new Map());
    setExpandedDirs(new Set());
    loadDir(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHiddenFiles]);

  const isHidden = (name: string): boolean =>
    name.startsWith(".") && name !== "." && name !== "..";

  const sortEntries = (items: FileEntry[]): FileEntry[] => {
    let filtered = showHiddenFiles
      ? items
      : items.filter((e) => !isHidden(e.name));
    return [...filtered].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  };

  // Listen for worktree file change events to refresh explorer
  useEffect(() => {
    const handleWorktreeEvent = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (
          msg.method === "worktree-file-created" ||
          msg.method === "worktree-file-deleted"
        ) {
          console.log("[explorer] worktree event:", msg.method, msg.params?.path);
          if (msg.params?.path) {
            const changedPath = msg.params.path;
            const parentPath = changedPath.replace(/\/[^/]+$/, "") || root;

            setChildCache((prev) => {
              const next = new Map(prev);
              // Remove the parent's cached children
              next.delete(parentPath);
              if (parentPath === root) {
                next.delete(root);
              }
              // If a directory was deleted, purge all descendant caches
              if (msg.method === "worktree-file-deleted") {
                for (const key of Array.from(next.keys())) {
                  if (key === changedPath || key.startsWith(changedPath + "/")) {
                    next.delete(key);
                  }
                }
              }
              return next;
            });

            // If a directory was deleted, collapse it
            if (msg.method === "worktree-file-deleted") {
              setExpandedDirs((prev) => {
                const next = new Set(prev);
                for (const key of Array.from(next)) {
                  if (key === changedPath || key.startsWith(changedPath + "/")) {
                    next.delete(key);
                  }
                }
                return next;
              });
            }

            // Reload the affected parent directory
            if (parentPath === root) {
              loadDir(root);
            } else {
              loadChildren(parentPath, true);
            }
          }
        }
      } catch {
        // Not JSON, ignore
      }
    };
    ws.onMessage(handleWorktreeEvent);
    return () => ws.offMessage(handleWorktreeEvent);
  }, [root]);

  useEffect(() => {
    loadDir(root);
  }, [root]);

  const loadDir = async (path: string) => {
    try {
      const result = await fsApi.readDir({ path });
      setEntries(sortEntries(result.entries));
    } catch (e) {
      console.error("Failed to read dir:", e);
    }
  };

  const loadChildren = async (path: string, force = false): Promise<FileEntry[]> => {
    if (!force && childCache.has(path)) {
      return childCache.get(path)!;
    }
    try {
      const result = await fsApi.readDir({ path });
      const sorted = sortEntries(result.entries);
      setChildCache((prev) => new Map(prev).set(path, sorted));
      return sorted;
    } catch (e) {
      console.error("Failed to expand:", e);
      return [];
    }
  };

  const toggleDir = async (path: string) => {
    const isExpanded = expandedDirs.has(path);
    if (isExpanded) {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      setExpandedDirs((prev) => new Set(prev).add(path));
      loadChildren(path);
    }
  };

  // ── Drag and Drop ──────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, entry: FileEntry) => {
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.setData("application/x-crow-ui-path", entry.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (isDir) {
      e.dataTransfer.dropEffect = "move";
      setDragOverPath(path);
    } else {
      // Can drop onto a file's parent
      const parent = path.replace(/\/[^/]+$/, "") || root;
      e.dataTransfer.dropEffect = "move";
      setDragOverPath(parent);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverPath(null);
  };

  const handleDrop = async (e: React.DragEvent, targetPath: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);

    // Get the dragged path (internal drag)
    const draggedPath = e.dataTransfer.getData("application/x-crow-ui-path") ||
                        e.dataTransfer.getData("text/plain");

    // Determine drop target directory
    let dropDir = targetPath;
    if (!isDir) {
      dropDir = targetPath.replace(/\/[^/]+$/, "") || root;
    }

    if (draggedPath && draggedPath !== dropDir && !dropDir.startsWith(draggedPath + "/")) {
      // Internal move
      const name = draggedPath.split("/").pop() || "";
      const newPath = `${dropDir}/${name}`;
      if (newPath !== draggedPath) {
        try {
          await fsApi.rename({ from: draggedPath, to: newPath });
          // Refresh both source and destination parents
          const srcParent = draggedPath.replace(/\/[^/]+$/, "") || root;
          setChildCache((prev) => {
            const next = new Map(prev);
            next.delete(srcParent);
            next.delete(dropDir);
            return next;
          });
          if (srcParent === root) loadDir(root);
          else loadChildren(srcParent, true);
          if (dropDir === root) loadDir(root);
          else loadChildren(dropDir, true);
        } catch (err: any) {
          alert(`Failed to move: ${err.message || err}`);
        }
      }
      return;
    }

    // External drop (files from OS)
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      for (const file of files) {
        try {
          const targetFilePath = `${dropDir}/${file.name}`;
          const content = await file.text();
          await fsApi.createFile({ path: targetFilePath, content });
        } catch (err: any) {
          console.error("Failed to drop file:", err);
        }
      }
      // Refresh destination
      setChildCache((prev) => {
        const next = new Map(prev);
        next.delete(dropDir);
        return next;
      });
      if (dropDir === root) loadDir(root);
      else loadChildren(dropDir, true);
    }
  };

  const handleRootDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);

    const draggedPath = e.dataTransfer.getData("application/x-crow-ui-path") ||
                        e.dataTransfer.getData("text/plain");

    if (draggedPath) {
      // Internal move to root
      const name = draggedPath.split("/").pop() || "";
      const newPath = `${root}/${name}`;
      if (newPath !== draggedPath) {
        try {
          await fsApi.rename({ from: draggedPath, to: newPath });
          const srcParent = draggedPath.replace(/\/[^/]+$/, "") || root;
          setChildCache((prev) => {
            const next = new Map(prev);
            next.delete(srcParent);
            next.delete(root);
            return next;
          });
          loadDir(root);
          if (srcParent !== root) loadChildren(srcParent, true);
        } catch (err: any) {
          alert(`Failed to move: ${err.message || err}`);
        }
      }
      return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      for (const file of files) {
        try {
          const targetFilePath = `${root}/${file.name}`;
          const content = await file.text();
          await fsApi.createFile({ path: targetFilePath, content });
        } catch (err: any) {
          console.error("Failed to drop file:", err);
        }
      }
      setChildCache((prev) => new Map(prev).set(root, []));
      loadDir(root);
    }
  };

  // ── Context menu handlers ──────────────────────────────────────────────

  const handleContextMenu = (
    e: React.MouseEvent,
    path: string,
    isDir: boolean,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetPath: path,
      targetIsDir: isDir,
    });
  };

  const handleRootContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetPath: root,
      targetIsDir: true,
    });
  };

  const handleNewFile = () => {
    if (!contextMenu) return;
    const parentPath = contextMenu.targetIsDir
      ? contextMenu.targetPath
      : contextMenu.targetPath.replace(/\/[^/]+$/, "");
    setCreatingParentPath(parentPath);
    setCreatingName("");
    setCreatingIsDir(false);
    setContextMenu(null);
  };

  const handleNewFolder = () => {
    if (!contextMenu) return;
    const parentPath = contextMenu.targetIsDir
      ? contextMenu.targetPath
      : contextMenu.targetPath.replace(/\/[^/]+$/, "");
    setCreatingParentPath(parentPath);
    setCreatingName("");
    setCreatingIsDir(true);
    setContextMenu(null);
  };

  const handleCreateSubmit = async () => {
    if (!creatingParentPath || !creatingName.trim()) {
      setCreatingParentPath(null);
      return;
    }
    const name = creatingName.trim();
    const parentPath = creatingParentPath;
    const isDir = creatingIsDir;
    const newPath = `${parentPath}/${name}`;

    setCreatingParentPath(null);
    setCreatingName("");

    try {
      if (isDir) {
        await fsApi.createDir({ path: newPath });
      } else {
        await fsApi.createFile({ path: newPath, content: "" });
      }
      // Expand the parent dir so we can see the new entry
      setExpandedDirs((prev) => new Set(prev).add(parentPath));
      setChildCache((prev) => {
        const next = new Map(prev);
        next.delete(parentPath);
        return next;
      });
      loadChildren(parentPath);
      // Open newly created files in the editor
      if (!isDir) {
        onFileClick(newPath, false);
      }
    } catch (e: any) {
      alert(
        `Failed to create ${isDir ? "directory" : "file"}: ${e.message || e}`,
      );
    }
  };

  const handleCreateCancel = () => {
    setCreatingParentPath(null);
    setCreatingName("");
  };

  const handleRename = () => {
    if (!contextMenu) return;
    const name = contextMenu.targetPath.split("/").pop() || "";
    setEditingPath(contextMenu.targetPath);
    setEditingName(name);
    setContextMenu(null);
  };

  const handleRenameSubmit = async () => {
    if (!editingPath || !editingName.trim()) {
      setEditingPath(null);
      return;
    }
    const parent = editingPath.replace(/\/[^/]+$/, "");
    const newPath = `${parent}/${editingName.trim()}`;
    if (newPath === editingPath) {
      setEditingPath(null);
      return;
    }
    try {
      await fsApi.rename({ from: editingPath, to: newPath });
      const parent = editingPath.replace(/\/[^/]+$/, "");
      setChildCache((prev) => {
        const next = new Map(prev);
        next.delete(parent);
        return next;
      });
      loadChildren(parent);
    } catch (e: any) {
      alert(`Failed to rename: ${e.message || e}`);
    } finally {
      setEditingPath(null);
    }
  };

  const handleRenameCancel = () => {
    setEditingPath(null);
  };

  const handleDelete = () => {
    if (!contextMenu) return;
    const name = contextMenu.targetPath.split("/").pop() || "";
    setDeletingPath(contextMenu.targetPath);
    setDeletingName(name);
    setContextMenu(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingPath) return;
    const path = deletingPath;
    const isDir = !deletingName.includes("."); // better heuristic: check if it's a dir
    setDeletingPath(null);
    setDeletingName("");
    try {
      await fsApi.remove({ path });
      if (isDir && expandedDirs.has(path)) {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
      const parent = path.replace(/\/[^/]+$/, "");
      setChildCache((prev) => {
        const next = new Map(prev);
        next.delete(parent);
        return next;
      });
      loadChildren(parent);
    } catch (e: any) {
      alert(`Failed to delete: ${e.message || e}`);
    }
  };

  const handleDeleteCancel = () => {
    setDeletingPath(null);
    setDeletingName("");
  };

  const handleCopyPath = async () => {
    if (!contextMenu) return;
    try {
      await navigator.clipboard.writeText(contextMenu.targetPath);
    } catch {
      // Fallback
    }
  };

  const handleCopyRelativePath = async () => {
    if (!contextMenu) return;
    const rel = contextMenu.targetPath.replace(root + "/", "");
    try {
      await navigator.clipboard.writeText(rel);
    } catch {
      // Fallback
    }
  };

  const handleRevealInSidebar = () => {
    if (!contextMenu) return;
    // Ensure all parent dirs are expanded
    const parts = contextMenu.targetPath.replace(root + "/", "").split("/");
    let current = root;
    const toExpand: string[] = [];
    for (const part of parts) {
      current = `${current}/${part}`;
      toExpand.push(current);
    }
    // Remove the last one (the target itself)
    toExpand.pop();
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const p of toExpand) next.add(p);
      return next;
    });
    // Load children for all expanded dirs
    for (const p of toExpand) {
      loadChildren(p);
    }
  };

  // When activeFile changes, expand parent dirs and scroll to it
  useEffect(() => {
    if (!activeFile || !activeFile.startsWith(root)) return;

    // Compute all parent directories that need to be expanded
    const rel = activeFile.replace(root + "/", "");
    const parts = rel.split("/");
    let current = root;
    const toExpand: string[] = [];
    // All parts except the last one (the file itself) are parent dirs
    for (let i = 0; i < parts.length - 1; i++) {
      current = `${current}/${parts[i]}`;
      toExpand.push(current);
    }

    // Expand all parents
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const p of toExpand) next.add(p);
      return next;
    });

    // Load children for all expanded dirs, then scroll
    (async () => {
      for (const p of toExpand) {
        await loadChildren(p);
      }
      // Give React time to render, then scroll
      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = document.querySelector(`[data-explorer-path="${CSS.escape(activeFile)}"]`);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
      });
    })();
  }, [activeFile, root]);

  // Focus rename input when editing starts
  useEffect(() => {
    if (editingPath && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [editingPath]);

  // Focus create input when creating starts
  useEffect(() => {
    if (creatingParentPath && createInputRef.current) {
      createInputRef.current.focus();
      createInputRef.current.select();
    }
  }, [creatingParentPath]);

  // ── Rendering ──────────────────────────────────────────────────────────

  /** Render the inline create input as a tree item */
  const renderCreateInput = (
    depth: number,
    key: string,
  ): React.ReactElement => (
    <div
      key={key}
      className="flex items-center gap-1.5 text-text-primary bg-hover rounded-sm"
      style={{
        paddingLeft: 8 + depth * 16,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        fontSize: treeFontSize,
        height: 28,
      }}
    >
      <span className="w-4 text-center text-[10px] text-text-secondary flex-shrink-0">
        {creatingIsDir ? "" : "📄"}
      </span>
      <input
        ref={createInputRef}
        value={creatingName}
        onChange={(e) => setCreatingName(e.target.value)}
        onBlur={handleCreateSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleCreateSubmit();
          if (e.key === "Escape") handleCreateCancel();
        }}
        onClick={(e) => e.stopPropagation()}
        placeholder={creatingIsDir ? "New folder name" : "New file name"}
        className="flex-1 bg-surface border border-border rounded-sm text-text-primary text-[13px] px-1 outline-none h-[18px]"
      />
    </div>
  );

  /** Render entries for a given parent path, with create input injected */
  const renderEntries = (
    parentPath: string,
    children: FileEntry[],
    depth: number,
  ): React.ReactElement[] => {
    const items: React.ReactElement[] = [];
    for (const child of children) {
      items.push(renderItem(child, depth));
      // If this child is the parent we're creating under, insert the create input after it
      if (
        creatingParentPath === child.path &&
        child.isDir &&
        expandedDirs.has(child.path)
      ) {
        items.push(renderCreateInput(depth + 1, `create-${child.path}`));
      }
    }
    // If creating at root level
    if (creatingParentPath === parentPath && depth === 0) {
      items.push(renderCreateInput(depth, `create-${parentPath}`));
    }
    return items;
  };

  const renderItem = (entry: FileEntry, depth: number): React.ReactElement => {
    const isEditing = editingPath === entry.path;
    const isDirty = !entry.isDir && dirtyFiles?.has(entry.path);
    const isActive = activeFile === entry.path;
    const isDragOver = dragOverPath === entry.path;

    return (
      <div key={entry.path} data-explorer-path={entry.path}>
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, entry)}
          onDragOver={(e) => handleDragOver(e, entry.path, entry.isDir)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, entry.path, entry.isDir)}
          onClick={() =>
            entry.isDir
              ? toggleDir(entry.path)
              : onFileClick(entry.path, false)
          }
          onContextMenu={(e) => handleContextMenu(e, entry.path, entry.isDir)}
          className={cn(
            "cursor-pointer flex items-center gap-1.5 hover:bg-hover rounded-sm transition-colors select-none",
            isActive && "bg-accent/15 text-accent",
            isDirty && !isActive && "text-primary font-medium",
            isDragOver && "bg-accent/20 border border-accent/30",
            !isActive && !isDirty && "text-text-primary",
          )}
          style={{
            paddingLeft: 8 + depth * 16,
            paddingRight: 8,
            paddingTop: 4,
            paddingBottom: 4,
            fontSize: treeFontSize,
            height: 28,
          }}
        >
          <span className="w-4 text-center text-[10px] text-text-secondary flex-shrink-0">
            {entry.isDir ? (expandedDirs.has(entry.path) ? "▾" : "▸") : "  "}
          </span>
          <FileIcon name={entry.name} isDir={entry.isDir} size={14} />
          {isEditing ? (
            <input
              ref={renameInputRef}
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSubmit();
                if (e.key === "Escape") handleRenameCancel();
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-surface border border-border rounded-sm text-text-primary text-[13px] px-1 outline-none h-[18px]"
            />
          ) : (
            <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">
              {entry.name}
            </span>
          )}
          {isDirty && <DirtyIndicator size="sm" />}
        </div>
        {entry.isDir &&
          expandedDirs.has(entry.path) &&
          childCache.has(entry.path) && (
            <div>
              {renderEntries(
                entry.path,
                childCache.get(entry.path)!,
                depth + 1,
              )}
            </div>
          )}
      </div>
    );
  };

  const contextMenuItems = contextMenu
    ? (() => {
        const isRoot = contextMenu.targetPath === root;
        return [
          { label: "New File...", action: handleNewFile },
          { label: "New Folder...", action: handleNewFolder },
          { separator: true } as const,
          ...(isRoot
            ? []
            : [
                { label: "Reveal in Sidebar", action: handleRevealInSidebar },
                { label: "Rename...", action: handleRename },
                { label: "Delete", action: handleDelete, danger: true },
                { separator: true } as const,
                { label: "Copy Path", action: handleCopyPath },
                { label: "Copy Relative Path", action: handleCopyRelativePath },
              ]),
        ];
      })()
    : [];

  return (
    <div
      className="h-full flex flex-col relative"
      style={{ backgroundColor: explorerBgRgba }}
      onContextMenu={handleRootContextMenu}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={handleRootDrop}
    >
      {/* File tree */}
      <div className="flex-1 overflow-auto pt-1">
        {renderEntries(root, entries, 0)}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      {deletingPath && (
        <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-destructive/15 border-t border-border flex items-center gap-2 text-sm text-text-primary z-10">
          <span className="text-destructive font-semibold">⚠ Delete</span>
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            "{deletingName}"
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDeleteCancel}
            className="h-6 text-[11px] px-2"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDeleteConfirm}
            className="h-6 text-[11px] px-2 font-semibold"
          >
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

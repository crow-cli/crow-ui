import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import { Copy, ClipboardPaste, Trash2, BoxSelect } from "lucide-react";
import { ws } from "../lib/ws-client";
import { terminalApi } from "../lib/rpc";
import { getTerminalTheme } from "../lib/themes";
import * as settings from "../lib/settings";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import "xterm/css/xterm.css";

interface TerminalPaneProps {
  workspaceRoot: string;
  /** Unique ID for this terminal instance — each tab gets its own PTY. */
  terminalId: string;
  /** If true, skip cleanup on unmount (for tile minimize/restore). */
  keepAlive?: boolean;
}

export default function TerminalPane({
  workspaceRoot,
  terminalId,
  keepAlive,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<number | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Cleanup on unmount OR terminalId change
  useEffect(() => {
    return () => {
      if (keepAlive) return;
      if (termIdRef.current !== null) {
        terminalApi.kill({ id: termIdRef.current }).catch(() => {});
        termIdRef.current = null;
      }
      terminalRef.current?.dispose();
      setInitialized(false);
    };
  }, [keepAlive, terminalId]);

  // Spawn terminal on mount or when terminalId changes
  useEffect(() => {
    if (!containerRef.current) return;
    // If already initialized for this terminalId, skip
    if (initialized) return;

    // Kill previous terminal if any
    if (termIdRef.current !== null) {
        terminalApi.kill({ id: termIdRef.current }).catch(() => {});
      termIdRef.current = null;
    }
    terminalRef.current?.dispose();
    setInitialized(false);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: settings.getSettings().terminal.fontSize ?? 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: getTerminalTheme(),
      scrollback: 10000,
      wordSeparator: " \t\r\n\"'`(){}[]<>|&;",

    });

    const fitAddon = new FitAddon();
    // WebLinksAddon removed due to v6 API change

    terminal.loadAddon(fitAddon);
    // terminal.loadAddon(webLinksAddon);


    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const { ctrlKey, metaKey, key, type } = event;
      if (type !== "keydown") return true;
      const modifier = ctrlKey || metaKey;
      if (!modifier) return true;

      switch (key) {
        case "c":
          if (terminal.hasSelection()) {
            event.preventDefault();
            navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
            return false;
          }
          return true;
        case "v":
          event.preventDefault();
          navigator.clipboard.readText().then((text) => terminal.paste(text)).catch(() => {});
          return false;
        case "a":
          event.preventDefault();
          terminal.selectAll();
          return false;
        case "l":
          event.preventDefault();
          terminal.clear();
          return false;
        case "k":
          return true;
        default:
          return true;
      }
    });

    terminal.open(containerRef.current!);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (
        termIdRef.current !== null &&
        containerRef.current &&
        containerRef.current.clientWidth > 0
      ) {
        const dims = fitAddon.proposeDimensions();
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
          if (resizeTimeout) clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            terminalApi.resize({
              id: termIdRef.current!,
              cols: dims.cols,
              rows: dims.rows,
            }).catch(() => {});
          }, 150);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    terminalApi
      .spawn({
        cwd: workspaceRoot,
        cols: 80,
        rows: 24,
        shell: null,
      })
      .then(({ id }) => {
        termIdRef.current = id;

        terminal.onData((data) => {
          terminalApi.write({ id, data }).catch(() => {});
        });

        setTimeout(() => fitAddon.fit(), 100);
      })
      .catch((e) => {
        terminal.writeln(`\x1b[31mFailed to spawn terminal: ${e}\x1b[0m`);
      });

    setInitialized(true);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
    };
  }, [workspaceRoot, terminalId]);



  // Live update terminal font size when settings change
  useEffect(() => {
    const unsubscribe = settings.subscribe(() => {
      const newSize = settings.getSettings().terminal.fontSize ?? 14;
      if (terminalRef.current) {
        terminalRef.current.options.fontSize = newSize;
        fitAddonRef.current?.fit();
      }
    });
    return unsubscribe;
  }, []);

  // Handle terminal events from server
  useEffect(() => {
    const unsubscribe = ws.onTerminalEvent((event) => {
      const term = terminalRef.current;
      if (!term) return;

      if (event.type === "data" && termIdRef.current === event.id) {
        term.write(event.data ?? "");
      } else if (event.type === "exit" && termIdRef.current === event.id) {
        term.writeln(
          `\x1b[33m[Process exited with code ${event.exitCode}]\x1b[0m`,
        );
        termIdRef.current = null;
      }
    });
    return unsubscribe;
  }, []);

  // Context menu actions
  const handleCopy = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal && terminal.hasSelection()) {
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
    }
  }, []);

  const handlePaste = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        terminal.paste(text);
      })
      .catch(() => {});
  }, []);

  const handleSelectAll = useCallback(() => {
    terminalRef.current?.selectAll();
  }, []);

  const handleClear = useCallback(() => {
    terminalRef.current?.clear();
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative h-full w-full">
          <div
            ref={containerRef}
            className="absolute inset-0 overflow-hidden bg-[var(--color-background-deeper)]"
          />
          {/* <div className="dot-overlay" /> */}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem
          onClick={handleCopy}
          disabled={!terminalRef.current?.hasSelection()}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
          <ContextMenuItem onClick={handleSelectAll}>
            <BoxSelect className="mr-2 h-4 w-4" />
            Select All
            <ContextMenuShortcut>⌘A</ContextMenuShortcut>
          </ContextMenuItem>
        <ContextMenuItem onClick={handleClear}>
          <Trash2 className="mr-2 h-4 w-4" />
          Clear
          <ContextMenuShortcut>⌘L</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

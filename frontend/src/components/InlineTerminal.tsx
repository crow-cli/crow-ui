/**
 * InlineTerminal — xterm.js terminal embedded in the chat panel.
 * Used when the agent uses the terminal/execute tool.
 *
 * The terminal is backed by a real PTY on the backend and streams
 * data via WebSocket events. Interactive — user can type into it.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import { Copy, ClipboardPaste, Trash2, BoxSelect } from "lucide-react";
import { ws } from "../lib/ws-client";
import * as acpStore from "../lib/acp-store";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import "xterm/css/xterm.css";

interface InlineTerminalProps {
  /** ACP terminal ID returned from createTerminal */
  terminalId: string;
  /** Command label to display (fallback if no cwd) */
  commandLabel: string;
  /** Working directory to display (overrides fetched cwd) */
  cwd?: string;
  /** Whether the terminal has exited */
  exited?: boolean;
  /** Exit code if exited */
  exitCode?: number;
  /** Session ID for routing ACP calls over /ws/acp */
  sessionId?: string;
}

import { getTerminalTheme } from "../lib/themes";

export default function InlineTerminal({
  terminalId,
  commandLabel,
  cwd: initialCwd,
  exited: initialExited,
  exitCode: initialExitCode,
  sessionId,
}: InlineTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const [status, setStatus] = useState<"running" | "exited">(
    initialExited ? "exited" : "running",
  );
  const [cwd, setCwd] = useState<string | undefined>(initialCwd);
  const exitCodeRef = useRef(initialExitCode ?? null);
  const terminalIdRef = useRef(terminalId);
  // Track output length from initial fetch to avoid re-writing in polling
  const lastOutputLengthRef = useRef(0);
  // Track status in a ref for use in polling callback
  const statusRef = useRef<"running" | "exited">(
    initialExited ? "exited" : "running",
  );

  // Keep terminalIdRef in sync
  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  // Route ACP terminal calls through the ACP client's /ws/acp connection
  const acpInvoke = useCallback(
    (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const client = sessionId ? acpStore.getClient(sessionId) : null;
      if (client) {
        return client.wsInvoke(method, params);
      }
      return ws.invoke(method, params);
    },
    [sessionId],
  );

  // Create xterm.js on mount
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: getTerminalTheme(),
      scrollback: 5000,
      convertEol: true,
      rows: 12,
      cols: 80,
      disableStdin: false, // Interactive terminal
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
        default:
          return true;
      }
    });

    terminal.open(containerRef.current!);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    initializedRef.current = true;

    // Always fetch current output on mount. For completed terminals this gets
    // everything. For running terminals this gets a snapshot, and incremental
    // updates arrive via polling below.
    acpInvoke("acp_terminal_output", { terminalId })
      .then((result: any) => {
        if (result?.output) {
          terminal.write(result.output);
          lastOutputLengthRef.current = result.output.length;
        }
        if (result?.cwd && !initialCwd) {
          setCwd(result.cwd);
        }
        if (result?.exitCode !== undefined) {
          exitCodeRef.current = result.exitCode;
          statusRef.current = "exited";
          setStatus("exited");
        }
      })
      .catch(() => {});

    // Wire stdin to backend
    terminal.onData((data) => {
      if (!ws.connected) return;
      acpInvoke("acp_terminal_write_input", {
        terminalId: terminalIdRef.current,
        data: data,
      }).catch(() => {});
    });

    // Wire resize to backend
    terminal.onResize((dimensions) => {
      if (!ws.connected) return;
      acpInvoke("acp_terminal_resize", {
        terminalId: terminalIdRef.current,
        cols: dimensions.cols,
        rows: dimensions.rows,
      }).catch(() => {});
    });

    return () => {
      terminal.dispose();
      initializedRef.current = false;
    };
  }, [terminalId]); // eslint-disable-line react-hooks/exhaustive-deps



  // Listen for ACP terminal exit events via WebSocket.
  // Data updates are handled by the initial fetch + periodic polling.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const wsEl = ws.ws;
    if (!wsEl) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        // Only handle exit events — data is fetched via polling
        if (
          msg.method === "acp-terminal-exit" &&
          msg.params?.terminalId === terminalId
        ) {
          statusRef.current = "exited";
          setStatus("exited");
          const code = msg.params.exitCode ?? -1;
          exitCodeRef.current = code;
        }
      } catch {
        // not JSON
      }
    };

    wsEl.addEventListener("message", handleMessage);

    return () => {
      wsEl.removeEventListener("message", handleMessage);
    };
  }, [terminalId]);

  // Poll for incremental output updates while terminal is running
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // Don't poll if terminal already exited
    if (initialExited) return;

    const pollInterval = setInterval(() => {
      if (statusRef.current === "exited") {
        clearInterval(pollInterval);
        return;
      }
      acpInvoke("acp_terminal_output", { terminalId })
        .then((result: any) => {
          const output = result?.output || "";
          // Only write new data (incremental)
          if (output.length > lastOutputLengthRef.current) {
            const newData = output.slice(lastOutputLengthRef.current);
            if (newData) {
              terminal.write(newData);
            }
            lastOutputLengthRef.current = output.length;
          }
          // Check if exited
          if (
            result?.exitCode !== undefined &&
            statusRef.current !== "exited"
          ) {
            exitCodeRef.current = result.exitCode;
            statusRef.current = "exited";
            setStatus("exited");
          }
        })
        .catch(() => {});
    }, 200);

    return () => clearInterval(pollInterval);
  }, [terminalId, initialExited, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle resize observer
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    observer.observe(containerRef.current);

    return () => observer.disconnect();
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

  const [copied, setCopied] = useState(false);
  const handleCopyCommand = () => {
    navigator.clipboard.writeText(commandLabel).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-background-deeper)] text-xs">
      <div className="flex items-center justify-between px-3 py-1 border-b border-[var(--color-border)] bg-[var(--color-background-dark)] gap-2">
        <span className="text-[11px] font-mono text-[var(--color-foreground)] break-all">
          <span className="text-[var(--color-primary)] font-bold">$</span>{" "}
          <span className="opacity-60">{commandLabel}</span>
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleCopyCommand}
            title="Copy command"
            className="p-0.5 rounded text-[10px] text-text-secondary hover:text-text-primary hover:bg-white/5 cursor-pointer border-none bg-transparent"
          >
            {copied ? "✓" : "⧉"}
          </button>
          {status === "exited" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--color-primary-faint)] text-[var(--color-primary)] font-semibold">
              {initialExitCode === 0 || exitCodeRef.current === 0
                ? "✓ exited 0"
                : `✗ exited ${initialExitCode ?? exitCodeRef.current ?? "?"}`}
            </span>
          )}
        </div>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className="h-48 min-h-[120px] overflow-hidden"
          />
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
    </div>
  );
}

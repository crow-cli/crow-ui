import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import { ws } from "../lib/ws-client";
import "xterm/css/xterm.css";

interface TerminalPaneProps {
  workspaceRoot: string;
  /** Unique ID for this terminal instance — each tab gets its own PTY. */
  terminalId: string;
  /** If true, skip cleanup on unmount (for tile minimize/restore). */
  keepAlive?: boolean;
}

// Terminal color theme (xterm.js only — not React styles)
const TERMINAL_THEME = {
  background: "#0d0a1a",
  foreground: "#d4c4ff",
  cursor: "#4ade80",
  cursorAccent: "#0d0a1a",
  selectionBackground: "#4ade8033",
  black: "#2d2350",
  red: "#ff6b8a",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e2e8f0",
  brightBlack: "#5a4d80",
  brightRed: "#ff8fa3",
  brightGreen: "#6ee7a0",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

export default function TerminalPane({ workspaceRoot, terminalId, keepAlive }: TerminalPaneProps) {
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
        ws.invoke("terminal_kill", { id: termIdRef.current }).catch(() => {});
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
      ws.invoke("terminal_kill", { id: termIdRef.current }).catch(() => {});
      termIdRef.current = null;
    }
    terminalRef.current?.dispose();
    setInitialized(false);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: TERMINAL_THEME,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(containerRef.current!);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (termIdRef.current !== null && containerRef.current && containerRef.current.clientWidth > 0) {
        const dims = fitAddon.proposeDimensions();
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
          ws.invoke("terminal_resize", {
            id: termIdRef.current,
            cols: dims.cols,
            rows: dims.rows,
          }).catch(() => {});
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    ws.invoke<{ id: number }>("terminal_spawn", {
      cwd: workspaceRoot,
      cols: 80,
      rows: 24,
    }).then(({ id }) => {
      termIdRef.current = id;

      terminal.onData((data) => {
        ws.invoke("terminal_write", { id, data }).catch(() => {});
      });

      setTimeout(() => fitAddon.fit(), 100);
    }).catch((e) => {
      terminal.writeln(`\x1b[31mFailed to spawn terminal: ${e}\x1b[0m`);
    });

    setInitialized(true);

    return () => {
      resizeObserver.disconnect();
    };
  }, [workspaceRoot, terminalId]);

  // Handle terminal events from server
  useEffect(() => {
    const unsubscribe = ws.onTerminalEvent((event) => {
      const term = terminalRef.current;
      if (!term) return;

      if (event.type === "data" && termIdRef.current === event.id) {
        term.write(event.data ?? "");
      } else if (event.type === "exit" && termIdRef.current === event.id) {
        term.writeln(`\x1b[33m[Process exited with code ${event.exitCode}]\x1b[0m`);
        termIdRef.current = null;
      }
    });
    return unsubscribe;
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-[var(--color-background-deeper)]"
    />
  );
}

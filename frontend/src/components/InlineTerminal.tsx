/**
 * InlineTerminal — xterm.js terminal embedded in the chat panel.
 * Used when the agent uses the terminal/execute tool.
 *
 * The terminal is backed by a real PTY on the backend and streams
 * data via WebSocket events. Interactive — user can type into it.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { ws } from "../lib/ws-client";
import "xterm/css/xterm.css";

interface InlineTerminalProps {
  /** ACP terminal ID returned from createTerminal */
  terminalId: string;
  /** Command label to display */
  commandLabel: string;
  /** Whether the terminal has exited */
  exited?: boolean;
  /** Exit code if exited */
  exitCode?: number;
}

// Terminal color theme (xterm.js only — not React styles)
const TERMINAL_THEME = {
  bg: "#0d0a1a",
  fg: "#d4c4ff",
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

export default function InlineTerminal({
  terminalId,
  commandLabel,
  exited: initialExited,
  exitCode: initialExitCode,
}: InlineTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const [status, setStatus] = useState<"running" | "exited">(
    initialExited ? "exited" : "running",
  );
  const exitCodeRef = useRef(initialExitCode ?? null);
  const terminalIdRef = useRef(terminalId);
  // Track output length from initial fetch to avoid re-writing in polling
  const lastOutputLengthRef = useRef(0);
  // Track status in a ref for use in polling callback
  const statusRef = useRef<"running" | "exited">(initialExited ? "exited" : "running");

  // Keep terminalIdRef in sync
  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  // Create xterm.js on mount
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: TERMINAL_THEME,
      scrollback: 5000,
      convertEol: true,
      rows: 12,
      cols: 80,
      disableStdin: false, // Interactive terminal
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current!);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    initializedRef.current = true;

    // Write the command label
    terminal.writeln(`\x1b[1;33m$ ${commandLabel}\x1b[0m`);
    terminal.writeln("");

    // Always fetch current output on mount. For completed terminals this gets
    // everything. For running terminals this gets a snapshot, and incremental
    // updates arrive via polling below.
    ws.invoke("acp_terminal_output", { terminalId })
      .then((result: any) => {
        if (result?.output) {
          terminal.write(result.output);
          lastOutputLengthRef.current = result.output.length;
        }
        if (result?.exitCode !== undefined) {
          exitCodeRef.current = result.exitCode;
          statusRef.current = "exited";
          setStatus("exited");
          terminal.writeln(
            `\r\n\x1b[33m[Process exited with code ${result.exitCode}]\x1b[0m`,
          );
        }
      })
      .catch(() => {});

    // Wire stdin to backend
    terminal.onData((data) => {
      if (!ws.connected) return;
      ws.invoke("acp_terminal_write_input", {
        terminalId: terminalIdRef.current,
        data: data,
      }).catch(() => {});
    });

    // Wire resize to backend
    terminal.onResize((dimensions) => {
      if (!ws.connected) return;
      ws.invoke("acp_terminal_resize", {
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
          terminal.writeln(
            `\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m`,
          );
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
      ws.invoke("acp_terminal_output", { terminalId })
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
          if (result?.exitCode !== undefined && statusRef.current !== "exited") {
            exitCodeRef.current = result.exitCode;
            statusRef.current = "exited";
            setStatus("exited");
            terminal.writeln(
              `\r\n\x1b[33m[Process exited with code ${result.exitCode}]\x1b[0m`,
            );
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

  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-background-deeper)] text-xs">
      <div className="flex items-center justify-between px-3 py-1 border-b border-[var(--color-border)] bg-[var(--color-background-dark)]">
        <span className="text-[11px] font-mono text-[var(--color-foreground)] whitespace-nowrap overflow-hidden text-ellipsis max-w-[80%]">
          <span className="text-[var(--color-primary)] font-bold">$</span> {commandLabel}
        </span>
        {status === "exited" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--color-primary-faint)] text-[var(--color-primary)] font-semibold flex-shrink-0">
            {initialExitCode === 0 || exitCodeRef.current === 0
              ? "✓ exited 0"
              : `✗ exited ${initialExitCode ?? exitCodeRef.current ?? "?"}`}
          </span>
        )}
      </div>
      <div ref={containerRef} className="h-48 min-h-[120px] overflow-hidden" />
    </div>
  );
}

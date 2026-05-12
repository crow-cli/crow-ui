/** Theme system — defines all visual tokens for the IDE.
 *
 * Themes are injected as CSS custom properties on :root at runtime.
 * Components reference them via var(--theme-*) or Tailwind arbitrary values.
 */

export interface ChatTheme {
  /** Chat pane background (hex or rgb) — applied behind dot overlay */
  background: string;
  /** Chat pane background opacity (0–1) */
  backgroundOpacity: number;
  /** Dot overlay dot color (rgba string or hex) */
  dotColor: string;
  /** User message bubble background */
  userBubbleBg: string;
  /** Agent message bubble background */
  agentBubbleBg: string;
  /** System/status message background */
  statusBg: string;
  /** Connection status: ready */
  statusReady: string;
  /** Connection status: disconnected */
  statusDisconnected: string;
  /** Connection status: error */
  statusError: string;
  /** Header bar background */
  headerBg: string;
  /** Input area background */
  inputBg: string;
}

export interface EditorTheme {
  /** Editor background (Monaco + React) */
  background: string;
  /** Current line highlight */
  lineHighlight: string;
  /** Selection background */
  selectionBg: string;
  /** Cursor color */
  cursor: string;
}

export interface TerminalTheme {
  /** Terminal background */
  background: string;
  /** Terminal foreground */
  foreground: string;
  /** ANSI black */
  black: string;
  /** ANSI red */
  red: string;
  /** ANSI green */
  green: string;
  /** ANSI yellow */
  yellow: string;
  /** ANSI blue */
  blue: string;
  /** ANSI magenta */
  magenta: string;
  /** ANSI cyan */
  cyan: string;
  /** ANSI white */
  white: string;
}

export interface SurfaceTheme {
  /** Body / app background */
  background: string;
  /** Panel surfaces (sidebar, bottom bar) */
  surface: string;
  /** Elevated surfaces (dropdowns, popovers) */
  elevated: string;
  /** Hover state background */
  hover: string;
  /** Border color */
  border: string;
  /** Primary accent (violet in purple-dark) */
  accent: string;
  /** Accent at low opacity */
  accentFaint: string;
  /** Focus ring */
  ring: string;
  /** Destructive/error */
  destructive: string;
  /** Success */
  success: string;
  /** Warning */
  warning: string;
  /** Info */
  info: string;
}

export interface TextTheme {
  /** Primary text */
  primary: string;
  /** Secondary text */
  secondary: string;
  /** Tertiary / muted text */
  tertiary: string;
  /** Accent text (headings, active) */
  accent: string;
  /** Inverse text on accent backgrounds */
  inverse: string;
}

export interface IdeTheme {
  name: string;
  kind: "dark" | "light" | "hc";
  surface: SurfaceTheme;
  text: TextTheme;
  chat: ChatTheme;
  editor: EditorTheme;
  terminal: TerminalTheme;
}

// ─── Purple Dark (current default) ──────────────────────────────────────────

export const purpleDark: IdeTheme = {
  name: "Purple Dark",
  kind: "dark",
  surface: {
    background: "#09090b",
    surface: "#222244",
    elevated: "#27272a",
    hover: "#27272a",
    border: "rgba(255, 255, 255, 0.08)",
    accent: "#8b5cf6",
    accentFaint: "rgba(139, 92, 246, 0.15)",
    ring: "#a78bfa",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    info: "#3b82f6",
  },
  text: {
    primary: "#d4d4d8",
    secondary: "#a1a1aa",
    tertiary: "#71717a",
    accent: "#ffffff",
    inverse: "#ffffff",
  },
  chat: {
    background: "#222244",
    backgroundOpacity: 0.85,
    dotColor: "rgba(139, 92, 246, 0.15)",
    userBubbleBg: "rgba(139, 92, 246, 0.10)",
    agentBubbleBg: "rgba(139, 92, 246, 0.05)",
    statusBg: "rgba(139, 92, 246, 0.08)",
    statusReady: "#22c55e",
    statusDisconnected: "#ef4444",
    statusError: "#ef4444",
    headerBg: "rgba(9, 9, 11, 0.40)",
    inputBg: "rgba(39, 39, 42, 0.30)",
  },
  editor: {
    background: "#09090b",
    lineHighlight: "#2d2350",
    selectionBg: "#4c3a6e",
    cursor: "#a78bfa",
  },
  terminal: {
    background: "#09090b",
    foreground: "#d4d4d8",
    black: "#09090b",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#d946ef",
    cyan: "#06b6d4",
    white: "#d4d4d8",
  },
};

// ─── Ocean Dark (alternative) ───────────────────────────────────────────────

export const oceanDark: IdeTheme = {
  name: "Ocean Dark",
  kind: "dark",
  surface: {
    background: "#0a0f1a",
    surface: "#111827",
    elevated: "#1f2937",
    hover: "#1f2937",
    border: "rgba(148, 163, 184, 0.12)",
    accent: "#0ea5e9",
    accentFaint: "rgba(14, 165, 233, 0.15)",
    ring: "#38bdf8",
    destructive: "#f87171",
    success: "#34d399",
    warning: "#fbbf24",
    info: "#60a5fa",
  },
  text: {
    primary: "#e2e8f0",
    secondary: "#94a3b8",
    tertiary: "#64748b",
    accent: "#f0f9ff",
    inverse: "#ffffff",
  },
  chat: {
    background: "#111827",
    backgroundOpacity: 0.9,
    dotColor: "rgba(14, 165, 233, 0.12)",
    userBubbleBg: "rgba(14, 165, 233, 0.10)",
    agentBubbleBg: "rgba(14, 165, 233, 0.05)",
    statusBg: "rgba(14, 165, 233, 0.08)",
    statusReady: "#34d399",
    statusDisconnected: "#f87171",
    statusError: "#f87171",
    headerBg: "rgba(10, 15, 26, 0.50)",
    inputBg: "rgba(31, 41, 55, 0.40)",
  },
  editor: {
    background: "#0a0f1a",
    lineHighlight: "#1e293b",
    selectionBg: "#334155",
    cursor: "#38bdf8",
  },
  terminal: {
    background: "#0a0f1a",
    foreground: "#e2e8f0",
    black: "#0a0f1a",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#e879f9",
    cyan: "#22d3ee",
    white: "#e2e8f0",
  },
};

// ─── Theme Registry ─────────────────────────────────────────────────────────

const THEMES: Record<string, IdeTheme> = {
  "purple-dark": purpleDark,
  "ocean-dark": oceanDark,
};

export function getTheme(name: string): IdeTheme {
  return THEMES[name] ?? purpleDark;
}

export function listThemes(): string[] {
  return Object.keys(THEMES);
}

// ─── CSS Injection ──────────────────────────────────────────────────────────

/** Generate CSS custom properties from a theme and inject into :root */
export function injectTheme(theme: IdeTheme): void {
  const css = themeToCss(theme);
  let style = document.getElementById("ide-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "ide-theme";
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function themeToCss(theme: IdeTheme): string {
  const t = theme;
  return `
:root {
  /* Surface */
  --theme-background: ${t.surface.background};
  --theme-surface: ${t.surface.surface};
  --theme-elevated: ${t.surface.elevated};
  --theme-hover: ${t.surface.hover};
  --theme-border: ${t.surface.border};
  --theme-accent: ${t.surface.accent};
  --theme-accent-faint: ${t.surface.accentFaint};
  --theme-ring: ${t.surface.ring};
  --theme-destructive: ${t.surface.destructive};
  --theme-success: ${t.surface.success};
  --theme-warning: ${t.surface.warning};
  --theme-info: ${t.surface.info};

  /* Text */
  --theme-text-primary: ${t.text.primary};
  --theme-text-secondary: ${t.text.secondary};
  --theme-text-tertiary: ${t.text.tertiary};
  --theme-text-accent: ${t.text.accent};
  --theme-text-inverse: ${t.text.inverse};

  /* Chat */
  --theme-chat-bg: ${t.chat.background};
  --theme-chat-bg-opacity: ${t.chat.backgroundOpacity};
  --theme-chat-dot-color: ${t.chat.dotColor};
  --theme-chat-user-bubble: ${t.chat.userBubbleBg};
  --theme-chat-agent-bubble: ${t.chat.agentBubbleBg};
  --theme-chat-status-bg: ${t.chat.statusBg};
  --theme-chat-status-ready: ${t.chat.statusReady};
  --theme-chat-status-disconnected: ${t.chat.statusDisconnected};
  --theme-chat-status-error: ${t.chat.statusError};
  --theme-chat-header-bg: ${t.chat.headerBg};
  --theme-chat-input-bg: ${t.chat.inputBg};

  /* Editor */
  --theme-editor-bg: ${t.editor.background};
  --theme-editor-line-highlight: ${t.editor.lineHighlight};
  --theme-editor-selection: ${t.editor.selectionBg};
  --theme-editor-cursor: ${t.editor.cursor};

  /* Terminal */
  --theme-terminal-bg: ${t.terminal.background};
  --theme-terminal-fg: ${t.terminal.foreground};
  --theme-terminal-black: ${t.terminal.black};
  --theme-terminal-red: ${t.terminal.red};
  --theme-terminal-green: ${t.terminal.green};
  --theme-terminal-yellow: ${t.terminal.yellow};
  --theme-terminal-blue: ${t.terminal.blue};
  --theme-terminal-magenta: ${t.terminal.magenta};
  --theme-terminal-cyan: ${t.terminal.cyan};
  --theme-terminal-white: ${t.terminal.white};
}
`;
}

// ─── Runtime CSS Variable Helpers ───────────────────────────────────────────

/** Read a CSS custom property from :root */
export function getThemeVar(name: string, fallback: string = ""): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Build a Monaco editor theme object from current CSS variables */
export function getMonacoThemeColors(): Record<string, string> {
  const bg = getThemeVar("--theme-editor-bg", "#09090b");
  const text = getThemeVar("--theme-text-primary", "#d4d4d8");
  const lineHighlight = getThemeVar("--theme-editor-line-highlight", "#2d2350");
  const selection = getThemeVar("--theme-editor-selection", "#4c3a6e");
  const cursor = getThemeVar("--theme-editor-cursor", "#a78bfa");
  const accent = getThemeVar("--theme-accent", "#8b5cf6");
  const surface = getThemeVar("--theme-surface", "#222244");
  const elevated = getThemeVar("--theme-elevated", "#27272a");

  return {
    "editor.background": bg,
    "editor.foreground": text,
    "editor.lineHighlightBackground": lineHighlight,
    "editor.selectionBackground": selection + "88",
    "editorCursor.foreground": cursor,
    "editorLineNumber.foreground": surface,
    "editorLineNumber.activeForeground": text,
    "editorIndentGuide.background": lineHighlight,
    "editorIndentGuide.activeBackground": selection,
    "editorBracketMatch.background": accent + "22",
    "editorBracketMatch.border": accent,
    "editorWidget.background": bg,
    "editorWidget.border": lineHighlight,
    "input.background": elevated,
    "input.border": lineHighlight,
    "input.foreground": text,
    "list.hoverBackground": lineHighlight,
    "list.focusBackground": selection,
    "scrollbarSlider.background": surface + "44",
    "scrollbarSlider.hoverBackground": surface + "88",
  };
}

/** Build an xterm.js theme object from current CSS variables */
export function getTerminalTheme(): Record<string, string> {
  const bg = getThemeVar("--theme-terminal-bg", "#09090b");
  const fg = getThemeVar("--theme-terminal-fg", "#d4d4d8");
  const accent = getThemeVar("--theme-accent", "#8b5cf6");
  const cursor = getThemeVar("--theme-editor-cursor", "#a78bfa");
  const destructive = getThemeVar("--theme-destructive", "#ef4444");
  const success = getThemeVar("--theme-success", "#22c55e");
  const warning = getThemeVar("--theme-warning", "#eab308");
  const info = getThemeVar("--theme-info", "#3b82f6");
  const surface = getThemeVar("--theme-surface", "#222244");
  const text = getThemeVar("--theme-text-primary", "#d4d4d8");

  return {
    background: bg,
    foreground: fg,
    cursor: cursor,
    cursorAccent: bg,
    selectionBackground: accent + "33",
    black: bg,
    red: destructive,
    green: success,
    yellow: warning,
    blue: info,
    magenta: accent,
    cyan: getThemeVar("--theme-terminal-cyan", "#06b6d4"),
    white: text,
    brightBlack: surface,
    brightRed: destructive,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: info,
    brightMagenta: accent,
    brightCyan: getThemeVar("--theme-terminal-cyan", "#06b6d4"),
    brightWhite: text,
  };
}

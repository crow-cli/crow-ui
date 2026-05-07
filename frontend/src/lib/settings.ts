/**
 * IDE Settings — loaded from global `~/.crow/murder.json`
 * Supports JSONC (JSON with comments, trailing commas).
 * Auto-writes defaults on first run if file doesn't exist.
 */

import { ws } from "./ws-client";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EditorSettings {
  fontSize: number;
  wordWrap: "on" | "off" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  renderWhitespace: "none" | "selection" | "boundary" | "trailing" | "all";
  tabSize: number;
  insertSpaces: boolean;
  fontFamily: string;
}

export interface LanguageSettings {
  [languageId: string]: Partial<EditorSettings>;
}

export interface IntellisenseSettings {
  enabled: boolean;
  suggestOnTriggerCharacters: boolean;
  wordBasedSuggestions: boolean;
  parameterHints: boolean;
  showSnippets: boolean;
  disabledLanguages: string[];
  noQuickSuggestionsLanguages: string[];
}

export interface TerminalSettings {
  shell: string;
  fontSize: number;
}

export interface ExplorerSettings {
  /** Show hidden files/directories (dotfiles) in the workspace tree */
  showHiddenFiles: boolean;
}

export interface FolderPickerSettings {
  /** Show hidden files/directories (dotfiles) when picking a folder */
  showHiddenFiles: boolean;
}

export interface IdeSettings {
  editor: EditorSettings;
  languages: LanguageSettings;
  intellisense: IntellisenseSettings;
  terminal: TerminalSettings;
  explorer: ExplorerSettings;
  folderPicker: FolderPickerSettings;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: IdeSettings = {
  editor: {
    fontSize: 14,
    wordWrap: "on",
    minimap: true,
    renderWhitespace: "selection",
    tabSize: 4,
    insertSpaces: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  },
  languages: {
    markdown: {
      wordWrap: "on",
      renderWhitespace: "all",
    },
  },
  intellisense: {
    enabled: true,
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: true,
    parameterHints: true,
    showSnippets: true,
    disabledLanguages: ["plaintext"],
    noQuickSuggestionsLanguages: [
      "markdown",
      "plaintext",
      "log",
      "shellscript",
      "powershell",
    ],
  },
  terminal: {
    shell: "",
    fontSize: 13,
  },
  explorer: {
    showHiddenFiles: true,
  },
  folderPicker: {
    showHiddenFiles: false,
  },
};

// ─── State ──────────────────────────────────────────────────────────────────

let current: IdeSettings = structuredClone(DEFAULT_SETTINGS);
let configPath: string | null = null;
const listeners = new Set<() => void>();

export function getSettings(): IdeSettings {
  return current;
}

function deepMerge(
  base: IdeSettings,
  partial: Partial<IdeSettings>,
): IdeSettings {
  const merged = structuredClone(base);
  for (const key of Object.keys(partial) as (keyof IdeSettings)[]) {
    const val = partial[key];
    if (val !== undefined) {
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        typeof base[key] === "object" &&
        !Array.isArray(base[key])
      ) {
        merged[key] = { ...(base[key] as object), ...val } as any;
      } else {
        merged[key] = val as any;
      }
    }
  }
  return merged;
}

function stripJsonc(text: string): string {
  return text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function getDefaultJson(): string {
  const {
    editor,
    languages,
    intellisense,
    terminal,
    explorer,
    folderPicker,
  } = current;
  const toSave = {
    editor,
    languages,
    intellisense,
    terminal,
    explorer,
    folderPicker,
  };
  return `// Murder IDE Settings — global config (~/.crow/murder.json)\n// JSONC format — comments and trailing commas supported\n\n${JSON.stringify(toSave, null, 2)}\n`;
}

/** Load settings, auto-write defaults if file doesn't exist */
export async function loadSettings(): Promise<void> {
  try {
    const pathResult = await ws.invoke<{ path: string }>("get_config_path", {});
    configPath = pathResult.path;
  } catch {
    configPath = null;
    current = structuredClone(DEFAULT_SETTINGS);
    for (const fn of listeners) fn();
    return;
  }

  if (!configPath) {
    current = structuredClone(DEFAULT_SETTINGS);
    for (const fn of listeners) fn();
    return;
  }

  try {
    const result = await ws.invoke<{ content?: string }>("read_file", {
      path: configPath,
    });
    if (result.content && result.content.trim()) {
      const parsed = JSON.parse(
        stripJsonc(result.content),
      ) as Partial<IdeSettings>;
      current = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
    } else {
      // File exists but is empty — write defaults
      current = structuredClone(DEFAULT_SETTINGS);
      await _writeSettings();
    }
  } catch {
    // File doesn't exist — write defaults
    current = structuredClone(DEFAULT_SETTINGS);
    await _writeSettings();
  }
  for (const fn of listeners) fn();
}

async function _writeSettings(): Promise<void> {
  if (!configPath) return;
  const jsonc = getDefaultJson();
  try {
    await ws.invoke("write_file", { path: configPath, content: jsonc });
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

/** Save current settings to disk */
export async function saveSettings(): Promise<void> {
  await _writeSettings();
}

/** Update a nested setting and persist immediately */
export async function updateSetting(
  section: keyof IdeSettings,
  key: string,
  value: unknown,
): Promise<void> {
  const sec = current[section] as Record<string, unknown>;
  if (sec) sec[key] = value;
  await _writeSettings();
  for (const fn of listeners) fn();
}

/** Add a directory to recently opened — delegates to backend SQLite */
export async function addRecentlyOpened(dir: string): Promise<void> {
  try {
    await ws.invoke("add_recent_workspace", { path: dir });
  } catch (e) {
    console.error("Failed to add recent workspace:", e);
  }
}

/** Get recently opened workspaces from backend SQLite */
export async function getRecentWorkspaces(limit = 10): Promise<string[]> {
  try {
    const entries = await ws.invoke<Array<{ path: string }>>(
      "get_recent_workspaces",
      { limit },
    );
    return entries.map((e) => e.path);
  } catch (e) {
    console.error("Failed to get recent workspaces:", e);
    return [];
  }
}

/** Clear recently opened list — delegates to backend SQLite */
export async function clearRecentlyOpened(): Promise<void> {
  // Not yet wired — would need a backend handler
  console.warn("clearRecentlyOpened not yet implemented for SQLite backend");
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isIntellisenseDisabled(languageId: string): boolean {
  if (!current.intellisense.enabled) return true;
  return current.intellisense.disabledLanguages.includes(languageId);
}

export function getIntellisenseOptions(languageId: string) {
  const s = current.intellisense;
  const disabled = isIntellisenseDisabled(languageId);
  const noQuickSuggestions = s.noQuickSuggestionsLanguages.includes(languageId);
  return {
    enabled: !disabled,
    suggestOnTriggerCharacters: s.suggestOnTriggerCharacters && !disabled,
    wordBasedSuggestions: disabled
      ? "off"
      : s.wordBasedSuggestions
        ? "currentDocument"
        : "off",
    parameterHintsEnabled: s.parameterHints && !disabled,
    snippetsPreventQuickSuggestions: !s.showSnippets,
    noQuickSuggestions,
  };
}

export function getConfigPath(): string | null {
  return configPath;
}

export function getLanguageOverrides(
  languageId: string,
): Partial<EditorSettings> {
  return current.languages[languageId] || {};
}

export async function resetSettings(): Promise<void> {
  current = structuredClone(DEFAULT_SETTINGS);
  await _writeSettings();
  for (const fn of listeners) fn();
}

/**
 * IDE Settings — backend-driven via WebSocket APIs.
 *
 * All settings are stored server-side in ~/.crow/crow-ui-settings.json
 * and fetched via `get_all_settings` / `get_setting` / `update_setting`.
 * The frontend caches the resolved nested object and listens for
 * `settings-changed` broadcasts to stay in sync.
 */

import { ws } from "./ws-client";
import { settingsApi, workspaceApi } from "./rpc";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EditorSettings {
  fontSize: number;
  wordWrap: "on" | "off" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  renderWhitespace: "none" | "selection" | "boundary" | "trailing" | "all";
  tabSize: number;
  insertSpaces: boolean;
  fontFamily: string;
  lineNumbers: "on" | "off" | "relative" | "interval";
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
    lineNumbers: "on",
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

let cache: IdeSettings | null = null;
const listeners = new Set<() => void>();
let unsubscribeWs: (() => void) | null = null;

function deepMerge(
  base: IdeSettings,
  partial: Record<string, unknown>,
): IdeSettings {
  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  for (const key of Object.keys(partial)) {
    const val = partial[key];
    if (val !== undefined) {
      const existing = merged[key];
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        merged[key] = deepMerge(
          existing as IdeSettings,
          val as Record<string, unknown>,
        );
      } else {
        merged[key] = val;
      }
    }
  }
  return merged as unknown as IdeSettings;
}

function getFromPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc: unknown, part) => {
    if (acc && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

/** Notify all subscribers */
function notify() {
  for (const fn of listeners) fn();
}

/** Initialize settings system: load from backend + subscribe to changes */
export async function initSettings(): Promise<void> {
  await loadSettings();

  if (unsubscribeWs) unsubscribeWs();
  unsubscribeWs = ws.onSettingsChange((key) => {
    // Invalidate cache and reload so all consumers see the new value
    cache = null;
    loadSettings().catch((e) =>
      console.warn("[settings] reload after change failed:", e),
    );
    notify();
  });
}

/** Load all resolved settings from backend into local cache */
export async function loadSettings(): Promise<void> {
  try {
    const { settings } = await settingsApi.getAll();
    cache = deepMerge(structuredClone(DEFAULT_SETTINGS), settings as Record<string, unknown>);
  } catch (e) {
    console.warn("[settings] loadSettings failed, using defaults:", e);
    cache = structuredClone(DEFAULT_SETTINGS);
  }
  notify();
}

/** Get the full resolved settings object (from cache) */
export function getSettings(): IdeSettings {
  if (!cache) {
    console.warn(
      "[settings] getSettings called before load — returning defaults",
    );
    return structuredClone(DEFAULT_SETTINGS);
  }
  return cache;
}

/** Get a single setting value by dot-notation key from the backend.
 *  Falls back to `defaultValue` if the key is not set.
 */
export async function getSetting<T>(
  key: string,
  defaultValue?: T,
): Promise<T | undefined> {
  try {
    const { value } = await settingsApi.get({ key });
    return value !== null && value !== undefined
      ? (value as T)
      : defaultValue;
  } catch (e) {
    console.warn(`[settings] getSetting("${key}") failed:`, e);
    return defaultValue;
  }
}

/** Update a single setting by dot-notation key via the backend.
 *  The backend persists to disk and broadcasts `settings-changed`.
 */
export async function updateSetting(
  key: string,
  value: unknown,
): Promise<void> {
  try {
    await settingsApi.update({ key, value: value as any });
  } catch (e) {
    console.error(`[settings] updateSetting("${key}") failed:`, e);
    throw e;
  }
}

/** Update a nested setting in the local cache and persist via backend.
 *  Automatically converts section+key to dot-notation.
 */
export async function updateLocalSetting(
  section: keyof IdeSettings,
  key: string,
  value: unknown,
): Promise<void> {
  const dotKey = `${section}.${key}`;
  await updateSetting(dotKey, value);

  // Optimistically update cache
  if (cache) {
    const sec = cache[section] as Record<string, unknown>;
    if (sec) sec[key] = value;
    notify();
  }
}

/** Add a directory to recently opened — delegates to backend SQLite */
export async function addRecentlyOpened(dir: string): Promise<void> {
  try {
    await workspaceApi.addRecent({ path: dir });
  } catch (e) {
    console.error("Failed to add recent workspace:", e);
  }
}

/** Get recently opened workspaces from backend SQLite */
async function getRecentWorkspaces(limit = 10): Promise<string[]> {
  try {
    const { entries } = await workspaceApi.getRecent({ limit });
    return entries.map((e) => e.path);
  } catch (e) {
    console.error("Failed to get recent workspaces:", e);
    return [];
  }
}

/** Clear recently opened list — delegates to backend SQLite */
async function clearRecentlyOpened(): Promise<void> {
  console.warn("clearRecentlyOpened not yet implemented for SQLite backend");
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function isIntellisenseDisabled(languageId: string): boolean {
  const s = getSettings().intellisense;
  if (!s.enabled) return true;
  return s.disabledLanguages.includes(languageId);
}

export function getIntellisenseOptions(languageId: string) {
  const s = getSettings().intellisense;
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
  return null; // No longer managed by frontend
}

function getLanguageOverrides(
  languageId: string,
): Partial<EditorSettings> {
  return getSettings().languages[languageId] || {};
}

export async function resetSettings(): Promise<void> {
  // TODO: backend doesn't have a reset endpoint yet;
  // for now clear user layer by setting each default key
  const defaults = DEFAULT_SETTINGS;
  for (const [section, values] of Object.entries(defaults)) {
    for (const [key, value] of Object.entries(values as object)) {
      await updateSetting(`${section}.${key}`, value);
    }
  }
}

async function saveSettings(): Promise<void> {
  // No-op — backend persists automatically on updateSetting
}

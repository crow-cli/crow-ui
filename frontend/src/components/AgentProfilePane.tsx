import { useState, useEffect, useRef, useCallback } from "react";
import * as monaco from "monaco-editor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { agentProfileApi } from "../lib/agent-profiles";
import { registerMonacoLanguages } from "../lib/monaco-languages";
import { getMonacoThemeColors } from "../lib/themes";
import * as settings from "../lib/settings";

const DEFAULT_PROMPT = `{# Agent system prompt template — Jinja2 syntax #}
You are a helpful AI coding assistant.
`;

interface AgentProfilePaneProps {
  isActive?: boolean;
  onSpawn?: (profileName: string) => void;
}

export default function AgentProfilePane({ isActive, onSpawn }: AgentProfilePaneProps) {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [profileName, setProfileName] = useState<string>("");
  const [maxRetries, setMaxRetries] = useState<number>(3);
  const [maxCompactTokens, setMaxCompactTokens] = useState<number>(190_000);
  const [promptContent, setPromptContent] = useState<string>(DEFAULT_PROMPT);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const suppressChangeRef = useRef(false);

  // Register Jinja2 language once
  useEffect(() => {
    registerMonacoLanguages();
  }, []);

  // Load profile list on mount
  useEffect(() => {
    loadProfiles();
  }, []);

  // Init Monaco editor
  useEffect(() => {
    if (!containerRef.current) return;

    monaco.editor.defineTheme("crow-ui-dynamic", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: getMonacoThemeColors(),
    });

    const editor = monaco.editor.create(containerRef.current, {
      value: DEFAULT_PROMPT,
      language: "jinja2",
      theme: "crow-ui-dynamic",
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      lineNumbers: "on",
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      scrollBeyondLastLine: false,
      smoothScrolling: false,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "off",
      cursorStyle: "line",
      cursorWidth: 2,
      links: true,
      folding: true,
      foldingStrategy: "indentation",
      stickyScroll: { enabled: false },
      padding: { top: 8, bottom: 8 },
      suggest: {
        showStatusBar: true,
      },
      quickSuggestions: false,
      wordBasedSuggestions: "off",
      acceptSuggestionOnEnter: "off",
      acceptSuggestionOnCommitCharacter: false,
      suggestOnTriggerCharacters: false,
      tabCompletion: "off",
      parameterHints: { enabled: false },
    });

    editorRef.current = editor;

    // Track changes
    const disposable = editor.onDidChangeModelContent(() => {
      if (!suppressChangeRef.current) {
        setPromptContent(editor.getValue());
        setIsDirty(true);
      }
    });

    // Register Ctrl+S
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave();
    });

    return () => {
      disposable.dispose();
      editor.dispose();
    };
  }, []);

  // Visibility repaint
  useEffect(() => {
    if (isActive && editorRef.current) {
      const id = setTimeout(() => editorRef.current?.layout(), 50);
      return () => clearTimeout(id);
    }
  }, [isActive]);

  // Live font-size updates
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const initial = settings.getSettings().editor.fontSize;
    editor.updateOptions({ fontSize: initial });

    const unsubscribe = settings.subscribe(() => {
      const size = settings.getSettings().editor.fontSize;
      editor.updateOptions({ fontSize: size });
    });

    return unsubscribe;
  }, []);

  const loadProfiles = async () => {
    try {
      const resp = await agentProfileApi.list();
      setProfiles(resp.profiles);
    } catch (e) {
      console.error("[AgentProfilePane] failed to list profiles:", e);
    }
  };

  const loadProfile = async (name: string) => {
    if (!name) return;
    setIsLoading(true);
    try {
      const resp = await agentProfileApi.get({ name });
      setProfileName(resp.name);
      setMaxRetries(resp.maxRetriesPerStep);
      setMaxCompactTokens(resp.maxCompactTokens);
      suppressChangeRef.current = true;
      editorRef.current?.setValue(resp.prompt || DEFAULT_PROMPT);
      suppressChangeRef.current = false;
      setPromptContent(resp.prompt || DEFAULT_PROMPT);
      setIsDirty(false);
    } catch (e) {
      console.error("[AgentProfilePane] failed to load profile:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    const name = profileName.trim();
    if (!name) {
      alert("Profile name is required");
      return;
    }

    try {
      await agentProfileApi.save({
        name,
        maxRetriesPerStep: maxRetries,
        maxCompactTokens,
        prompt: promptContent,
      });
      setIsDirty(false);
      await loadProfiles();
      setSelectedProfile(name);
    } catch (e) {
      console.error("[AgentProfilePane] failed to save profile:", e);
      alert("Failed to save profile");
    }
  };

  const handleNew = () => {
    setSelectedProfile("");
    setProfileName("");
    setMaxRetries(3);
    setMaxCompactTokens(190_000);
    suppressChangeRef.current = true;
    editorRef.current?.setValue(DEFAULT_PROMPT);
    suppressChangeRef.current = false;
    setPromptContent(DEFAULT_PROMPT);
    setIsDirty(false);
  };

  const handleDelete = async () => {
    const name = profileName.trim();
    if (!name) return;
    if (!confirm(`Delete profile "${name}"?`)) return;

    try {
      await agentProfileApi.delete({ name });
      await loadProfiles();
      handleNew();
    } catch (e) {
      console.error("[AgentProfilePane] failed to delete profile:", e);
      alert("Failed to delete profile");
    }
  };

  const handleSpawn = () => {
    const name = profileName.trim();
    if (!name) {
      alert("Select or create a profile first");
      return;
    }
    onSpawn?.(name);
  };

  const onSelectProfile = (value: string) => {
    if (value === "__new__") {
      handleNew();
      return;
    }
    setSelectedProfile(value);
    loadProfile(value);
  };

  const updateMaxRetries = (v: string) => {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n >= 0) {
      setMaxRetries(n);
      setIsDirty(true);
    }
  };

  const updateMaxCompactTokens = (v: string) => {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n >= 0) {
      setMaxCompactTokens(n);
      setIsDirty(true);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#1a1a2e]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2a2a40]">
        <Select value={selectedProfile} onValueChange={onSelectProfile}>
          <SelectTrigger className="w-48 bg-[#2a2a40] border-[#3a3a55] text-white">
            <SelectValue placeholder="Select profile..." />
          </SelectTrigger>
          <SelectContent className="bg-[#2a2a40] border-[#3a3a55]">
            <SelectItem value="__new__" className="text-white hover:bg-[#3a3a55]">
              + New profile
            </SelectItem>
            {profiles.map((p) => (
              <SelectItem key={p} value={p} className="text-white hover:bg-[#3a3a55]">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={profileName}
          onChange={(e) => { setProfileName(e.target.value); setIsDirty(true); }}
          placeholder="Profile name"
          className="w-40 bg-[#2a2a40] border-[#3a3a55] text-white"
        />

        <Button
          onClick={handleSave}
          disabled={!isDirty || isLoading}
          className="bg-[#4D21FC] hover:bg-[#5a2fff] text-white"
        >
          Save
        </Button>

        <Button
          onClick={handleNew}
          variant="outline"
          className="border-[#3a3a55] text-white hover:bg-[#2a2a40]"
        >
          New
        </Button>

        {selectedProfile && (
          <Button
            onClick={handleDelete}
            variant="outline"
            className="border-red-900 text-red-400 hover:bg-red-950 hover:text-red-300"
          >
            Delete
          </Button>
        )}

        <div className="flex-1" />

        <Button
          onClick={handleSpawn}
          disabled={!profileName.trim()}
          className="bg-[#00C853] hover:bg-[#00e676] text-black font-semibold"
        >
          Spawn with profile
        </Button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar: config fields */}
        <div className="w-64 border-r border-[#2a2a40] p-3 overflow-y-auto">
          <Card className="bg-[#2a2a40] border-[#3a3a55]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-white">Agent Config</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs text-gray-400">MAX_COMPACT_TOKENS</Label>
                <Input
                  type="number"
                  value={maxCompactTokens}
                  onChange={(e) => updateMaxCompactTokens(e.target.value)}
                  className="mt-1 bg-[#1a1a2e] border-[#3a3a55] text-white"
                />
              </div>
              <div>
                <Label className="text-xs text-gray-400">max_retries_per_step</Label>
                <Input
                  type="number"
                  value={maxRetries}
                  onChange={(e) => updateMaxRetries(e.target.value)}
                  className="mt-1 bg-[#1a1a2e] border-[#3a3a55] text-white"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Monaco editor */}
        <div className="flex-1 relative">
          <div ref={containerRef} className="absolute inset-0" />
        </div>
      </div>
    </div>
  );
}

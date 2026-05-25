import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { crowCliConfigApi } from "../lib/rpc";
import { cn } from "../lib/utils";
import { KeyRound, Server, Cpu, Plus, Trash2, Check, Loader2, RefreshCw } from "lucide-react";

/** Provider shape as stored in config.yaml */
interface CrowProvider {
  base_url?: string;
  api_key?: string; // ${ENV_VAR} reference
}

/** Model shape as stored in config.yaml */
interface CrowModel {
  provider: string;
  model: string;
}

/** Full config.yaml shape */
interface CrowConfig {
  providers?: Record<string, CrowProvider>;
  models?: Record<string, CrowModel>;
  [key: string]: unknown;
}

interface LlmConfigPaneProps {
  onClose: () => void;
}

/** Fetched model from provider API */
interface FetchedModel {
  id: string;
  ownedBy: string;
}

/** Generate env var name from provider name (e.g. "openai" → "OPENAI_API_KEY") */
function envVarName(providerName: string): string {
  return `${providerName.toUpperCase()}_API_KEY`;
}

/** Extract ${VAR} reference from a value, or null if not a reference */
function extractEnvRef(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^\$\{([^}]+)\}$/);
  return match ? match[1] : null;
}

/** Build a ${VAR} reference string */
function envRef(varName: string): string {
  return `\${${varName}}`;
}

/** Derive a friendly name from a model ID */
function friendlyName(modelId: string): string {
  return modelId.split("/").pop() || modelId;
}

/** Inline editable provider name — click to edit, blur/enter to apply */
function ProviderNameEditor({ name, onRename }: { name: string; onRename: (newName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const apply = () => {
    const trimmed = draft.trim().toLowerCase().replace(/\s+/g, "-");
    if (trimmed && trimmed !== name) {
      onRename(trimmed);
    } else {
      setDraft(name);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="space-y-1">
        <Label className="text-[10px] text-text-secondary uppercase tracking-wider">Provider Name</Label>
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
            if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
          }}
          className="h-7 text-[13px] font-semibold bg-secondary px-2"
        />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-text-secondary uppercase tracking-wider">Provider Name</Label>
      <div
        className="text-[13px] font-semibold cursor-pointer hover:text-violet-400 transition-colors"
        onClick={() => setEditing(true)}
        title="Click to rename"
      >
        {name}
      </div>
    </div>
  );
}

export default function LlmConfigPane({ onClose }: LlmConfigPaneProps) {
  const [config, setConfig] = useState<CrowConfig>({});
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [resolvedKeys, setResolvedKeys] = useState<Record<string, string>>({});
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [hasChanges, setHasChanges] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch models state
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [selectedFetchedIds, setSelectedFetchedIds] = useState<Set<string>>(new Set());
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Load config and env on mount
  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [configRes, envRes] = await Promise.all([
          crowCliConfigApi.getConfig(),
          crowCliConfigApi.getEnv(),
        ]);

        const loadedConfig = (configRes.config || {}) as CrowConfig;
        const loadedEnv: Record<string, string> =
          envRes.vars && typeof envRes.vars === "object" && !Array.isArray(envRes.vars)
            ? (envRes.vars as Record<string, string>)
            : {};

        setConfig(loadedConfig);
        setEnvVars(loadedEnv);

        // Pre-resolve API keys for UI display
        const providers = loadedConfig.providers || {};
        const resolved: Record<string, string> = {};
        for (const [id, prov] of Object.entries(providers)) {
          const ref = extractEnvRef(prov.api_key);
          if (ref) {
            resolved[id] = loadedEnv[ref] || "";
          } else {
            // If it's not a reference, store as-is (legacy or manual edit)
            resolved[id] = prov.api_key || "";
          }
        }
        setResolvedKeys(resolved);
        setError(null);
      } catch (e) {
        setError(`Failed to load config: ${e}`);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const providers = config.providers || {};
  const models = config.models || {};

  // ─── Provider mutations ───────────────────────────────────────────────────

  const addProvider = useCallback(() => {
    const id = `provider-${Date.now()}`;
    setConfig((prev) => ({
      ...prev,
      providers: {
        ...(prev.providers || {}),
        [id]: { base_url: "", api_key: "" },
      },
    }));
    setResolvedKeys((prev) => ({ ...prev, [id]: "" }));
    setSelectedProviderId(id);
    setHasChanges(true);
  }, []);

  const deleteProvider = useCallback((id: string) => {
    setConfig((prev) => {
      const nextProviders = { ...(prev.providers || {}) };
      delete nextProviders[id];
      // Also remove models that reference this provider
      const nextModels: Record<string, CrowModel> = {};
      for (const [k, v] of Object.entries(prev.models || {})) {
        if (v.provider !== id) nextModels[k] = v;
      }
      return { ...prev, providers: nextProviders, models: nextModels };
    });
    setResolvedKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedProviderId === id) setSelectedProviderId("");
    setSelectedModelId("");
    setHasChanges(true);
  }, [selectedProviderId]);

  const updateProvider = useCallback((id: string, patch: Partial<CrowProvider>) => {
    setConfig((prev) => ({
      ...prev,
      providers: {
        ...(prev.providers || {}),
        [id]: { ...(prev.providers?.[id] || {}), ...patch },
      },
    }));
    setHasChanges(true);
  }, []);

  const updateProviderKey = useCallback((id: string, key: string) => {
    setResolvedKeys((prev) => ({ ...prev, [id]: key }));
    setHasChanges(true);
  }, []);

  const renameProvider = useCallback((oldId: string, newId: string) => {
    if (!newId.trim() || oldId === newId) return;
    const trimmed = newId.trim().toLowerCase().replace(/\s+/g, "-");

    setConfig((prev) => {
      const provs = prev.providers || {};
      if (!provs[oldId]) return prev;
      if (provs[trimmed]) return prev; // Name already exists

      const nextProviders: Record<string, CrowProvider> = {};
      for (const [k, v] of Object.entries(provs)) {
        if (k === oldId) nextProviders[trimmed] = v;
        else nextProviders[k] = v;
      }

      // Update models referencing this provider
      const nextModels: Record<string, CrowModel> = {};
      for (const [k, v] of Object.entries(prev.models || {})) {
        nextModels[k] = v.provider === oldId
          ? { ...v, provider: trimmed }
          : v;
      }

      // Update api_key env var reference
      if (nextProviders[trimmed]) {
        nextProviders[trimmed] = {
          ...nextProviders[trimmed],
          api_key: envRef(envVarName(trimmed)),
        };
      }

      return { ...prev, providers: nextProviders, models: nextModels };
    });

    setResolvedKeys((prev) => {
      const next = { ...prev };
      next[trimmed] = next[oldId] || "";
      delete next[oldId];
      return next;
    });

    setSelectedProviderId(trimmed);
    setHasChanges(true);
  }, []);

  // ─── Fetch models from provider ───────────────────────────────────────────

  const fetchModels = useCallback(async () => {
    const prov = providers[selectedProviderId];
    if (!prov?.base_url || !resolvedKeys[selectedProviderId]) {
      setFetchError("Base URL and API key are required to fetch models");
      return;
    }

    try {
      setFetchingModels(true);
      setFetchError(null);
      setFetchedModels([]);
      setSelectedFetchedIds(new Set());

      const res = await crowCliConfigApi.fetchModels({
        baseUrl: prov.base_url,
        apiKey: resolvedKeys[selectedProviderId],
      });

      if (!res.success) {
        setFetchError(res.error || "Failed to fetch models");
        return;
      }

      setFetchedModels(res.models);
      // Auto-select all by default
      setSelectedFetchedIds(new Set(res.models.map((m) => m.id)));
    } catch (e) {
      setFetchError(`Failed to fetch models: ${e}`);
    } finally {
      setFetchingModels(false);
    }
  }, [providers, selectedProviderId, resolvedKeys]);

  const toggleFetchedModel = useCallback((id: string) => {
    setSelectedFetchedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addSelectedModels = useCallback(() => {
    const newModels: Record<string, CrowModel> = {};
    for (const modelId of selectedFetchedIds) {
      const name = friendlyName(modelId);
      // Avoid overwriting existing models
      const existingKeys = Object.keys(models);
      let uniqueName = name;
      let counter = 1;
      while (existingKeys.includes(uniqueName) || newModels[uniqueName]) {
        uniqueName = `${name}-${counter}`;
        counter++;
      }
      newModels[uniqueName] = {
        provider: selectedProviderId,
        model: modelId,
      };
    }

    setConfig((prev) => ({
      ...prev,
      models: { ...(prev.models || {}), ...newModels },
    }));
    setHasChanges(true);
    setFetchedModels([]);
    setSelectedFetchedIds(new Set());
  }, [selectedFetchedIds, selectedProviderId, models]);

  // ─── Model mutations ──────────────────────────────────────────────────────

  const addModel = useCallback(() => {
    const id = `model-${Date.now()}`;
    const firstProvider = Object.keys(providers)[0] || "";
    setConfig((prev) => ({
      ...prev,
      models: {
        ...(prev.models || {}),
        [id]: { provider: firstProvider, model: "" },
      },
    }));
    setSelectedModelId(id);
    setHasChanges(true);
  }, [providers]);

  const deleteModel = useCallback((id: string) => {
    setConfig((prev) => {
      const next = { ...(prev.models || {}) };
      delete next[id];
      return { ...prev, models: next };
    });
    if (selectedModelId === id) setSelectedModelId("");
    setHasChanges(true);
  }, [selectedModelId]);

  const updateModel = useCallback((id: string, patch: Partial<CrowModel>) => {
    setConfig((prev) => ({
      ...prev,
      models: {
        ...(prev.models || {}),
        [id]: { ...(prev.models?.[id] || { provider: "", model: "" }), ...patch },
      },
    }));
    setHasChanges(true);
  }, []);

  // ─── Save ─────────────────────────────────────────────────────────────────

  const save = useCallback(async () => {
    try {
      // Build the env vars and config to save
      const newEnvVars = { ...envVars };
      const newProviders: Record<string, CrowProvider> = {};

      for (const [id, prov] of Object.entries(providers)) {
        const actualKey = resolvedKeys[id] || "";
        const varName = envVarName(id);

        if (actualKey) {
          // Store actual key in .env, reference in config
          newEnvVars[varName] = actualKey;
          newProviders[id] = {
            ...prov,
            api_key: envRef(varName),
          };
        } else {
          // No key provided — leave empty reference
          newProviders[id] = {
            ...prov,
            api_key: envRef(varName),
          };
          delete newEnvVars[varName];
        }
      }

      const configToSave: CrowConfig = {
        ...config,
        providers: newProviders,
      };

      await crowCliConfigApi.setConfig({ config: configToSave as any });
      await crowCliConfigApi.setEnv({ vars: newEnvVars as any });

      // Update local env vars to match
      setEnvVars(newEnvVars);
      setHasChanges(false);
    } catch (e) {
      setError(`Failed to save: ${e}`);
    }
  }, [config, providers, resolvedKeys, envVars]);

  const selectedProvider = selectedProviderId ? providers[selectedProviderId] : null;
  const selectedModel = selectedModelId ? models[selectedModelId] : null;

  // Models filtered by the selected provider (for the model editor dropdown)
  const modelsForProvider = Object.entries(models).filter(
    ([, m]) => m.provider === selectedProviderId
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading LLM configuration...
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 text-text-primary text-[13px] font-sans">
      {/* Left sidebar: providers list */}
      <div className="w-56 shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="font-medium text-[13px] flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-violet-500" />
            Providers
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={addProvider}
          >
            <Plus className="w-3 h-3" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {Object.entries(providers).map(([id, prov]) => {
            const isSelected = id === selectedProviderId;
            return (
              <div
                key={id}
                className={cn(
                  "group w-full text-left px-3 py-2 text-[12px] hover:bg-hover transition-colors flex items-center gap-2 cursor-pointer",
                  isSelected && "bg-hover border-l-2 border-l-accent"
                )}
                onClick={() => {
                  setSelectedProviderId(id);
                  setSelectedModelId("");
                  setFetchedModels([]);
                  setSelectedFetchedIds(new Set());
                  setFetchError(null);
                }}
              >
                <span className="truncate flex-1">{id}</span>
                {prov.base_url && (
                  <span className="text-[9px] text-text-secondary truncate max-w-20">
                    {new URL(prov.base_url).hostname}
                  </span>
                )}
                <button
                  className="text-destructive hover:text-destructive/80 shrink-0 opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteProvider(id);
                  }}
                  title="Delete provider"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          {Object.keys(providers).length === 0 && (
            <div className="px-3 py-4 text-[11px] text-text-secondary text-center">
              No providers configured
            </div>
          )}
        </div>

        {/* Models list below providers */}
        <div className="px-3 py-2 border-t border-b border-border flex items-center justify-between">
          <span className="font-medium text-[13px] flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-violet-500" />
            Models
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={addModel}
            disabled={Object.keys(providers).length === 0}
          >
            <Plus className="w-3 h-3" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto max-h-48">
          {Object.entries(models).map(([id, mod]) => {
            const isSelected = id === selectedModelId;
            return (
              <div
                key={id}
                className={cn(
                  "group w-full text-left px-3 py-2 text-[12px] hover:bg-hover transition-colors flex items-center gap-2 cursor-pointer",
                  isSelected && "bg-hover border-l-2 border-l-accent"
                )}
                onClick={() => {
                  setSelectedModelId(id);
                  setSelectedProviderId("");
                }}
              >
                <span className="truncate flex-1">{id}</span>
                <span className="text-[10px] text-text-secondary shrink-0">{mod.provider}</span>
                <button
                  className="text-destructive hover:text-destructive/80 shrink-0 opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteModel(id);
                  }}
                  title="Delete model"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          {Object.keys(models).length === 0 && (
            <div className="px-3 py-4 text-[11px] text-text-secondary text-center">
              No models configured
            </div>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 border-t border-border text-[11px] text-destructive bg-destructive/10">
            {error}
          </div>
        )}

        {hasChanges && (
          <div className="px-3 py-2 border-t border-border flex gap-2">
            <Button size="sm" className="flex-1 text-[11px]" onClick={save}>
              <Check className="w-3 h-3 mr-1" />
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-[11px]"
              onClick={() => setHasChanges(false)}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* Right: editor */}
      <div className="flex-1 overflow-y-auto p-4 bg-background">
        {selectedProvider ? (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold flex items-center gap-2">
                <Server className="w-4 h-4 text-violet-500" />
                Provider Configuration
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={onClose}
              >
                ✕ Close
              </Button>
            </div>

            <Card className="bg-surface border-border">
              <CardHeader className="pb-3">
                <ProviderNameEditor
                  name={selectedProviderId}
                  onRename={(newName) => renameProvider(selectedProviderId, newName)}
                />
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary flex items-center gap-1">
                    <Server className="w-3 h-3" />
                    Base URL
                  </Label>
                  <Input
                    value={selectedProvider.base_url || ""}
                    onChange={(e) =>
                      updateProvider(selectedProviderId, { base_url: e.target.value })
                    }
                    className="h-8 text-[12px] bg-secondary"
                    placeholder="https://api.example.com/v1"
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary flex items-center gap-1">
                    <KeyRound className="w-3 h-3" />
                    API Key
                  </Label>
                  <Input
                    type="password"
                    value={resolvedKeys[selectedProviderId] || ""}
                    onChange={(e) =>
                      updateProviderKey(selectedProviderId, e.target.value)
                    }
                    className="h-8 text-[12px] bg-secondary"
                    placeholder="sk-..."
                  />
                  <p className="text-[10px] text-text-secondary">
                    Stored in ~/.crow/.env as {""}
                    <code className="bg-secondary px-1 rounded">{envVarName(selectedProviderId)}</code>
                  </p>
                </div>

                {/* Fetch models */}
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[11px] h-7"
                    onClick={fetchModels}
                    disabled={fetchingModels || !selectedProvider.base_url || !resolvedKeys[selectedProviderId]}
                  >
                    {fetchingModels ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3 h-3 mr-1" />
                    )}
                    Fetch Models
                  </Button>

                  {fetchError && (
                    <p className="text-[11px] text-destructive">{fetchError}</p>
                  )}

                  {fetchedModels.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] text-text-secondary">
                          {fetchedModels.length} models found — click to select
                        </Label>
                        <div className="flex gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() => setSelectedFetchedIds(new Set(fetchedModels.map((m) => m.id)))}
                          >
                            All
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() => setSelectedFetchedIds(new Set())}
                          >
                            None
                          </Button>
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto border border-border rounded-md p-2 space-y-1">
                        {fetchedModels.map((m) => {
                          const isSelected = selectedFetchedIds.has(m.id);
                          return (
                            <div
                              key={m.id}
                              className={cn(
                                "flex items-center gap-2 px-2 py-1.5 rounded text-[11px] cursor-pointer transition-colors",
                                isSelected
                                  ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                                  : "hover:bg-hover border border-transparent"
                              )}
                              onClick={() => toggleFetchedModel(m.id)}
                            >
                              <div className={cn(
                                "w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors",
                                isSelected
                                  ? "bg-violet-500 border-violet-500"
                                  : "border-border"
                              )}>
                                {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                              </div>
                              <span className="flex-1 truncate">{m.id}</span>
                              <span className="text-[9px] text-text-secondary shrink-0">{m.ownedBy}</span>
                            </div>
                          );
                        })}
                      </div>
                      <Button
                        size="sm"
                        className="text-[11px]"
                        onClick={addSelectedModels}
                        disabled={selectedFetchedIds.size === 0}
                      >
                        <Plus className="w-3 h-3 mr-1" />
                        Add {selectedFetchedIds.size} model{selectedFetchedIds.size !== 1 ? "s" : ""}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Models that use this provider */}
                {modelsForProvider.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <Label className="text-[11px] text-text-secondary">
                        Models using this provider
                      </Label>
                      <div className="flex flex-wrap gap-1.5">
                        {modelsForProvider.map(([id, mod]) => (
                          <Badge
                            key={id}
                            variant="secondary"
                            className="text-[11px] cursor-pointer hover:bg-hover transition-colors"
                            onClick={() => setSelectedModelId(id)}
                          >
                            {id}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        ) : selectedModel ? (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold flex items-center gap-2">
                <Cpu className="w-4 h-4 text-violet-500" />
                Model Configuration
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={onClose}
              >
                ✕ Close
              </Button>
            </div>

            <Card className="bg-surface border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-[13px]">{selectedModelId}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary">Provider</Label>
                  <Select
                    value={selectedModel.provider}
                    onValueChange={(v) => updateModel(selectedModelId, { provider: v })}
                  >
                    <SelectTrigger className="h-8 text-[12px] bg-secondary">
                      <SelectValue placeholder="Select a provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(providers).map((pid) => (
                        <SelectItem key={pid} value={pid} className="text-[12px]">
                          {pid}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary">Model ID</Label>
                  <Input
                    value={selectedModel.model || ""}
                    onChange={(e) =>
                      updateModel(selectedModelId, { model: e.target.value })
                    }
                    className="h-8 text-[12px] bg-secondary"
                    placeholder="gpt-4, claude-3-opus, etc."
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
            <Server className="w-12 h-12 opacity-20" />
            <p className="text-[13px]">Select a provider or model to configure</p>
            <p className="text-[11px] opacity-60">
              Or add a new provider to get started
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

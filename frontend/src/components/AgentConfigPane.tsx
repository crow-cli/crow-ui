import { useState, useEffect, useCallback } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import type { AgentConfig, McpServerConfig } from "../lib/acp-client";
import * as settings from "../lib/settings";
import { cn } from "../lib/utils";

interface AgentConfigPaneProps {
  onClose: () => void;
}

export default function AgentConfigPane({ onClose }: AgentConfigPaneProps) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [hasChanges, setHasChanges] = useState(false);

  // Load from settings on mount
  useEffect(() => {
    settings.getSetting<AgentConfig[]>("acp.agents", []).then((loaded) => {
      const list = loaded && loaded.length > 0 ? loaded : [getDefaultAgent()];
      setAgents(list);
      setSelectedAgentId(list[0].id || list[0].name);
    });
    settings.getSetting<McpServerConfig[]>("acp.mcpServers", []).then((loaded) => {
      setMcpServers(loaded || []);
    });
  }, []);

  const selectedAgent = agents.find((a) => (a.id || a.name) === selectedAgentId);

  const updateAgent = useCallback((updated: AgentConfig) => {
    setAgents((prev) =>
      prev.map((a) => ((a.id || a.name) === selectedAgentId ? updated : a))
    );
    setHasChanges(true);
  }, [selectedAgentId]);

  const addAgent = useCallback(() => {
    const id = `agent-${Date.now()}`;
    const newAgent: AgentConfig = {
      id,
      name: "New Agent",
      command: "",
      args: [],
    };
    setAgents((prev) => [...prev, newAgent]);
    setSelectedAgentId(id);
    setHasChanges(true);
  }, []);

  const deleteAgent = useCallback((id: string) => {
    setAgents((prev) => {
      const next = prev.filter((a) => (a.id || a.name) !== id);
      if (selectedAgentId === id && next.length > 0) {
        const first = next[0];
        setSelectedAgentId(first.id || first.name);
      }
      return next;
    });
    setHasChanges(true);
  }, [selectedAgentId]);

  const save = useCallback(async () => {
    await settings.updateSetting("acp.agents", agents as any);
    setHasChanges(false);
  }, [agents]);

  return (
    <div className="flex h-full min-w-0 text-text-primary text-[13px] font-sans">
      {/* Left sidebar: agent list */}
      <div className="w-56 shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="font-medium text-[13px]">Agents</span>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={addAgent}>
            + New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {agents.map((agent) => {
            const id = agent.id || agent.name;
            const isSelected = id === selectedAgentId;
            return (
              <div
                key={id}
                className={cn(
                  "group w-full text-left px-3 py-2 text-[12px] hover:bg-hover transition-colors flex items-center gap-2 cursor-pointer",
                  isSelected && "bg-hover border-l-2 border-l-accent"
                )}
                onClick={() => setSelectedAgentId(id)}
              >
                <span className="truncate flex-1">{agent.name}</span>
                {agents.length > 1 && (
                  <button
                    className="text-destructive hover:text-destructive/80 shrink-0 opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteAgent(id);
                    }}
                    title="Delete agent"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {hasChanges && (
          <div className="px-3 py-2 border-t border-border">
            <Button size="sm" className="w-full text-[11px]" onClick={save}>
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* Right: agent editor */}
      <div className="flex-1 overflow-y-auto p-4 bg-background">
        {selectedAgent ? (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">Agent Configuration</h2>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onClose}>
                ✕ Close
              </Button>
            </div>

            <Card className="bg-surface border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-[13px]">Basic Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary">Name</Label>
                  <Input
                    value={selectedAgent.name}
                    onChange={(e) => updateAgent({ ...selectedAgent, name: e.target.value })}
                    className="h-8 text-[12px] bg-secondary"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary">ID</Label>
                  <Input
                    value={selectedAgent.id || ""}
                    onChange={(e) => {
                      const newId = e.target.value;
                      setAgents((prev) =>
                        prev.map((a) =>
                          (a.id || a.name) === selectedAgentId ? { ...a, id: newId } : a
                        )
                      );
                      setSelectedAgentId(newId);
                      setHasChanges(true);
                    }}
                    className="h-8 text-[12px] bg-secondary"
                    placeholder="unique-id"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary">Command</Label>
                  <Input
                    value={selectedAgent.command}
                    onChange={(e) => updateAgent({ ...selectedAgent, command: e.target.value })}
                    className="h-8 text-[12px] bg-secondary"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] text-text-secondary">Args</Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[11px]"
                      onClick={() =>
                        updateAgent({
                          ...selectedAgent,
                          args: [...(selectedAgent.args || []), ""],
                        })
                      }
                    >
                      + Add
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {(selectedAgent.args || []).map((arg, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={arg}
                          onChange={(e) => {
                            const next = [...(selectedAgent.args || [])];
                            next[i] = e.target.value;
                            updateAgent({ ...selectedAgent, args: next });
                          }}
                          className="h-7 text-[12px] bg-secondary flex-1"
                          placeholder="arg"
                        />
                        <button
                          className="text-destructive hover:text-destructive/80 h-6 w-6 flex items-center justify-center shrink-0"
                          onClick={() => {
                            const next = [...(selectedAgent.args || [])];
                            next.splice(i, 1);
                            updateAgent({ ...selectedAgent, args: next });
                          }}
                          title="Remove arg"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    {(selectedAgent.args || []).length === 0 && (
                      <div className="text-[11px] text-text-secondary px-1">No args</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-surface border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-[13px]">MCP Servers</CardTitle>
              </CardHeader>
              <CardContent>
                {mcpServers.length === 0 ? (
                  <div className="text-[11px] text-text-secondary">
                    No MCP servers configured. Open the MCP Servers pane to add them.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {mcpServers.map((mcp) => {
                      const enabled = selectedAgent.mcpServerIds?.includes(mcp.name) ?? false;
                      return (
                        <div key={mcp.name} className="flex items-center gap-3 py-1.5">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => {
                              const ids = new Set(selectedAgent.mcpServerIds || []);
                              if (e.target.checked) {
                                ids.add(mcp.name);
                              } else {
                                ids.delete(mcp.name);
                              }
                              updateAgent({
                                ...selectedAgent,
                                mcpServerIds: Array.from(ids),
                              });
                            }}
                            className="w-4 h-4 accent-violet-500 cursor-pointer"
                          />
                          <span className="text-[12px] flex-1">{mcp.name}</span>
                          <span className="text-[10px] text-text-secondary capitalize">
                            {mcp.transport.type}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-text-secondary text-[13px]">
            Select or create an agent
          </div>
        )}
      </div>
    </div>
  );
}

function getDefaultAgent(): AgentConfig {
  return {
    id: "crow-cli",
    name: "Crow CLI",
    command: "crow-cli",
    args: ["acp"],
  };
}

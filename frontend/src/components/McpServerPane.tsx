import { useState, useEffect, useCallback } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { McpServerConfig, McpTransport, EnvVar, HttpHeader } from "../lib/acp-client";
import * as settings from "../lib/settings";
import { cn } from "../lib/utils";

interface McpServerPaneProps {
  onClose: () => void;
}

export default function McpServerPane({ onClose }: McpServerPaneProps) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedName, setSelectedName] = useState<string>("");
  const [hasChanges, setHasChanges] = useState(false);

  // Load from settings on mount
  useEffect(() => {
    settings.getSetting<McpServerConfig[]>("acp.mcpServers", []).then((loaded) => {
      // Filter out any old-format entries that don't have the transport discriminant
      const valid = (loaded || []).filter(
        (s): s is McpServerConfig =>
          !!s &&
          typeof s.name === "string" &&
          !!s.transport &&
          typeof s.transport.type === "string",
      );
      setServers(valid);
      if (valid.length > 0) {
        setSelectedName(valid[0].name);
      }
    });
  }, []);

  const selectedServer = servers.find((s) => s.name === selectedName);

  const updateServer = useCallback((updated: McpServerConfig) => {
    setServers((prev) => prev.map((s) => (s.name === selectedName ? updated : s)));
    setHasChanges(true);
  }, [selectedName]);

  const addServer = useCallback(() => {
    const name = `mcp-${Date.now()}`;
    const newServer: McpServerConfig = {
      name,
      transport: { type: "stdio", command: "", args: [], env: [] },
    };
    setServers((prev) => [...prev, newServer]);
    setSelectedName(name);
    setHasChanges(true);
  }, []);

  const deleteServer = useCallback((name: string) => {
    setServers((prev) => {
      const next = prev.filter((s) => s.name !== name);
      if (selectedName === name && next.length > 0) {
        setSelectedName(next[0].name);
      }
      return next;
    });
    setHasChanges(true);
  }, [selectedName]);

  const save = useCallback(async () => {
    await settings.updateSetting("acp.mcpServers", servers as any);
    setHasChanges(false);
  }, [servers]);

  const setTransportType = (type: "stdio" | "http" | "sse") => {
    if (!selectedServer) return;
    let transport: McpTransport;
    if (type === "stdio") {
      transport = { type: "stdio", command: "", args: [], env: [] };
    } else if (type === "http") {
      transport = { type: "http", url: "", headers: [] };
    } else {
      transport = { type: "sse", url: "", headers: [] };
    }
    updateServer({ ...selectedServer, transport });
  };

  return (
    <div className="flex h-full min-w-0 text-text-primary text-[13px] font-sans">
      {/* Left sidebar: server list */}
      <div className="w-56 shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="font-medium text-[13px]">MCP Servers</span>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={addServer}>
            + New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {servers.map((server) => {
            const isSelected = server.name === selectedName;
            return (
              <div
                key={server.name}
                className={cn(
                  "group w-full text-left px-3 py-2 text-[12px] hover:bg-hover transition-colors flex items-center gap-2 cursor-pointer",
                  isSelected && "bg-hover border-l-2 border-l-accent"
                )}
                onClick={() => setSelectedName(server.name)}
              >
                <span className="truncate flex-1">{server.name}</span>
                <span className="text-[10px] text-text-secondary capitalize shrink-0">
                  {server.transport.type}
                </span>
                {servers.length > 1 && (
                  <button
                    className="text-destructive hover:text-destructive/80 shrink-0 opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteServer(server.name);
                    }}
                    title="Delete server"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
          {servers.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-text-secondary text-center">
              No MCP servers. Click + New to add one.
            </div>
          )}
        </div>
        {hasChanges && (
          <div className="px-3 py-2 border-t border-border">
            <Button size="sm" className="w-full text-[11px]" onClick={save}>
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* Right: server editor */}
      <div className="flex-1 overflow-y-auto p-4 bg-background">
        {selectedServer ? (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">MCP Server Configuration</h2>
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
                    value={selectedServer.name}
                    onChange={(e) => updateServer({ ...selectedServer, name: e.target.value })}
                    className="h-8 text-[12px] bg-secondary"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-text-secondary">Transport</Label>
                  <Select
                    value={selectedServer.transport.type}
                    onValueChange={(v) => setTransportType(v as "stdio" | "http" | "sse")}
                  >
                    <SelectTrigger className="h-8 text-[12px] bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio</SelectItem>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {selectedServer.transport.type === "stdio" && (
              <StdioEditor server={selectedServer} onUpdate={updateServer} />
            )}
            {selectedServer.transport.type === "http" && (
              <HttpEditor server={selectedServer} onUpdate={updateServer} />
            )}
            {selectedServer.transport.type === "sse" && (
              <SseEditor server={selectedServer} onUpdate={updateServer} />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-text-secondary text-[13px]">
            Select or create an MCP server
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stdio Editor ──────────────────────────────────────────────────────────

function StdioEditor({
  server,
  onUpdate,
}: {
  server: McpServerConfig;
  onUpdate: (s: McpServerConfig) => void;
}) {
  const transport = server.transport as Extract<McpTransport, { type: "stdio" }>;

  const updateTransport = (patch: Partial<typeof transport>) => {
    onUpdate({
      ...server,
      transport: { ...transport, ...patch },
    });
  };

  return (
    <Card className="bg-surface border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-[13px]">stdio Transport</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-text-secondary">Command</Label>
          <Input
            value={transport.command}
            onChange={(e) => updateTransport({ command: e.target.value })}
            className="h-8 text-[12px] bg-secondary"
            placeholder="npx"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[11px] text-text-secondary">Args</Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[11px]"
              onClick={() => updateTransport({ args: [...transport.args, ""] })}
            >
              + Add
            </Button>
          </div>
          <div className="space-y-1">
            {transport.args.map((arg, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={arg}
                  onChange={(e) => {
                    const next = [...transport.args];
                    next[i] = e.target.value;
                    updateTransport({ args: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="arg"
                />
                <button
                  className="text-destructive hover:text-destructive/80 h-6 w-6 flex items-center justify-center shrink-0"
                  onClick={() => {
                    const next = [...transport.args];
                    next.splice(i, 1);
                    updateTransport({ args: next });
                  }}
                  title="Remove arg"
                >
                  ✕
                </button>
              </div>
            ))}
            {transport.args.length === 0 && (
              <div className="text-[11px] text-text-secondary px-1">No args</div>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[11px] text-text-secondary">Environment Variables</Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[11px]"
              onClick={() =>
                updateTransport({ env: [...transport.env, { name: "", value: "" }] })
              }
            >
              + Add
            </Button>
          </div>
          <div className="space-y-1">
            {transport.env.map((e, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={e.name}
                  onChange={(ev) => {
                    const next: EnvVar[] = [...transport.env];
                    next[i] = { ...next[i], name: ev.target.value };
                    updateTransport({ env: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="KEY"
                />
                <span className="text-text-secondary">=</span>
                <Input
                  value={e.value}
                  onChange={(ev) => {
                    const next: EnvVar[] = [...transport.env];
                    next[i] = { ...next[i], value: ev.target.value };
                    updateTransport({ env: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="value"
                />
                <button
                  className="text-destructive hover:text-destructive/80 h-6 w-6 flex items-center justify-center shrink-0"
                  onClick={() => {
                    const next = [...transport.env];
                    next.splice(i, 1);
                    updateTransport({ env: next });
                  }}
                  title="Remove env var"
                >
                  ✕
                </button>
              </div>
            ))}
            {transport.env.length === 0 && (
              <div className="text-[11px] text-text-secondary px-1">No env vars</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── HTTP Editor ───────────────────────────────────────────────────────────

function HttpEditor({
  server,
  onUpdate,
}: {
  server: McpServerConfig;
  onUpdate: (s: McpServerConfig) => void;
}) {
  const transport = server.transport as Extract<McpTransport, { type: "http" }>;

  const updateTransport = (patch: Partial<typeof transport>) => {
    onUpdate({
      ...server,
      transport: { ...transport, ...patch },
    });
  };

  return (
    <Card className="bg-surface border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-[13px]">HTTP Transport</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-text-secondary">URL</Label>
          <Input
            value={transport.url}
            onChange={(e) => updateTransport({ url: e.target.value })}
            className="h-8 text-[12px] bg-secondary"
            placeholder="http://localhost:3000/sse"
          />
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[11px] text-text-secondary">Headers</Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[11px]"
              onClick={() =>
                updateTransport({ headers: [...transport.headers, { name: "", value: "" }] })
              }
            >
              + Add
            </Button>
          </div>
          <div className="space-y-1">
            {transport.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={h.name}
                  onChange={(ev) => {
                    const next: HttpHeader[] = [...transport.headers];
                    next[i] = { ...next[i], name: ev.target.value };
                    updateTransport({ headers: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="Header-Name"
                />
                <span className="text-text-secondary">:</span>
                <Input
                  value={h.value}
                  onChange={(ev) => {
                    const next: HttpHeader[] = [...transport.headers];
                    next[i] = { ...next[i], value: ev.target.value };
                    updateTransport({ headers: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="value"
                />
                <button
                  className="text-destructive hover:text-destructive/80 h-6 w-6 flex items-center justify-center shrink-0"
                  onClick={() => {
                    const next = [...transport.headers];
                    next.splice(i, 1);
                    updateTransport({ headers: next });
                  }}
                  title="Remove header"
                >
                  ✕
                </button>
              </div>
            ))}
            {transport.headers.length === 0 && (
              <div className="text-[11px] text-text-secondary px-1">No headers</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── SSE Editor ────────────────────────────────────────────────────────────

function SseEditor({
  server,
  onUpdate,
}: {
  server: McpServerConfig;
  onUpdate: (s: McpServerConfig) => void;
}) {
  const transport = server.transport as Extract<McpTransport, { type: "sse" }>;

  const updateTransport = (patch: Partial<typeof transport>) => {
    onUpdate({
      ...server,
      transport: { ...transport, ...patch },
    });
  };

  return (
    <Card className="bg-surface border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-[13px]">SSE Transport</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-text-secondary">URL</Label>
          <Input
            value={transport.url}
            onChange={(e) => updateTransport({ url: e.target.value })}
            className="h-8 text-[12px] bg-secondary"
            placeholder="http://localhost:3000/sse"
          />
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[11px] text-text-secondary">Headers</Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[11px]"
              onClick={() =>
                updateTransport({ headers: [...transport.headers, { name: "", value: "" }] })
              }
            >
              + Add
            </Button>
          </div>
          <div className="space-y-1">
            {transport.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={h.name}
                  onChange={(ev) => {
                    const next: HttpHeader[] = [...transport.headers];
                    next[i] = { ...next[i], name: ev.target.value };
                    updateTransport({ headers: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="Header-Name"
                />
                <span className="text-text-secondary">:</span>
                <Input
                  value={h.value}
                  onChange={(ev) => {
                    const next: HttpHeader[] = [...transport.headers];
                    next[i] = { ...next[i], value: ev.target.value };
                    updateTransport({ headers: next });
                  }}
                  className="h-7 text-[12px] bg-secondary flex-1"
                  placeholder="value"
                />
                <button
                  className="text-destructive hover:text-destructive/80 h-6 w-6 flex items-center justify-center shrink-0"
                  onClick={() => {
                    const next = [...transport.headers];
                    next.splice(i, 1);
                    updateTransport({ headers: next });
                  }}
                  title="Remove header"
                >
                  ✕
                </button>
              </div>
            ))}
            {transport.headers.length === 0 && (
              <div className="text-[11px] text-text-secondary px-1">No headers</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

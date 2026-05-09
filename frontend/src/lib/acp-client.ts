/**
 * ACP client — bridges @agentclientprotocol/sdk to our WebSocket backend.
 *
 * Architecture:
 *   - Creates its own WebSocket connection to /ws
 *   - Creates a WebSocket-based raw byte Stream (ReadableStream + WritableStream)
 *   - Passes it to ndJsonStream() for JSON-RPC parsing
 *   - Creates ClientSideConnection with our Client implementation
 *   - Handles initialization, session creation, and prompt/cancel
 *
 * The backend spawns the agent subprocess and bridges its stdio to this WebSocket.
 */

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ContentBlock,
  type SessionModeState,
  type SessionModelState,
  type AvailableCommand,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";

import { cacheFile } from "./file-cache";
import { getModelContent } from "../components/EditorPane";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "initializing"
  | "creating_session"
  | "ready";

export interface AcpNotification {
  id: string;
  type: "session_notification" | "connection_change" | "error";
  data: unknown;
}

export interface AgentConfig {
  name: string;
  command: string;
  args?: string[];
  env?: string[];
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  cwd: string;
  createdAt: string;
  initResponse: InitializeResponse;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  availableCommands: AvailableCommand[];
}

// ─── ACP Client Class ────────────────────────────────────────────────────────

interface AcpClientOptions {
  /** Agent to spawn (name, command, args, env) */
  agentConfig: AgentConfig;
  /** Working directory for the agent */
  cwd: string;
  /** Called when a session notification arrives */
  onNotification: (notification: AcpNotification) => void;
  /** Called when connection status changes */
  onStatusChange: (status: ConnectionStatus) => void;
  /** Called when a permission request arrives */
  onPermissionRequest: (
    request: RequestPermissionRequest,
    resolve: (response: RequestPermissionResponse) => void,
    reject: (error: Error) => void,
  ) => void;
}

export class AcpClient {
  private ws: WebSocket | null = null;
  private agentConfig: AgentConfig;
  private cwd: string;
  private onNotification: (notification: AcpNotification) => void;
  private onStatusChange: (status: ConnectionStatus) => void;
  private onPermissionRequest: (
    request: RequestPermissionRequest,
    resolve: (response: RequestPermissionResponse) => void,
    reject: (error: Error) => void,
  ) => void;

  private connection: ClientSideConnection | null = null;
  private agent: Agent | null = null;
  private status: ConnectionStatus = "disconnected";
  private sessionId: string | null = null;
  private agentId: string | null = null;
  private messageBuffer = "";
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private nextReqId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
    }
  >();
  public url = "";

  constructor(options: AcpClientOptions) {
    this.agentConfig = options.agentConfig;
    this.cwd = options.cwd;
    this.onNotification = options.onNotification;
    this.onStatusChange = options.onStatusChange;
    this.onPermissionRequest = options.onPermissionRequest;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get agentConnection(): ClientSideConnection | null {
    return this.connection;
  }

  setStatus(status: ConnectionStatus) {
    this.status = status;
    this.onStatusChange(status);
  }

  addNotification(type: AcpNotification["type"], data: unknown) {
    const id = `${Date.now()}-${this.nextReqId++}`;
    this.onNotification({ id, type, data });
  }

  /** Connect to the agent: spawn subprocess, initialize, create session. */
  async connect(): Promise<SessionInfo> {
    if (this.connection) {
      throw new Error("Already connected");
    }

    this.setStatus("connecting");

    // Create WebSocket connection to ACP endpoint (dumb pipe, separate from app control)
    // In dev mode, connect directly to backend (Vite proxy is unreliable for multiple WS connections)
    // In production, use same-origin (backend serves both frontend + WS on same port)
    const isDev = window.location.port === "5173" || import.meta.env?.DEV;
    const wsUrl = isDev
      ? "ws://localhost:3928/ws/acp"
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/acp`;
    this.url = wsUrl;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error("WebSocket connection failed"));
    });

    // Create the readable/writable streams (sets up ws.onmessage handler)
    const { readable, writable } = this.createStreams();

    // Tell backend to spawn the agent
    const spawnResult = await this.wsInvoke("acp_spawn", {
      name: this.agentConfig.name,
      command: this.agentConfig.command,
      args: this.agentConfig.args || [],
      env: this.agentConfig.env || [],
      cwd: this.cwd,
    });
    this.agentId = spawnResult.agentId as string;

    this.setStatus("connected");

    // 3. Create the ACP connection
    const acpStream = ndJsonStream(writable, readable);
    const client = this.createClient();
    this.connection = new ClientSideConnection((agent: Agent) => {
      this.agent = agent;
      return client;
    }, acpStream);

    // 4. Initialize
    this.setStatus("initializing");
    const initResponse = await this.connection.initialize({
      protocolVersion: 1,
      clientInfo: {
        name: "crow-ui",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    // 5. Create session
    this.setStatus("creating_session");
    const sessionResult: NewSessionResponse = await this.connection.newSession({
      cwd: this.cwd,
      mcpServers: [],
    });

    this.sessionId = sessionResult.sessionId;
    this.setStatus("ready");

    return {
      sessionId: sessionResult.sessionId,
      agentId: this.agentId!,
      agentName: this.agentConfig.name,
      agentDisplayName:
        initResponse.agentInfo?.title ||
        initResponse.agentInfo?.name ||
        this.agentConfig.name,
      cwd: this.cwd,
      createdAt: new Date().toISOString(),
      initResponse,
      modes: (sessionResult as any).modes ?? null,
      models: (sessionResult as any).models ?? null,
      availableCommands: [],
    };
  }

  /** Disconnect and kill the agent. */
  async disconnect(): Promise<void> {
    if (this.agentId) {
      try {
        await this.wsInvoke("acp_kill", { agentId: this.agentId });
      } catch {
        /* ignore */
      }
    }

    this.connection = null;
    this.agent = null;
    this.ws?.close();
    this.ws = null;
    this.controller = null;
    this.sessionId = null;
    this.agentId = null;
    this.pendingRequests.clear();
    this.setStatus("disconnected");
  }

  /** Send a prompt to the active session.
   *
   * Zed sends `ContentBlock[]` with interleaved text, resource_links,
   * embedded_resources, and images. We match that format exactly.
   */
  async prompt(blocks: ContentBlock[]): Promise<PromptResponse> {
    if (!this.connection || !this.sessionId) {
      throw new Error("Not connected");
    }
    return this.connection.prompt({
      sessionId: this.sessionId,
      prompt: blocks,
    });
  }

  /** Cancel the current prompt turn. */
  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  /** Create a new conversation (disconnect and reconnect). */
  async newConversation(): Promise<SessionInfo | null> {
    await this.disconnect();
    return this.connect();
  }

  // ─── Stream creation ────────────────────────────────────────────────────

  private createStreams(): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  } {
    const decoder = new TextDecoder();

    // Writable: client messages → wrap in acp_relay → WebSocket → backend → agent stdin
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.agentId) return;
        const text = decoder.decode(chunk);
        const relay = JSON.stringify({
          id: this.nextReqId++,
          method: "acp_relay",
          params: { agentId: this.agentId, message: text },
        });
        this.ws.send(relay);
      },
    });

    // Readable: agent stdout → backend → WebSocket → client
    const readable = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.controller = ctrl;
      },
      cancel: () => {
        this.controller = null;
      },
    });

    // Set up WebSocket message handler
    this.ws!.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      try {
        const msg = JSON.parse(text);
        // Check if this is an ACP notification for our agent
        if (
          msg.method === "acp-notification" &&
          msg.params?.agentId === this.agentId
        ) {
          const rawMessage = msg.params.message;
          // Feed to ndJsonStream via the controller
          if (this.controller) {
            this.controller.enqueue(this.encoder.encode(rawMessage + "\n"));
          }
        }
        // Check if this is a response to one of our invoke calls
        else if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Not JSON, ignore
      }
    };

    this.ws!.onclose = () => {
      if (this.controller) {
        this.controller.close();
        this.controller = null;
      }
    };

    return { readable, writable };
  }

  // ─── Client implementation ──────────────────────────────────────────────

  private createClient(): Client {
    return {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        return new Promise<RequestPermissionResponse>((resolve, reject) => {
          this.onPermissionRequest(params, resolve, reject);
        });
      },

      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        // Track execute tool calls for terminal mapping
        const update = (params as any).update;
        if (update) {
          const stype = update.sessionUpdate || update.type;
          if (
            (stype === "tool_call" || stype === "tool_call_update") &&
            update.toolCallId
          ) {
            this.recordToolCall(update.toolCallId, update.kind);
          }
        }
        this.addNotification("session_notification", params);
      },

      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        try {
          // Check Monaco model registry first — if the file is open in an editor tab,
          // return the current model content (including unsaved/dirty changes).
          // This is the whole point of a client-side read: the agent sees what the
          // user sees, not what's on disk.
          const modelContent = getModelContent(params.path);
          if (modelContent !== null) {
            const lines = modelContent.split("\n");
            let content = modelContent;
            // Handle line/limit params (agent may request a range)
            if (params.line && params.line > 1) {
              const start = params.line - 1;
              const end = params.limit ? start + params.limit : lines.length;
              content = lines.slice(start, end).join("\n");
            } else if (params.limit) {
              content = lines.slice(0, params.limit).join("\n");
            }
            // Update cache so downstream code knows about this content
            cacheFile(params.path, content);
            return { content };
          }

          // File not open in editor — fall back to backend filesystem read
          const result = await this.wsInvoke("acp_read_file", {
            path: params.path,
            line: params.line,
            limit: params.limit,
          });
          const content = result.content as string;
          // Cache full content only when reading from line 1 with no limit
          if (!params.line || params.line === 1) {
            cacheFile(params.path, content);
          }
          return { content };
        } catch {
          return { content: "" };
        }
      },

      writeTextFile: async (
        params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        await this.wsInvoke("acp_write_file", {
          path: params.path,
          content: params.content,
        });
        // Cache new content after write (for future diff rendering)
        cacheFile(params.path, params.content);
        return {};
      },

      // Terminal handlers — backed by backend AcpTerminalManager
      createTerminal: async (
        params: CreateTerminalRequest,
      ): Promise<CreateTerminalResponse> => {
        const result = await this.wsInvoke("acp_create_terminal", {
          command: params.command,
          args: params.args || [],
          cwd: params.cwd || null,
          env: (params.env || []).map((e) => ({
            name: e.name,
            value: e.value,
          })),
          outputByteLimit: params.outputByteLimit || null,
        });
        const terminalId = result.terminalId as string;
        // Associate with the most recent execute tool call
        if (this.lastExecuteToolCallId) {
          this.associateTerminal(this.lastExecuteToolCallId, terminalId);
        }
        return { terminalId };
      },

      terminalOutput: async (
        params: TerminalOutputRequest,
      ): Promise<TerminalOutputResponse> => {
        const result = await this.wsInvoke("acp_terminal_output", {
          terminalId: params.terminalId,
        });
        const response: TerminalOutputResponse = {
          output: result.output as string,
          truncated: result.truncated as boolean,
        };
        if (result.exitStatus) {
          response.exitStatus = result.exitStatus as any;
        }
        return response;
      },

      waitForTerminalExit: async (
        params: WaitForTerminalExitRequest,
      ): Promise<WaitForTerminalExitResponse> => {
        const result = await this.wsInvoke("acp_wait_for_terminal_exit", {
          terminalId: params.terminalId,
        });
        return {
          exitCode: result.exitCode as number | undefined,
          signal: result.signal as string | undefined,
        };
      },

      killTerminal: async (
        params: KillTerminalRequest,
      ): Promise<KillTerminalResponse> => {
        await this.wsInvoke("acp_kill_terminal", {
          terminalId: params.terminalId,
        });
        return {};
      },

      releaseTerminal: async (
        params: ReleaseTerminalRequest,
      ): Promise<ReleaseTerminalResponse> => {
        await this.wsInvoke("acp_release_terminal", {
          terminalId: params.terminalId,
        });
        return {};
      },
    };
  }

  // ─── WebSocket invoke helper ────────────────────────────────────────────

  /** WebSocket invoke helper — exposed for worktree state queries. */
  wsInvoke(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket not connected"));
    }

    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`WebSocket invoke timeout: ${method}`));
        }
      }, 30000);
    });
  }

  // ─── Tool call → terminal ID mapping ────────────────────────────────────

  /** Maps toolCallId → terminalId for inline terminal rendering. */
  private toolCallTerminalMap = new Map<string, string>();

  /** The most recent tool call ID with execute kind (used when createTerminal is called). */
  private lastExecuteToolCallId: string | null = null;

  /** Record a tool call notification — tracks execute tool calls for terminal mapping. */
  recordToolCall(toolCallId: string, kind?: string) {
    if (kind === "execute" || kind === "other") {
      this.lastExecuteToolCallId = toolCallId;
    }
  }

  /** Get the terminal ID associated with a tool call. */
  getTerminalId(toolCallId: string): string | undefined {
    return this.toolCallTerminalMap.get(toolCallId);
  }

  /** Associate a terminal with a tool call (called internally by createTerminal). */
  private associateTerminal(toolCallId: string, terminalId: string) {
    this.toolCallTerminalMap.set(toolCallId, terminalId);
  }
}

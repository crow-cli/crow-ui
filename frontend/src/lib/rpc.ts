/**
 * Typed RPC client — wraps ws.invoke with protocol types from ts-rs.
 *
 * Every method maps 1:1 to a backend WebSocket handler.
 * Types are generated from Rust structs in backend/crates/crow-ui-server/src/protocol.rs
 */

import { ws } from "./ws-client";
import type {
  DocumentOpenRequest,
  DocumentOpenResponse,
  DocumentCloseRequest,
  DocumentEditRequest,
  DocumentSetContentRequest,
  DocumentGetContentRequest,
  DocumentGetContentResponse,
  DocumentGetInfoRequest,
  DocumentGetInfoResponse,
  DocumentSaveRequest,
  DocumentSaveResponse,
  TypstCompileRequest,
  TypstCompileResponse,
  GetSettingRequest,
  GetSettingResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
  GetAllSettingsRequest,
  GetAllSettingsResponse,
  GetCurrentWorkspaceRequest,
  GetCurrentWorkspaceResponse,
  WorkspaceOpenRequest,
  WorkspaceOpenResponse,
  GetRecentWorkspacesRequest,
  GetRecentWorkspacesResponse,
  AddRecentWorkspaceRequest,
  AddRecentWorkspaceResponse,
  GetWorkspaceLayoutRequest,
  GetWorkspaceLayoutResponse,
  SaveWorkspaceLayoutRequest,
  SaveWorkspaceLayoutResponse,
  TerminalSpawnRequest,
  TerminalSpawnResponse,
  TerminalWriteRequest,
  TerminalResizeRequest,
  TerminalKillRequest,
  TerminalInfoRequest,
  TerminalInfoResponse,
  AcpSpawnRequest,
  AcpSpawnResponse,
  AcpReportSessionCreatedRequest,
  AcpReportSessionCreatedResponse,
  ReadDirRequest,
  ReadDirResponse,
  ReadFileRequest,
  SearchFilesRequest,
  SearchFilesResponse,
  ReadFileResponse,
  ReadFileBinaryRequest,
  ReadFileBinaryResponse,
  WriteFileRequest,
  ExistsRequest,
  ExistsResponse,
  StatRequest,
  StatResponse,
  CreateDirRequest,
  CreateDirResponse,
  CreateFileRequest,
  CreateFileResponse,
  RenameRequest,
  RenameResponse,
  RemoveRequest,
  RemoveResponse,
  AcpRelayRequest,
  AcpRelayResponse,
  AcpSendRequest,
  AcpSendResponse,
  AcpKillRequest,
  AcpKillResponse,
  AcpReadFileRequest,
  AcpReadFileResponse,
  AcpWriteFileRequest,
  AcpWriteFileResponse,
  AcpCreateTerminalRequest,
  AcpCreateTerminalResponse,
  AcpTerminalOutputRequest,
  AcpTerminalOutputResponse,
  AcpWaitForTerminalExitRequest,
  AcpWaitForTerminalExitResponse,
  AcpKillTerminalRequest,
  AcpKillTerminalResponse,
  AcpReleaseTerminalRequest,
  AcpReleaseTerminalResponse,
  AcpTerminalWriteInputRequest,
  AcpTerminalWriteInputResponse,
  AcpTerminalResizeRequest,
  AcpTerminalResizeResponse,
  WorkspaceExpandRequest,
  WorkspaceExpandResponse,
  GetDefaultShellRequest,
  GetDefaultShellResponse,
  GetAvailableShellsRequest,
  GetAvailableShellsResponse,
  GetExplorerStateRequest,
  GetExplorerStateResponse,
  SaveExplorerStateRequest,
  GetCrowCliConfigRequest,
  GetCrowCliConfigResponse,
  SetCrowCliConfigRequest,
  SetCrowCliConfigResponse,
  GetCrowCliEnvRequest,
  GetCrowCliEnvResponse,
  SetCrowCliEnvRequest,
  SetCrowCliEnvResponse,
  FetchProviderModelsRequest,
  FetchProviderModelsResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  InitConnectionRequest,
  InitConnectionResponse,
  ConnectionListSessionsRequest,
  ConnectionListSessionsResponse,
  ConnectionNewSessionRequest,
  ConnectionNewSessionResponse,
  ConnectionLoadSessionRequest,
  ConnectionLoadSessionResponse,
  ConnectionCloseRequest,
  ConnectionCloseResponse,
  CreatePanelRequest,
  CreatePanelResponse,
} from "../bindings";

// ─── Helper ────────────────────────────────────────────────────────────────

async function invoke<T>(method: string, params: unknown): Promise<T> {
  return ws.invoke(method, params as Record<string, unknown>) as Promise<T>;
}

// ─── Document API ──────────────────────────────────────────────────────────

export const documentApi = {
  open: (req: DocumentOpenRequest): Promise<DocumentOpenResponse> =>
    invoke("document_open", req),

  close: (req: DocumentCloseRequest): Promise<void> =>
    invoke("document_close", req),

  edit: (req: DocumentEditRequest): Promise<void> =>
    invoke("document_edit", req),

  setContent: (req: DocumentSetContentRequest): Promise<void> =>
    invoke("document_set_content", req),

  getContent: (req: DocumentGetContentRequest): Promise<DocumentGetContentResponse> =>
    invoke("document_get_content", req),

  getInfo: (req: DocumentGetInfoRequest): Promise<DocumentGetInfoResponse> =>
    invoke("document_get_info", req),

  save: (req: DocumentSaveRequest): Promise<DocumentSaveResponse> =>
    invoke("document_save", req),

  typstCompile: (req: TypstCompileRequest): Promise<TypstCompileResponse> =>
    invoke("typst_compile", req),
};

// ─── Settings API ──────────────────────────────────────────────────────────

export const settingsApi = {
  get: (req: GetSettingRequest): Promise<GetSettingResponse> =>
    invoke("get_setting", req),

  update: (req: UpdateSettingRequest): Promise<UpdateSettingResponse> =>
    invoke("update_setting", req),

  getAll: (req?: GetAllSettingsRequest): Promise<GetAllSettingsResponse> =>
    invoke("get_all_settings", req ?? {}),

};

// ─── Workspace API ─────────────────────────────────────────────────────────

export const workspaceApi = {
  getCurrent: (req?: GetCurrentWorkspaceRequest): Promise<GetCurrentWorkspaceResponse> =>
    invoke("get_current_workspace", req ?? {}),

  open: (req: WorkspaceOpenRequest): Promise<WorkspaceOpenResponse> =>
    invoke("workspace_open", req),

  getRecent: (req?: GetRecentWorkspacesRequest): Promise<GetRecentWorkspacesResponse> =>
    invoke("get_recent_workspaces", req ?? { limit: 10 }),

  addRecent: (req: AddRecentWorkspaceRequest): Promise<AddRecentWorkspaceResponse> =>
    invoke("add_recent_workspace", req),

  getLayout: (req?: GetWorkspaceLayoutRequest): Promise<GetWorkspaceLayoutResponse> =>
    invoke("get_workspace_layout", req ?? {}),

  saveLayout: (req: SaveWorkspaceLayoutRequest): Promise<SaveWorkspaceLayoutResponse> =>
    invoke("save_workspace_layout", req),

  expand: (req: WorkspaceExpandRequest): Promise<WorkspaceExpandResponse> =>
    invoke("workspace_expand", req),
};

// ─── Terminal API ──────────────────────────────────────────────────────────

export const terminalApi = {
  spawn: (req: TerminalSpawnRequest): Promise<TerminalSpawnResponse> =>
    invoke("terminal_spawn", req),

  write: (req: TerminalWriteRequest): Promise<void> =>
    invoke("terminal_write", req),

  resize: (req: TerminalResizeRequest): Promise<void> =>
    invoke("terminal_resize", req),

  kill: (req: TerminalKillRequest): Promise<void> =>
    invoke("terminal_kill", req),

  info: (req: TerminalInfoRequest): Promise<TerminalInfoResponse> =>
    invoke("terminal_info", req),

  getDefaultShell: (req?: GetDefaultShellRequest): Promise<GetDefaultShellResponse> =>
    invoke("get_default_shell", req ?? {}),

  getAvailableShells: (req?: GetAvailableShellsRequest): Promise<GetAvailableShellsResponse> =>
    invoke("get_available_shells", req ?? {}),
};

// ─── Filesystem API ────────────────────────────────────────────────────────

export const fsApi = {
  readDir: (req: ReadDirRequest): Promise<ReadDirResponse> =>
    invoke("read_dir", req),

  readFile: (req: ReadFileRequest): Promise<ReadFileResponse> =>
    invoke("read_file", req),

  readFileBinary: (req: ReadFileBinaryRequest): Promise<ReadFileBinaryResponse> =>
    invoke("read_file_binary", req),

  writeFile: (req: WriteFileRequest): Promise<void> =>
    invoke("write_file", req),

  exists: (req: ExistsRequest): Promise<ExistsResponse> =>
    invoke("exists", req),

  stat: (req: StatRequest): Promise<StatResponse> =>
    invoke("stat", req),

  createDir: (req: CreateDirRequest): Promise<CreateDirResponse> =>
    invoke("create_dir", req),

  createFile: (req: CreateFileRequest): Promise<CreateFileResponse> =>
    invoke("create_file", req),

  rename: (req: RenameRequest): Promise<RenameResponse> =>
    invoke("rename", req),

  remove: (req: RemoveRequest): Promise<RemoveResponse> =>
    invoke("remove", req),

  searchFiles: (req: SearchFilesRequest): Promise<SearchFilesResponse> =>
    invoke("search_files", req),
};

// ─── ACP API ───────────────────────────────────────────────────────────────

export const acpApi = {
  spawn: (req: AcpSpawnRequest): Promise<AcpSpawnResponse> =>
    invoke("acp_spawn", req),

  reportSessionCreated: (req: AcpReportSessionCreatedRequest): Promise<AcpReportSessionCreatedResponse> =>
    invoke("acp_report_session_created", req),

  relay: (req: AcpRelayRequest): Promise<AcpRelayResponse> =>
    invoke("acp_relay", req),

  send: (req: AcpSendRequest): Promise<AcpSendResponse> =>
    invoke("acp_send", req),

  kill: (req: AcpKillRequest): Promise<AcpKillResponse> =>
    invoke("acp_kill", req),

  readFile: (req: AcpReadFileRequest): Promise<AcpReadFileResponse> =>
    invoke("acp_read_file", req),

  writeFile: (req: AcpWriteFileRequest): Promise<AcpWriteFileResponse> =>
    invoke("acp_write_file", req),

  createTerminal: (req: AcpCreateTerminalRequest): Promise<AcpCreateTerminalResponse> =>
    invoke("acp_create_terminal", req),

  terminalOutput: (req: AcpTerminalOutputRequest): Promise<AcpTerminalOutputResponse> =>
    invoke("acp_terminal_output", req),

  waitForTerminalExit: (req: AcpWaitForTerminalExitRequest): Promise<AcpWaitForTerminalExitResponse> =>
    invoke("acp_wait_for_terminal_exit", req),

  killTerminal: (req: AcpKillTerminalRequest): Promise<AcpKillTerminalResponse> =>
    invoke("acp_kill_terminal", req),

  releaseTerminal: (req: AcpReleaseTerminalRequest): Promise<AcpReleaseTerminalResponse> =>
    invoke("acp_release_terminal", req),

  terminalWriteInput: (req: AcpTerminalWriteInputRequest): Promise<AcpTerminalWriteInputResponse> =>
    invoke("acp_terminal_write_input", req),

  terminalResize: (req: AcpTerminalResizeRequest): Promise<AcpTerminalResizeResponse> =>
    invoke("acp_terminal_resize", req),
};

// ─── Session API ───────────────────────────────────────────────────────────

export const sessionApi = {
  list: (req: ListSessionsRequest): Promise<ListSessionsResponse> =>
    invoke("list_sessions", req),

  load: (req: LoadSessionRequest): Promise<LoadSessionResponse> =>
    invoke("load_session", req),
};

// ─── Connection API ────────────────────────────────────────────────────────

export const connectionApi = {
  init: (req: InitConnectionRequest): Promise<InitConnectionResponse> =>
    fetch("/api/acp/connections/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),

  listSessions: (connectionId: string, req: ConnectionListSessionsRequest): Promise<ConnectionListSessionsResponse> =>
    fetch(`/api/acp/connections/${encodeURIComponent(connectionId)}/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),

  bindNewSession: (connectionId: string, req: ConnectionNewSessionRequest): Promise<ConnectionNewSessionResponse> =>
    fetch(`/api/acp/connections/${encodeURIComponent(connectionId)}/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),

  bindLoadSession: (connectionId: string, req: ConnectionLoadSessionRequest): Promise<ConnectionLoadSessionResponse> =>
    fetch(`/api/acp/connections/${encodeURIComponent(connectionId)}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),

  close: (connectionId: string): Promise<ConnectionCloseResponse> =>
    fetch(`/api/acp/connections/${encodeURIComponent(connectionId)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
};

// ─── Panel API ─────────────────────────────────────────────────────────────

export const panelApi = {
  create: (req: CreatePanelRequest): Promise<CreatePanelResponse> =>
    fetch("/api/acp/panels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
};

// ─── Crow CLI Config API ───────────────────────────────────────────────────

export const crowCliConfigApi = {
  getConfig: (req?: GetCrowCliConfigRequest): Promise<GetCrowCliConfigResponse> =>
    invoke("get_crow_cli_config", req ?? {}),

  setConfig: (req: SetCrowCliConfigRequest): Promise<SetCrowCliConfigResponse> =>
    invoke("set_crow_cli_config", req),

  getEnv: (req?: GetCrowCliEnvRequest): Promise<GetCrowCliEnvResponse> =>
    invoke("get_crow_cli_env", req ?? {}),

  setEnv: (req: SetCrowCliEnvRequest): Promise<SetCrowCliEnvResponse> =>
    invoke("set_crow_cli_env", req),

  fetchModels: (req: FetchProviderModelsRequest): Promise<FetchProviderModelsResponse> =>
    invoke("fetch_provider_models", req),
};

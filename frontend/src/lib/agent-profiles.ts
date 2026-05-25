/**
 * Agent profile RPC client — list, load, save, delete agent configuration profiles.
 */

import { ws } from "./ws-client";
import type {
  ListAgentProfilesRequest,
  ListAgentProfilesResponse,
  GetAgentProfileRequest,
  GetAgentProfileResponse,
  SaveAgentProfileRequest,
  SaveAgentProfileResponse,
  DeleteAgentProfileRequest,
  DeleteAgentProfileResponse,
} from "../bindings";

async function invoke<T>(method: string, params: unknown): Promise<T> {
  return ws.invoke(method, params as Record<string, unknown>) as Promise<T>;
}

export const agentProfileApi = {
  list: (req?: ListAgentProfilesRequest): Promise<ListAgentProfilesResponse> =>
    invoke("list_agent_profiles", req ?? {}),

  get: (req: GetAgentProfileRequest): Promise<GetAgentProfileResponse> =>
    invoke("get_agent_profile", req),

  save: (req: SaveAgentProfileRequest): Promise<SaveAgentProfileResponse> =>
    invoke("save_agent_profile", req),

  delete: (req: DeleteAgentProfileRequest): Promise<DeleteAgentProfileResponse> =>
    invoke("delete_agent_profile", req),
};

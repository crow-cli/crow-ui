/**
 * Notification grouping and tool call merging utilities.
 * Ported from the murder Tauri ACP client.
 */

import type { AcpNotification } from "./acp-client";

const TOOL_TYPES = ["tool_call", "tool_call_update"];

function isSameType(
  a: AcpNotification | undefined,
  b: AcpNotification,
): boolean {
  if (!a) return false;
  if (a.type === "session_notification" && b.type === "session_notification") {
    const aUpdate = (a.data as any)?.update?.sessionUpdate;
    const bUpdate = (b.data as any)?.update?.sessionUpdate;
    if (TOOL_TYPES.includes(aUpdate) && TOOL_TYPES.includes(bUpdate)) {
      return true;
    }
    return aUpdate === bUpdate;
  }
  return a.type === b.type;
}

/** Group notifications by their type. Consecutive same-type notifications are grouped. */
export function groupNotifications(
  notifications: AcpNotification[],
): AcpNotification[][] {
  const result: AcpNotification[][] = [];
  for (const notification of notifications) {
    const lastGroup = result[result.length - 1];
    if (lastGroup && isSameType(lastGroup[lastGroup.length - 1], notification)) {
      lastGroup.push(notification);
    } else {
      result.push([notification]);
    }
  }
  return result;
}

interface ToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: any[];
  content?: any[];
  rawInput?: any;
  rawOutput?: any;
}

/** Merge multiple tool call updates into consolidated objects keyed by toolCallId. */
export function mergeToolCalls(updates: ToolCallUpdate[]): ToolCallUpdate[] {
  const map = new Map<string, ToolCallUpdate[]>();
  for (const call of updates) {
    if (!map.has(call.toolCallId)) {
      map.set(call.toolCallId, []);
    }
    map.get(call.toolCallId)!.push(call);
  }
  return Array.from(map.values()).map((calls) => {
    const first = calls[0];
    const last = calls[calls.length - 1];
    if (!first?.toolCallId) {
      throw new Error("Tool call ID is required");
    }
    return {
      ...first,
      toolCallId: first.toolCallId,
      status: last?.status,
      rawOutput: Object.assign({}, ...calls.map((c) => c.rawOutput)),
      locations: calls.flatMap((c) => c.locations || []),
      content: calls.flatMap((c) => c.content || []),
    };
  });
}

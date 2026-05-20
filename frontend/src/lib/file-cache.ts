/**
 * Global file content cache — tracks known content of files the agent has
 * touched. Used to render diffs for edit/write tool calls.
 *
 * Flow:
 *   1. Agent reads file  → cache[path] = content (we know the full file)
 *   2. Agent writes file → we fetch old_content from backend worktree state
 *   3. Agent edits file  → use cached "before" or backend worktree state
 *
 * Backend worktree_state is the source of truth for old_content. This cache
 * is a frontend convenience that reduces round-trips.
 */

interface FileEntry {
  content: string;
  /** When we last saw this content */
  seenAt: number;
}

const cache = new Map<string, FileEntry>();

/** Record that we know the full content of a file. */
export function cacheFile(path: string, content: string) {
  cache.set(path, { content, seenAt: Date.now() });
}

/** Get the last known content of a file, or null if we've never seen it. */
export function getCachedFile(path: string): string | null {
  return cache.get(path)?.content ?? null;
}

/** Remove a file from the cache (e.g. when closing the workspace). */
function evictFile(path: string) {
  cache.delete(path);
}

/** Clear the entire cache (e.g. when switching workspaces). */
function clearCache() {
  cache.clear();
}

/** Debug: get cache size. */
function cacheSize(): number {
  return cache.size;
}

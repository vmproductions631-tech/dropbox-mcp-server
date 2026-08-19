import { DropboxError } from "./client.js";

/** MCP tool result shape. The index signature keeps it assignable to the SDK's CallToolResult. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Wrap a successful JSON payload as an MCP tool result. */
export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const result: ToolResult = {
    content: [{ type: "text", text }],
  };
  if (data && typeof data === "object" && !Array.isArray(data)) {
    result.structuredContent = data as Record<string, unknown>;
  } else {
    result.structuredContent = { result: data };
  }
  return result;
}

/** Wrap an error as an MCP tool result (isError so the model can react). */
export function fail(err: unknown): ToolResult {
  const message =
    err instanceof DropboxError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/** Run an async tool body, converting thrown errors into a fail() result. */
export async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

/**
 * Normalize a user-supplied Dropbox path.
 * Dropbox wants "" for the root and "/Folder/file.ext" otherwise (leading slash,
 * no trailing slash). Accepts ids ("id:...") and namespace ("ns:...") refs as-is.
 */
export function normalizePath(input: string): string {
  const p = input.trim();
  if (p === "" || p === "/") return "";
  if (p.startsWith("id:") || p.startsWith("ns:") || p.startsWith("rev:")) return p;
  const withLead = p.startsWith("/") ? p : `/${p}`;
  return withLead.length > 1 && withLead.endsWith("/")
    ? withLead.replace(/\/+$/, "")
    : withLead;
}

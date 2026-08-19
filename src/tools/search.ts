import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dropboxRpc } from "../client.js";
import { ok, run, normalizePath } from "../helpers.js";

/** Full-account search for files and folders. */
export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "dropbox_search",
    {
      title: "Search files",
      description:
        "Search the account for files and folders matching a query (filename and, where " +
        "indexed, content). Optionally scope to a folder. If the result has_more, call again " +
        "with the returned cursor.",
      inputSchema: {
        query: z.string().describe("Search terms, e.g. \"q3 budget\" or \"logo.png\"."),
        path: z
          .string()
          .optional()
          .describe('Restrict to a folder, e.g. "/Marketing". Defaults to whole account.'),
        max_results: z.number().int().min(1).max(1000).optional(),
        filename_only: z
          .boolean()
          .optional()
          .describe("Match filenames only (skip content matching)."),
        file_status: z
          .enum(["active", "deleted"])
          .optional()
          .describe('Search "active" (default) or "deleted" items.'),
        cursor: z
          .string()
          .optional()
          .describe("Continuation cursor from a previous has_more result."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        if (args.cursor) {
          return ok(
            await dropboxRpc("/files/search/continue_v2", { cursor: args.cursor }),
          );
        }
        const scoped = args.path ? normalizePath(args.path) : undefined;
        return ok(
          await dropboxRpc("/files/search_v2", {
            query: args.query,
            options: {
              path: scoped || undefined,
              max_results: args.max_results ?? 100,
              filename_only: args.filename_only ?? false,
              file_status: args.file_status ?? "active",
            },
          }),
        );
      }),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dropboxRpc, DropboxError } from "../client.js";
import { ok, run, normalizePath } from "../helpers.js";

/** Shared links: create, list, inspect, revoke. */
export function registerSharingTools(server: McpServer): void {
  server.registerTool(
    "dropbox_create_shared_link",
    {
      title: "Create shared link",
      description:
        "Create a shareable link for a file or folder. If a link already exists for the " +
        "path, the existing link is returned instead of erroring.",
      inputSchema: {
        path: z.string().describe('Path to share, e.g. "/Decks/pitch.pdf".'),
        audience: z
          .enum(["public", "team"])
          .optional()
          .describe('Who can access via the link. "public" = anyone with the link.'),
        allow_download: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const settings: Record<string, unknown> = {};
        if (args.audience) settings.audience = args.audience;
        if (typeof args.allow_download === "boolean") {
          settings.allow_download = args.allow_download;
        }
        try {
          return ok(
            await dropboxRpc("/sharing/create_shared_link_with_settings", {
              path: normalizePath(args.path),
              settings: Object.keys(settings).length ? settings : undefined,
            }),
          );
        } catch (err) {
          // "shared_link_already_exists" carries the existing link in its metadata.
          if (err instanceof DropboxError && err.status === 409) {
            const body = err.body as
              | { error?: { ".tag"?: string; shared_link_already_exists?: { metadata?: unknown } } }
              | undefined;
            const existing =
              body?.error?.shared_link_already_exists?.metadata;
            if (existing) return ok({ already_existed: true, ...(existing as object) });
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "dropbox_list_shared_links",
    {
      title: "List shared links",
      description:
        "List existing shared links, optionally for a specific path. Paginates via cursor.",
      inputSchema: {
        path: z.string().optional().describe("Restrict to links for this path."),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(
          await dropboxRpc("/sharing/list_shared_links", {
            path: args.path ? normalizePath(args.path) : undefined,
            cursor: args.cursor,
          }),
        ),
      ),
  );

  server.registerTool(
    "dropbox_get_shared_link_metadata",
    {
      title: "Get shared link metadata",
      description: "Look up metadata for an existing shared link URL.",
      inputSchema: { url: z.string().describe("The shared link URL.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(await dropboxRpc("/sharing/get_shared_link_metadata", { url: args.url })),
      ),
  );

  server.registerTool(
    "dropbox_revoke_shared_link",
    {
      title: "Revoke shared link",
      description: "Disable a shared link so the URL no longer grants access.",
      inputSchema: { url: z.string().describe("The shared link URL to revoke.") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      run(async () => {
        const data = await dropboxRpc("/sharing/revoke_shared_link", { url: args.url });
        return ok(data ?? { revoked: true, url: args.url });
      }),
  );
}

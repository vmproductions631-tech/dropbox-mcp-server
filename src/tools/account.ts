import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dropboxRpc } from "../client.js";
import { ok, run } from "../helpers.js";

/** Account info and storage usage — useful for verifying auth and quota. */
export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "dropbox_get_current_account",
    {
      title: "Get current account",
      description:
        "Return the authenticated account (name, email, account id, team). Good for " +
        "confirming the server is connected to the right Dropbox.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(async () => ok(await dropboxRpc("/users/get_current_account"))),
  );

  server.registerTool(
    "dropbox_get_space_usage",
    {
      title: "Get space usage",
      description: "Return storage usage and allocation for the account.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(async () => ok(await dropboxRpc("/users/get_space_usage"))),
  );
}

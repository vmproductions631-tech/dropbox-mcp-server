#!/usr/bin/env node
/**
 * Dropbox MCP server.
 *
 * Exposes Dropbox API v2 capabilities as MCP tools over stdio: file management,
 * search, shared links, and account info. Modules can be toggled off individually.
 *
 * Required environment (see .env.example):
 *   DROPBOX_APP_KEY        App key from your Dropbox app.
 *   DROPBOX_APP_SECRET     App secret.
 *   DROPBOX_REFRESH_TOKEN  Long-lived refresh token (generate with `npm run auth`).
 * Optional:
 *   DROPBOX_ACCESS_TOKEN   Static token instead of the refresh flow (~4h life).
 *   DROPBOX_SELECT_USER    Team apps: act as a team member (dbmid:...).
 *   DROPBOX_SELECT_ADMIN   Team apps: act as a team admin.
 *   DROPBOX_DISABLED_MODULES  Comma-separated module names to NOT register.
 *   DROPBOX_MAX_READ_BYTES    Size cap for dropbox_read_file (default 5 MB).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerFileTools } from "./tools/files.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSharingTools } from "./tools/sharing.js";
import { registerAccountTools } from "./tools/account.js";

/** module name -> register function. Names are used by DROPBOX_DISABLED_MODULES. */
const MODULES: Record<string, (server: McpServer) => void> = {
  files: registerFileTools,
  search: registerSearchTools,
  sharing: registerSharingTools,
  account: registerAccountTools,
};

async function main(): Promise<void> {
  const server = new McpServer({
    name: "dropbox-mcp",
    version: "0.1.0",
  });

  const disabled = new Set(
    (process.env.DROPBOX_DISABLED_MODULES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const enabled: string[] = [];
  for (const [name, register] of Object.entries(MODULES)) {
    if (disabled.has(name)) continue;
    register(server);
    enabled.push(name);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr only — stdout is reserved for the MCP protocol.
  console.error(
    `dropbox-mcp running on stdio. Enabled modules (${enabled.length}): ${enabled.join(", ")}` +
      (disabled.size ? ` | disabled: ${[...disabled].join(", ")}` : ""),
  );
}

main().catch((err) => {
  console.error("Fatal error starting dropbox-mcp:", err);
  process.exit(1);
});

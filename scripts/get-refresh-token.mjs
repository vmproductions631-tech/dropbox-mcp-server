#!/usr/bin/env node
/**
 * One-time OAuth bootstrap: turn your Dropbox app key/secret into a long-lived
 * refresh token for the MCP server.
 *
 * Usage:
 *   node scripts/get-refresh-token.mjs
 *
 * It reads DROPBOX_APP_KEY / DROPBOX_APP_SECRET from the environment or a local
 * .env file, otherwise prompts for them. Then it walks the offline-access OAuth2
 * flow and prints the refresh token to paste into your MCP config / .env.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

async function loadDotEnv() {
  try {
    return parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const fileEnv = await loadDotEnv();
  const rl = createInterface({ input, output });

  let appKey = process.env.DROPBOX_APP_KEY || fileEnv.DROPBOX_APP_KEY;
  let appSecret = process.env.DROPBOX_APP_SECRET || fileEnv.DROPBOX_APP_SECRET;

  if (!appKey) appKey = (await rl.question("Dropbox App key: ")).trim();
  if (!appSecret) appSecret = (await rl.question("Dropbox App secret: ")).trim();

  const authUrl =
    "https://www.dropbox.com/oauth2/authorize?" +
    new URLSearchParams({
      client_id: appKey,
      response_type: "code",
      token_access_type: "offline", // <- required to receive a refresh token
    }).toString();

  console.log("\n1) Open this URL, approve access, and copy the auth code shown:\n");
  console.log("   " + authUrl + "\n");

  const code = (await rl.question("2) Paste the auth code here: ")).trim();
  rl.close();

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: appKey,
      client_secret: appSecret,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("\nToken exchange failed (" + res.status + "):\n" + text);
    process.exit(1);
  }

  const json = JSON.parse(text);
  if (!json.refresh_token) {
    console.error(
      "\nNo refresh_token returned. Make sure token_access_type=offline and that " +
        "the auth code was not already used.\nResponse: " + text,
    );
    process.exit(1);
  }

  console.log("\n✅ Success. Add this to your MCP server env / .env:\n");
  console.log("DROPBOX_REFRESH_TOKEN=" + json.refresh_token + "\n");
  console.log("(account_id: " + (json.account_id ?? "n/a") + ")");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

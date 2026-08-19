# dropbox-mcp

A Model Context Protocol server that gives an LLM agent read/write access to a
Dropbox account — personal or Business/Team — over the Dropbox API v2.

## The problem

Dropbox's own desktop client solves file *syncing*. It does not solve giving an
AI agent controlled access to an account it doesn't have a local copy of. An
agent that can only see synced folders can't search a 2 TB team archive, can't
mint a share link, and can't read a file it was never given.

This server closes that gap. It talks to the Dropbox HTTP API directly, so it
works against the whole account without syncing a single byte to disk, and it
exposes that access as a fixed set of MCP tools rather than a raw HTTP client —
the agent gets `dropbox_search`, not `fetch`.

## Architecture

Four tool modules (`files`, `search`, `sharing`, `account`) register themselves
against a single `McpServer` speaking MCP over stdio. Every module funnels
through one HTTP client that owns the two things the Dropbox API makes
annoying: the OAuth token lifecycle and the team-space namespace. Modules can
be disabled individually at startup via `DROPBOX_DISABLED_MODULES`, so a
deployment that shouldn't be able to create public share links simply doesn't
register that module — the capability is absent, not merely discouraged.

```
  MCP host (Claude, etc.)
          | stdio (JSON-RPC)
  +-------v--------------------------------------+
  |  index.ts   module registry / stdio transport|
  +-------+--------------------------------------+
          |
  +-------v-------+ +--------+ +---------+ +---------+
  |  tools/files  | | search | | sharing | | account |
  +-------+-------+ +---+----+ +----+----+ +----+----+
          |             |           |           |
          +------+------+-----------+-----------+
                 |
        +--------v-----------------------------------+
        |  client.ts                                 |
        |   - refresh-token -> access-token cache     |
        |   - 401 retry with a forced refresh         |
        |   - Dropbox-API-Path-Root resolution        |
        |   - ASCII-safe Dropbox-API-Arg encoding     |
        +--------+-----------------------------------+
                 |
      RPC api.dropboxapi.com   Content content.dropboxapi.com
```

Two endpoint families, deliberately kept as separate functions: RPC endpoints
are JSON-in/JSON-out, while Content endpoints put their arguments in an HTTP
*header* and use the body for file bytes. Collapsing them into one generic
`request()` would have meant a parameter that silently changes where the
arguments go, so they stay apart.

## The genuinely hard part

On a Dropbox Business team, the API defaults to the member's *home* namespace.
Every team folder — which is where the actual shared work lives — sits in the
team's *root* namespace instead and is simply invisible. `list_folder` on `""`
returns the member's private files and nothing else, with no error and no hint
that most of the account is missing. It looks like a permissions problem and
isn't one.

The fix is to send a `Dropbox-API-Path-Root` header pointing at the team root
namespace, whose id you get from `users/get_current_account`. That introduces a
recursion trap: the generic RPC helper attaches the path-root header to every
call, so having it resolve the namespace by calling `get_current_account`
*through itself* means the header resolution calls the header resolution
forever. `resolveRootNamespaceId()` therefore issues a deliberately bare
`fetch` that bypasses the helper, and the result is memoised so the extra round
trip happens once per process ([src/client.ts](src/client.ts)).

A smaller version of the same class of bug: Content endpoints pass their
arguments in `Dropbox-API-Arg`, and HTTP headers are ASCII. Any file with an
accented character or an emoji in its name throws inside `fetch` rather than
returning an API error. `apiArg()` escapes every non-ASCII code point to
`\uXXXX` before the header is built.

## What I'd do differently

1. **No tests.** This was built and verified by hand against a live account. The
   token-refresh path, the 401 retry, and the chunked upload boundary
   conditions are exactly the code that should have been driven by tests with a
   mocked transport — they're the parts that fail rarely and expensively.
2. **The path-root cache is per-process and never invalidated.** Fine for a
   stdio server that a host restarts freely; wrong for anything long-lived
   where a user could be moved between teams.
3. **`dropbox_delete` is exposed with no confirmation affordance.** Dropbox's
   own retention makes it recoverable, but a destructive tool should signal
   that in its schema rather than relying on the host to ask.
4. **Errors are shaped into strings.** Returning a structured error code
   alongside the message would let an agent branch on "rate limited" versus
   "not found" without parsing prose.

## Setup

Requires Node 20+ (developed on 24) and a Dropbox account.

### 1. Create a Dropbox app

1. Go to <https://www.dropbox.com/developers/apps> and choose **Create app**.
2. Pick **Scoped access** and **Full Dropbox** access.
3. On **Permissions**, enable `account_info.read`, `files.metadata.read`,
   `files.metadata.write`, `files.content.read`, `files.content.write`,
   `sharing.read`, `sharing.write`, then **Submit**.
4. On **Settings**, copy the **App key** and **App secret**.

### 2. Build and authorise

```bash
git clone <this-repo>
cd dropbox-mcp
npm install
npm run build

cp .env.example .env      # fill in DROPBOX_APP_KEY and DROPBOX_APP_SECRET
npm run auth              # prints DROPBOX_REFRESH_TOKEN — paste it into .env
```

`npm run auth` prints a consent URL, takes the code you paste back, and
exchanges it for a refresh token. The server trades that for short-lived access
tokens on its own from then on.

### 3. Register with an MCP host

```json
{
  "mcpServers": {
    "dropbox": {
      "command": "node",
      "args": ["/absolute/path/to/dropbox-mcp/dist/index.js"],
      "env": {
        "DROPBOX_APP_KEY": "your-app-key",
        "DROPBOX_APP_SECRET": "your-app-secret",
        "DROPBOX_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

Restart the host and ask it something like *"What's my Dropbox space usage?"*.

To exercise the server without a host:

```bash
npm run inspect           # @modelcontextprotocol/inspector
```

## Tools

**files** — `dropbox_list_folder`, `dropbox_get_metadata`,
`dropbox_create_folder`, `dropbox_move`, `dropbox_copy`, `dropbox_delete`,
`dropbox_get_temporary_link`, `dropbox_read_file`, `dropbox_upload`
(auto-chunks large files through upload sessions).

**search** — `dropbox_search` across filenames and content, account-wide or
scoped to a folder.

**sharing** — `dropbox_create_shared_link`, `dropbox_list_shared_links`,
`dropbox_get_shared_link_metadata`, `dropbox_revoke_shared_link`.

**account** — `dropbox_get_current_account`, `dropbox_get_space_usage`.

## Configuration

All configuration is environment variables; see [.env.example](.env.example)
for the full annotated list, including the namespace control
(`DROPBOX_PATH_ROOT`), the read-size cap (`DROPBOX_MAX_READ_BYTES`), the upload
chunk size, and the team-app impersonation headers.

## Licence

MIT — see [LICENSE](LICENSE).

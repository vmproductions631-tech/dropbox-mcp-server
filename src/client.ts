/**
 * HTTP client for the Dropbox API v2.
 *
 * Auth: OAuth2 with a long-lived refresh token. The server exchanges the refresh
 * token for short-lived access tokens (~4h) and caches them in memory, refreshing
 * automatically before expiry and once more on a 401.
 *
 * Dropbox has two endpoint families:
 *   - RPC      (api.dropboxapi.com)     JSON in, JSON out.
 *   - Content  (content.dropboxapi.com) args in the Dropbox-API-Arg header; the
 *              file bytes are the request/response body.
 */

const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

export class DropboxError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "DropboxError";
  }
}

// --- token management -------------------------------------------------------

let cachedToken: string | undefined;
let tokenExpiresAt = 0; // epoch ms

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new DropboxError(
      `Missing ${name}. Set it in the server environment (.env). ` +
        `Run "npm run auth" to generate a refresh token.`,
    );
  }
  return v;
}

/**
 * Wrap a thrown value as a network error — unless it is already a DropboxError,
 * in which case it is a shaped, actionable message (a missing env var, say) that
 * happened to be raised inside the fetch try-block. Re-categorising those as
 * "network error" hides the real cause.
 */
function asTransportError(err: unknown, action: string): DropboxError {
  if (err instanceof DropboxError) return err;
  return new DropboxError(`Network error ${action}: ${(err as Error).message}`);
}

async function fetchAccessToken(): Promise<{ token: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: requireEnv("DROPBOX_REFRESH_TOKEN"),
    client_id: requireEnv("DROPBOX_APP_KEY"),
    client_secret: requireEnv("DROPBOX_APP_SECRET"),
  });

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw asTransportError(err, "refreshing the Dropbox token");
  }

  const text = await res.text();
  if (!res.ok) {
    throw new DropboxError(
      `Dropbox token refresh failed (${res.status}): ${text} — ` +
        `check DROPBOX_APP_KEY/SECRET and that the refresh token is still valid.`,
      res.status,
    );
  }
  const json = JSON.parse(text) as { access_token: string; expires_in: number };
  return { token: json.access_token, expiresIn: json.expires_in };
}

async function getAccessToken(force = false): Promise<string> {
  // Static token mode (no auto-refresh).
  const staticToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (staticToken && !process.env.DROPBOX_REFRESH_TOKEN) return staticToken;

  if (!force && cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }
  const { token, expiresIn } = await fetchAccessToken();
  cachedToken = token;
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  return token;
}

/** Team-app headers: act as a specific member/admin when configured. */
function selectHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.DROPBOX_SELECT_USER) {
    h["Dropbox-API-Select-User"] = process.env.DROPBOX_SELECT_USER;
  }
  if (process.env.DROPBOX_SELECT_ADMIN) {
    h["Dropbox-API-Select-Admin"] = process.env.DROPBOX_SELECT_ADMIN;
  }
  return h;
}

// --- path root (team-space namespace) ---------------------------------------
//
// On a Business team, each member has a "home" namespace and the team has a
// "root" namespace. By default the API operates in the home namespace, so team
// folders (which live in the team space, not mounted into home) are invisible.
// Setting Dropbox-API-Path-Root to the team root namespace makes "" the team
// space root, exposing every team folder. The member's home appears as a
// subfolder named after them, e.g. "/Jane Doe".
//
// DROPBOX_PATH_ROOT controls this:
//   unset or "root"  -> auto-detect the team/root namespace (default)
//   "home"           -> stay in the member's home namespace (legacy behavior)
//   <numeric id>     -> use that namespace id explicitly

let cachedPathRootHeader: Record<string, string> | undefined;

async function resolveRootNamespaceId(): Promise<string | undefined> {
  // Direct call that deliberately does NOT add a path-root header (avoids recursion).
  const res = await fetch(`${RPC_BASE}/users/get_current_account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getAccessToken()}`, ...selectHeaders() },
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as { root_info?: { root_namespace_id?: string } };
  return j.root_info?.root_namespace_id;
}

async function pathRootHeader(): Promise<Record<string, string>> {
  if (cachedPathRootHeader) return cachedPathRootHeader;
  const mode = (process.env.DROPBOX_PATH_ROOT ?? "root").trim();
  if (mode === "" || mode.toLowerCase() === "home") {
    return (cachedPathRootHeader = {});
  }
  const nsId = /^\d+$/.test(mode) ? mode : await resolveRootNamespaceId();
  cachedPathRootHeader = nsId
    ? { "Dropbox-API-Path-Root": JSON.stringify({ ".tag": "root", root: nsId }) }
    : {};
  return cachedPathRootHeader;
}

// --- error shaping ----------------------------------------------------------

function shapeError(status: number, path: string, parsed: unknown): DropboxError {
  let summary = "";
  if (parsed && typeof parsed === "object" && "error_summary" in parsed) {
    summary = String((parsed as { error_summary: unknown }).error_summary);
  } else {
    summary = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "");
  }
  let hint = "";
  if (status === 401) hint = " — token invalid/expired.";
  else if (status === 403) hint = " — app lacks the required scope, or no access to this path.";
  else if (status === 409) hint = " — endpoint conflict (e.g. path not found, or already exists).";
  else if (status === 429) hint = " — rate limited; retry after a short delay.";
  return new DropboxError(
    `Dropbox API ${status} for ${path}${hint} ${summary}`.trim(),
    status,
    parsed,
  );
}

// --- RPC endpoints ----------------------------------------------------------

/**
 * Call a Dropbox RPC endpoint, e.g. dropboxRpc("/files/list_folder", { path: "" }).
 * Pass `undefined` body for no-argument endpoints (get_current_account, etc.).
 */
export async function dropboxRpc<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${RPC_BASE}${path}`;

  const doFetch = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...selectHeaders(),
      ...(await pathRootHeader()),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(url, {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res: Response;
  try {
    res = await doFetch(await getAccessToken());
    if (res.status === 401) res = await doFetch(await getAccessToken(true));
  } catch (err) {
    throw asTransportError(err, "calling Dropbox");
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw shapeError(res.status, path, parsed);
  return parsed as T;
}

// --- Content endpoints ------------------------------------------------------

/** Dropbox-API-Arg must be HTTP-header-safe ASCII; escape any non-ASCII as \uXXXX. */
function apiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[-￿]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** Download a file's bytes. Returns the parsed metadata and the raw body. */
export async function dropboxDownload(
  arg: unknown,
): Promise<{ metadata: unknown; data: Buffer }> {
  const url = `${CONTENT_BASE}/files/download`;

  const doFetch = async (token: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": apiArg(arg),
        ...selectHeaders(),
        ...(await pathRootHeader()),
      },
    });

  let res: Response;
  try {
    res = await doFetch(await getAccessToken());
    if (res.status === 401) res = await doFetch(await getAccessToken(true));
  } catch (err) {
    throw asTransportError(err, "downloading from Dropbox");
  }

  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
    throw shapeError(res.status, "/files/download", parsed);
  }

  const metaHeader = res.headers.get("dropbox-api-result");
  const metadata = metaHeader ? JSON.parse(metaHeader) : undefined;
  const data = Buffer.from(await res.arrayBuffer());
  return { metadata, data };
}

/**
 * Call a Dropbox *content* RPC endpoint that takes octet-stream body bytes and
 * returns JSON, e.g. files/upload and the files/upload_session/* family.
 * Returns the parsed JSON, or undefined for empty 200 responses (append_v2).
 */
export async function dropboxContentRpc<T = unknown>(
  path: string,
  arg: unknown,
  data: Buffer,
): Promise<T> {
  const url = `${CONTENT_BASE}${path}`;

  const doFetch = async (token: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": apiArg(arg),
        "Content-Type": "application/octet-stream",
        ...selectHeaders(),
        ...(await pathRootHeader()),
      },
      body: new Uint8Array(data),
    });

  let res: Response;
  try {
    res = await doFetch(await getAccessToken());
    if (res.status === 401) res = await doFetch(await getAccessToken(true));
  } catch (err) {
    throw asTransportError(err, "uploading to Dropbox");
  }

  const text = await res.text();
  let parsed: unknown = text || undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!res.ok) throw shapeError(res.status, path, parsed);
  return parsed as T;
}

/** Upload bytes to a path in a single request. `arg` is the files/upload commit info. */
export async function dropboxUpload(arg: unknown, data: Buffer): Promise<unknown> {
  return dropboxContentRpc("/files/upload", arg, data);
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  dropboxRpc,
  dropboxDownload,
  dropboxUpload,
  dropboxContentRpc,
} from "../client.js";
import { ok, run, normalizePath } from "../helpers.js";
import { readFile, open, stat } from "node:fs/promises";

/** Dropbox single-request upload tops out at 150 MB; go to sessions above this. */
const SIMPLE_UPLOAD_MAX = 140 * 1024 * 1024;

/**
 * Upload a local file in chunks via an upload session, for files too large for a
 * single request. Streams from disk so memory stays flat regardless of file size.
 */
async function uploadViaSession(
  localPath: string,
  commit: Record<string, unknown>,
): Promise<unknown> {
  const chunkSize = Math.max(
    4 * 1024 * 1024,
    Number(process.env.DROPBOX_UPLOAD_CHUNK_BYTES ?? 64 * 1024 * 1024),
  );
  const fh = await open(localPath, "r");
  try {
    const { size } = await fh.stat();
    const start = await dropboxContentRpc<{ session_id: string }>(
      "/files/upload_session/start",
      { close: false },
      Buffer.alloc(0),
    );
    const sessionId = start.session_id;
    let offset = 0;
    const buf = Buffer.allocUnsafe(chunkSize);
    while (offset < size) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
      if (bytesRead === 0) break;
      await dropboxContentRpc(
        "/files/upload_session/append_v2",
        { cursor: { session_id: sessionId, offset }, close: false },
        buf.subarray(0, bytesRead),
      );
      offset += bytesRead;
    }
    return dropboxContentRpc(
      "/files/upload_session/finish",
      { cursor: { session_id: sessionId, offset }, commit },
      Buffer.alloc(0),
    );
  } finally {
    await fh.close();
  }
}

const path = z
  .string()
  .describe('Dropbox path, e.g. "/Marketing/2025/brief.pdf". Use "" for the account root.');

/** File and folder management: browse, inspect, move, copy, delete, upload, read. */
export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "dropbox_list_folder",
    {
      title: "List folder",
      description:
        'List the contents of a folder. Pass "" for the root. Set recursive=true to walk ' +
        "subfolders. If the result is truncated, call again with the returned cursor.",
      inputSchema: {
        path: path.optional().describe('Folder path. Defaults to root ("").'),
        recursive: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        cursor: z
          .string()
          .optional()
          .describe("Continuation cursor from a previous truncated result."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        if (args.cursor) {
          return ok(
            await dropboxRpc("/files/list_folder/continue", { cursor: args.cursor }),
          );
        }
        return ok(
          await dropboxRpc("/files/list_folder", {
            path: normalizePath(args.path ?? ""),
            recursive: args.recursive ?? false,
            limit: args.limit,
            include_non_downloadable_files: true,
          }),
        );
      }),
  );

  server.registerTool(
    "dropbox_get_metadata",
    {
      title: "Get metadata",
      description: "Get metadata (size, modified time, id, etc.) for a single file or folder.",
      inputSchema: {
        path,
        include_deleted: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(
          await dropboxRpc("/files/get_metadata", {
            path: normalizePath(args.path),
            include_deleted: args.include_deleted ?? false,
          }),
        ),
      ),
  );

  server.registerTool(
    "dropbox_create_folder",
    {
      title: "Create folder",
      description: "Create a folder at the given path.",
      inputSchema: { path, autorename: z.boolean().optional() },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(
          await dropboxRpc("/files/create_folder_v2", {
            path: normalizePath(args.path),
            autorename: args.autorename ?? false,
          }),
        ),
      ),
  );

  server.registerTool(
    "dropbox_move",
    {
      title: "Move / rename",
      description: "Move or rename a file or folder from one path to another.",
      inputSchema: {
        from_path: path.describe("Current path of the item."),
        to_path: path.describe("Destination path (this is also how you rename)."),
        autorename: z
          .boolean()
          .optional()
          .describe("If the destination is taken, rename instead of failing."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(
          await dropboxRpc("/files/move_v2", {
            from_path: normalizePath(args.from_path),
            to_path: normalizePath(args.to_path),
            autorename: args.autorename ?? false,
          }),
        ),
      ),
  );

  server.registerTool(
    "dropbox_copy",
    {
      title: "Copy",
      description: "Copy a file or folder to a new path.",
      inputSchema: {
        from_path: path,
        to_path: path,
        autorename: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(
          await dropboxRpc("/files/copy_v2", {
            from_path: normalizePath(args.from_path),
            to_path: normalizePath(args.to_path),
            autorename: args.autorename ?? false,
          }),
        ),
      ),
  );

  server.registerTool(
    "dropbox_delete",
    {
      title: "Delete",
      description:
        "Delete a file or folder (and its contents). Destructive — the item moves to " +
        "deleted state and can be restored from Dropbox for the retention window.",
      inputSchema: { path },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      run(async () =>
        ok(await dropboxRpc("/files/delete_v2", { path: normalizePath(args.path) })),
      ),
  );

  server.registerTool(
    "dropbox_get_temporary_link",
    {
      title: "Get temporary link",
      description:
        "Get a direct, time-limited (~4h) download/streaming URL for a file. Use this to " +
        "reference or fetch file contents without creating a permanent shared link.",
      inputSchema: { path },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () =>
        ok(
          await dropboxRpc("/files/get_temporary_link", {
            path: normalizePath(args.path),
          }),
        ),
      ),
  );

  server.registerTool(
    "dropbox_read_file",
    {
      title: "Read file (text)",
      description:
        "Download a file and return its contents as UTF-8 text — for referencing docs, " +
        "notes, code, csv, etc. Guarded by DROPBOX_MAX_READ_BYTES (default 5 MB). For large " +
        "or binary files use dropbox_get_temporary_link instead.",
      inputSchema: { path },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const max = Number(process.env.DROPBOX_MAX_READ_BYTES ?? 5 * 1024 * 1024);
        const { metadata, data } = await dropboxDownload({
          path: normalizePath(args.path),
        });
        if (data.byteLength > max) {
          return ok({
            metadata,
            note: `File is ${data.byteLength} bytes, over the ${max}-byte read cap. ` +
              "Use dropbox_get_temporary_link to fetch it directly.",
          });
        }
        return ok({ metadata, text: data.toString("utf8") });
      }),
  );

  server.registerTool(
    "dropbox_upload",
    {
      title: "Upload file",
      description:
        "Upload content to a path. Provide either `text` (inline UTF-8) or `localPath` " +
        "(a file on this machine to read). Files at/under ~140 MB go in a single request; " +
        "larger local files are streamed in chunks via an upload session automatically.",
      inputSchema: {
        path: path.describe("Destination path in Dropbox, including filename."),
        text: z.string().optional().describe("Inline UTF-8 content to upload."),
        localPath: z
          .string()
          .optional()
          .describe("Absolute path to a local file whose bytes to upload."),
        mode: z
          .enum(["add", "overwrite"])
          .optional()
          .describe('"add" (default) keeps both on conflict; "overwrite" replaces.'),
        autorename: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const commit = {
          path: normalizePath(args.path),
          mode: args.mode ?? "add",
          autorename: args.autorename ?? true,
          mute: false,
        };

        if (args.localPath) {
          const { size } = await stat(args.localPath);
          if (size > SIMPLE_UPLOAD_MAX) {
            const result = await uploadViaSession(args.localPath, commit);
            return ok({ via: "upload_session", bytes: size, ...(result as object) });
          }
          return ok(await dropboxUpload(commit, await readFile(args.localPath)));
        }

        if (typeof args.text === "string") {
          return ok(await dropboxUpload(commit, Buffer.from(args.text, "utf8")));
        }

        return ok({ error: "Provide either `text` or `localPath`." });
      }),
  );
}

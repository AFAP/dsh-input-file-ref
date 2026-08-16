// dsh-input-file-ref — host half (Node).
//
// Serves the file-reference picker's data for the Web GUI:
//   - BROWSE mode (GET /api/input-file-list?sessionId=…&dir=<rel>): lists ONE
//     level of a directory under the session cwd — `dirs` (every subdirectory,
//     INCLUDING dot-dirs and ignore-listed dirs like node_modules/target, so
//     the user can drill into them level by level) and `files` (relative
//     paths + sizes). Browsing is cheap (no recursion) and never searches the
//     omitted directories' contents.
//   - SEARCH mode (…&query=<text>): recursively walks the session cwd and
//     returns matching files, EXCLUDING dot-dirs and the ignore list
//     (.git, node_modules, target, …) — hidden / build folders never surface
//     in search results.
//
// The session's working directory is resolved ONLY from its durable header
// (the first JSONL record of session.jsonl / session.jsonl.zstd), never from
// a client-supplied path; the `dir` parameter is strictly validated as a
// relative sub-path (no "..", separators, or drive escapes) before any
// filesystem use. Only relative paths, sizes and mtimes are returned — no
// file contents, ever.
//
// DELIBERATELY DEPENDENCY-FREE: this module imports only Node builtins
// (fs/promises, os, path, zlib) so it loads from any install method (git,
// registry, file:, link:) without a single @deepseek-ai/* import. The route
// is an EXACT webserver match (wins over the connection plugin's /api
// prefix) and applies its own browser-trust fence (loopback / trustedHosts +
// same-origin), mirroring @deepseek-ai/dsh-client-connection.
import { opendir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Stable Cordis plugin name. */
const name = "input-file-ref";
/** Services required before the route can be claimed. */
const inject = ["webServer"];

// ── configuration ──────────────────────────────────────────────────────────
/** Search-result cap (a bound on the walked entries, not a payload cap). */
const MAX_FILES = 500;
/** Single-level browse cap (directories + files). */
const MAX_LEVEL = 500;
/** Directory names skipped during SEARCH walks (never in search results). */
const DEFAULT_IGNORE_DIRS = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  ".idea",
  ".vscode",
  ".DS_Store"
];
/** Session-path segment escaping; the injection-safe inverse decoder is not needed (search only). */
const SAFE_UNIT = /^[A-Za-z0-9._-]$/;

/**
 * Injective single-segment encoding of a session id before any filesystem use
 * (same algorithm as @deepseek-ai/dsh-session-persistence-jsonl). Neutralizes
 * "..", absolute paths, NUL, and separators — a client-supplied id can never
 * escape the sessions root.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && SAFE_UNIT.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** Resolve the harness sessions root: $DSH_HOME/sessions, else ~/.dsh/sessions. */
function sessionsRoot() {
  const env = process.env.DSH_HOME;
  const home = typeof env === "string" && env.trim() !== "" ? env.trim() : join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** Read the validated `trustedHosts` list from the row config (never throws). */
function trustedHostsOf(config) {
  const value = config && config.trustedHosts;
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/** The validated `ignore` dir list from config, falling back to the default table. */
function ignoreDirsOf(config) {
  const value = config && config.ignore;
  if (Array.isArray(value)) return new Set(value.map((entry) => String(entry)).filter((entry) => entry !== ""));
  return new Set(DEFAULT_IGNORE_DIRS);
}

// ── browser-trust fence (mirrors @deepseek-ai/dsh-client-connection) ──────

/** Whether a WHATWG hostname names the loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Whether the request's Host authority is loopback or a declared trusted host. */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    let entryUrl;
    try {
      entryUrl = new URL(`http://${entry}`);
    } catch {
      return false;
    }
    return entryUrl.port === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}

/** Decide whether one request may reach /api/input-file-list. */
function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// ── session cwd resolution ────────────────────────────────────────────────
/** Zstandard frame magic, little-endian 0xFD2FB528. */
const ZSTD_MAGIC = 4247762216;

/**
 * Locate complete zstd frames without decompressing their blocks (structural
 * walk: magic + descriptor + block iterator + optional checksum).
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Read just the first JSONL record of one log file — the immutable `session`
 * header record carrying `cwd`. Works for both plaintext and the
 * independently-compressed first zstd frame.
 */
async function readHeaderLine(path, isZstd) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return void 0;
  }
  // Tolerate a leading UTF-8 BOM in plaintext artifacts (some editors add one).
  if (!isZstd && buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) buffer = buffer.subarray(3);
  let text;
  if (!isZstd) {
    const nl = buffer.indexOf(10);
    const first = nl === -1 ? buffer : buffer.subarray(0, nl);
    text = first.toString("utf8");
  } else {
    const { frames } = scanZstdFrames(buffer);
    const first = frames[0];
    if (first === void 0) return void 0;
    let plain;
    try {
      plain = zstdDecompressSync(buffer.subarray(first.start, first.end));
    } catch {
      return void 0;
    }
    const nl = plain.indexOf(10);
    const line = nl === -1 ? plain : plain.subarray(0, nl);
    text = line.toString("utf8");
  }
  if (text.trim() === "") return void 0;
  try {
    const record = JSON.parse(text);
    if (record !== null && typeof record === "object" && record.type === "session") return record;
    return void 0;
  } catch {
    return void 0;
  }
}

/**
 * Locate the app log file for one session id under the sessions root, and read
 * its header record. Scans the project/session directory tree for the
 * session-owned directory named by the id-encoded segment.
 */
async function resolveSession(root, rawId) {
  const encoded = encodeSegment(rawId);
  let outerEntries;
  try {
    outerEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const outer of outerEntries) {
    if (!outer.isDirectory()) continue;
    const sessionDir = join(root, outer.name, encoded);
    let innerEntries;
    try {
      innerEntries = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const inner of innerEntries) {
      const full = join(sessionDir, inner.name);
      if (inner.name === "session.jsonl" || inner.name === "session.jsonl.zstd") {
        const header = await readHeaderLine(full, inner.name.endsWith(".zstd"));
        if (header !== void 0 && header.id === rawId) return { header, logPath: full };
        return null;
      }
    }
  }
  return null;
}

// ── listing ───────────────────────────────────────────────────────────────

/**
 * Strictly resolve a client-supplied `dir` (relative "/"-separated sub-path)
 * under the session cwd. Returns the absolute resolved directory, or null for
 * any escapade: empty/"."/".." segments, backslashes, drive letters, NUL, or a
 * resolved path whose first relative segment is "..".
 */
function resolveSubdir(cwd, dir) {
  if (dir === "") return cwd;
  if (dir.includes("\\") || dir.includes(":") || dir.includes("\0")) return null;
  const segs = dir.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") return null;
  }
  const target = join(cwd, ...segs);
  const rel = relative(cwd, target);
  if (isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") return null;
  return target;
}

/**
 * List ONE directory level (BROWSE mode): every subdirectory name (including
 * dot-dirs and ignore-listed dirs like node_modules, .git, target — browsable,
 * never searched) plus file rows (full relative path from cwd, size, mtime).
 * No recursion; symlinks skipped; dot-files skipped.
 * @returns `{ dirs, files, truncated }`.
 */
async function listLevel(cwd, relDir, targetDir) {
  const dirs = [];
  const files = [];
  let truncated = false;
  let entries;
  try {
    entries = await opendir(targetDir);
  } catch {
    return { dirs, files, truncated: false };
  }
  for await (const dirent of entries) {
    if (dirs.length + files.length >= MAX_LEVEL) {
      truncated = true;
      break;
    }
    if (dirent.isSymbolicLink()) continue;
    const full = join(targetDir, dirent.name);
    if (dirent.isDirectory()) {
      dirs.push(dirent.name);
    } else if (dirent.isFile() && !dirent.name.startsWith(".")) {
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      files.push({ path: relDir === "" ? dirent.name : relDir + "/" + dirent.name, size: info.size, mtime: Math.floor(info.mtimeMs) });
    }
  }
  dirs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dirs, files, truncated };
}

/**
 * Recursively walk `cwd` collecting SEARCH results: file rows only, skipping
 * dot-dirs, ignore-listed dirs (.git / node_modules / target / …) and their
 * contents entirely, bounded to MAX_FILES. A query is required (the handler
 * treats an empty query as browse).
 * @returns `{ files, truncated }`.
 */
async function listSearch(cwd, query, ignore) {
  const files = [];
  let truncated = false;
  const needle = query.toLowerCase();

  async function walk(dir, rel) {
    if (files.length >= MAX_FILES || truncated) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      return;
    }
    for await (const dirent of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const childRel = rel === "" ? dirent.name : rel + "/" + dirent.name;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        const base = dirent.name;
        if (base.startsWith(".") || ignore.has(base)) continue;
        await walk(join(dir, dirent.name), childRel);
      } else if (dirent.isFile()) {
        if (dirent.name.startsWith(".")) continue;
        if (!childRel.toLowerCase().includes(needle) && !dirent.name.toLowerCase().includes(needle)) continue;
        let info;
        try {
          info = await stat(join(dir, dirent.name));
        } catch {
          continue;
        }
        files.push({ path: childRel, size: info.size, mtime: Math.floor(info.mtimeMs) });
      }
    }
  }

  await walk(cwd, "");
  return { files, truncated };
}

// ── the /api/input-file-list endpoint ─────────────────────────────────────

/** Read a single-valued query string, or undefined. */
function queryParam(url, key) {
  return url.searchParams.get(key) ?? void 0;
}

/** Build the route handler bound to this plugin's context and config. */
function createHandler(ctx, config) {
  const trustedHosts = trustedHostsOf(config);
  const ignore = ignoreDirsOf(config);
  return async (req, res) => {
    res.setHeader?.("cache-control", "no-store");
    let url;
    try {
      url = new URL(req.url ?? "", "http://localhost");
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid request url" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!isTrustedRequest(req, trustedHosts)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const sessionId = queryParam(url, "sessionId");
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing or empty sessionId" }));
      return;
    }
    const query = queryParam(url, "query");
    const dir = queryParam(url, "dir") ?? "";
    try {
      const root = sessionsRoot();
      const found = await resolveSession(root, sessionId);
      if (found === null) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "session not found", sessionId }));
        return;
      }
      const cwd = found.header.cwd;
      if (typeof cwd !== "string" || cwd.trim() === "") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ noCwd: true, files: [] }));
        return;
      }
      if (typeof query === "string" && query.trim() !== "") {
        const { files, truncated } = await listSearch(cwd, query.trim(), ignore);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ mode: "search", cwd, files, truncated, noCwd: false }));
        return;
      }
      const target = resolveSubdir(cwd, dir);
      if (target === null) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid dir", dir }));
        return;
      }
      let isDir = false;
      try {
        isDir = (await stat(target)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "directory not found", dir }));
        return;
      }
      const { dirs, files, truncated } = await listLevel(cwd, dir, target);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ mode: "browse", cwd, dir, dirs, files, truncated, noCwd: false }));
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
    }
  };
}

/** Register the file-list route; the disposer releases it on plugin unload. */
function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/input-file-list",
    handler: createHandler(ctx, config)
  }), "input-file-ref: /api/input-file-list route");
}

export { apply, inject, name };
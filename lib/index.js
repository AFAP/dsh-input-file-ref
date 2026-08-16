// dsh-input-file-ref — host half (Node).
//
// Resolves a session's working directory and lists the files under it for the
// '@' file-reference picker in the Web GUI. On GET /api/input-file-list it
// reads the session's durable header (the first JSONL record of its log —
// session.jsonl / session.jsonl.zstd) to obtain the session's `cwd`, then
// recursively walks that directory and returns relative paths + sizes. The
// browser half filters and renders; the model reads the referenced file with
// its own fs tool inside the sandbox rooted at the session cwd.
//
// The route is registered as an EXACT match on the webserver, which wins over
// the connection plugin's /api prefix, so this handler applies its own
// browser-trust fence (loopback / declared trustedHosts + same-origin checks)
// mirroring the /api fence in @deepseek-ai/dsh-client-connection — see the
// token-usage plugin, which established this exact-route pattern.
//
// DELIBERATELY DEPENDENCY-FREE: this module imports only Node builtins. The
// whole file-list path (resolve cwd from the durable session header, walk the
// directory) is implemented with fs/promises + node:zlib and path helpers, so
// it loads correctly from any install method (git, registry, file:, link:)
// without a single @deepseek-ai/* import.
//
// SECURITY RED LINE: the cwd is derived ONLY from the session's durable header
// (validated absolute path at session creation), never from a client-supplied
// path. The session id is path-encoded before any filesystem use (the same
// injective escaping the session-persistence backend applies), and only
// relative paths are returned. No file contents are ever read or returned.
import { opendir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Stable Cordis plugin name. */
const name = "input-file-ref";
/** Services required before the route can be claimed. */
const inject = ["webServer"];

// ── configuration ──────────────────────────────────────────────────────────
/** Recursive file-list cap (an entry bound, not a payload cap). */
const MAX_FILES = 500;
/** Directory names always skipped during the walk (configurable override). */
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
 * @param raw - the raw session id.
 * @returns the escaped, single segment usable as a directory name.
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
 * walk: magic + descriptor + block iterator + optional checksum). A torn final
 * frame yields a `tornStart`; complete frames are returned.
 * @param buffer - complete bytes of a session artifact.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
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
 * independently-compressed first zstd frame. Returns undefined when the file
 * has no readable first record.
 * @param path - absolute log path.
 * @param isZstd - whether the physical encoding is the zstd container.
 * @returns the parsed header line object, or undefined.
 */
async function readHeaderLine(path, isZstd) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return void 0;
  }
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
 * its header record. Scans the project/session directory tree (at most two
 * levels below the root) for the session-owned directory named by the
 * id-encoded segment.
 * @param root - the sessions root directory.
 * @param rawId - the client-supplied session id (traversal-encoded before use).
 * @returns `{ header, logPath }` when the session exists; null when unknown.
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

// ── recursive file listing ────────────────────────────────────────────────

/**
 * Recursively walk `cwd` collecting file metadata, bounded to MAX_FILES.
 * Directory traversal never follows symlinked directories (prevents cycles and
 * any escape outside the session cwd), and files that are symlinks are skipped
 * for the same read-only, in-cwd guarantee. Dot-entries and known ignore /
 * build dirs are omitted. When a query is present the walk only collects
 * entries whose relative path case-insensitively matches it, so the bounded
 * window stays query-relevant.
 * @param cwd - absolute session working directory.
 * @param query - non-empty substring to filter by (else collect all).
 * @param ignore - set of directory basenames to skip.
 * @returns `{ files, truncated }`.
 */
async function listFiles(cwd, query, ignore) {
  const files = [];
  let truncated = false;
  const needle = typeof query === "string" && query.trim() !== "" ? query.trim().toLowerCase() : "";

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
        if (needle !== "" && !(childRel.toLowerCase().includes(needle) || dirent.name.toLowerCase().includes(needle))) continue;
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
      const { files, truncated } = await listFiles(cwd, queryParam(url, "query"), ignore);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ cwd, files, truncated, noCwd: false }));
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

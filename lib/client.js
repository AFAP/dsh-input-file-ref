// dsh-input-file-ref — browser half.
//
// Registers a new '@' reference source ("file") in the DeepSeek Harness input
// trigger pipeline. Typing `@` in a session with a working directory opens a
// file picker; candidates come from the host half's GET /api/input-file-list
// (which resolves the session's cwd from its durable header and lists files).
//
// Picks use the insert + codec path: one U+FFFC placeholder is placed in the
// draft and a chip (`@src/main.ts`) is derived downstream; on submit the
// source codec serializes each occurrence to the model-visible form
// `<file>src/main.ts</file>`, which the model reads with its own fs tool
// rooted at the session cwd.
//
// This file is served as a classic script and registers its factory through
// window.__ModuleLoader__.load(). The factory only builds a source object and
// registers it — no React component — so it requires nothing at all beyond the
// services the framework injects (inputTriggers, locale). No JSX, no seeds.
window.__ModuleLoader__.load({
  id: "dsh-input-file-ref",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── constants ─────────────────────────────────────────────────────────
    /** Plugin-owned locale namespace. */
    var NS = "input-file-ref";
    /** Candidate kind for the "no working directory" hint row. */
    var HINT = "hint";
    /** Human-size formatting: {bytes, text} tuples, byte-exact boundaries. */
    var SIZE_STEPS = [
      [1, "B"],
      [1024, "KB"],
      [1024 * 1024, "MB"],
      [1024 * 1024 * 1024, "GB"]
    ];

    // ── locale dictionaries (source of truth: zh key set) ─────────────────
    var zh = {
      "group.file": "文件",
      "nocwd": "当前会话没有工作目录",
      "nocwd.detail": "请先选择工作目录，再使用『@』引用文件。",
      "loading": "正在列出文件…",
      "load.error": "无法列出文件：{error}",
      "result.over": "结果过多，请继续输入过滤。",
      "size": "{size} {unit}"
    };
    var en = {
      "group.file": "Files",
      "nocwd": "This session has no working directory",
      "nocwd.detail": "Pick a working directory first, then reference files with '@'.",
      "loading": "Listing files…",
      "load.error": "Unable to list files: {error}",
      "result.over": "Too many results — keep typing to filter.",
      "size": "{size} {unit}"
    };

    // ── helpers ───────────────────────────────────────────────────────────
    function formatSize(bytes, t) {
      var value = bytes;
      var unit = "B";
      for (var i = SIZE_STEPS.length - 1; i >= 0; i--) {
        if (bytes >= SIZE_STEPS[i][0]) {
          value = bytes / SIZE_STEPS[i][0];
          unit = SIZE_STEPS[i][1];
          break;
        }
      }
      var rounded = unit === "B" ? String(value) : String(Math.round(value * 10) / 10);
      return t("size", { size: rounded, unit: unit });
    }

    /**
     * Case-insensitive substring filter that ranks basename matches first.
     * @param files - host-returned entries ({path,size}).
     * @param needle - trimmed, lowercased query ("" matches everything).
     * @returns entries filtered and ranked by basename-priority.
     */
    function filterFiles(files, needle) {
      if (needle === "") return files;
      var matchBase = [];
      var matchPath = [];
      for (var i = 0; i < files.length; i++) {
        var entry = files[i];
        var base = entry.path.slice(entry.path.lastIndexOf("/") + 1).toLowerCase();
        if (base.includes(needle)) matchBase.push(entry);
        else if (entry.path.toLowerCase().includes(needle)) matchPath.push(entry);
      }
      return matchBase.concat(matchPath);
    }

    /**
     * Turn one cached session entry into the candidate rows for a query. No-session
     * and error states fold into a single non-selectable hint row; a true listing
     * yields one row per (filtered) file, plus an optional "too many results" hint.
     * @param entry - the cached session entry.
     * @param req - the candidate request (query).
     * @param tt - bound translate function for this namespace.
     * @returns the candidate array for one menu group.
     */
    function buildCandidates(entry, req, tt) {
      if (entry.state === "nocwd") {
        return [{ name: tt("nocwd"), description: tt("nocwd.detail"), icon: "⚠️", kind: HINT }];
      }
      if (entry.state === "error") {
        return [{ name: tt("load.error", { error: entry.error || "" }), icon: "🛑", kind: HINT }];
      }
      var needle = (req.query || "").trim().toLowerCase();
      var files = filterFiles(entry.files, needle);
      var out = [];
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        out.push({
          name: file.path,
          description: formatSize(file.size, tt),
          icon: "📄",
          ref: file.path,
          kind: "file"
        });
      }
      if (entry.truncated && out.length > 0) {
        out.push({ name: tt("result.over"), icon: "…", kind: HINT });
      }
      return out;
    }

    // ── plugin body ───────────────────────────────────────────────────────
    var inject = ["inputTriggers", "locale"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-input-file-ref: dictionaries");

      // Per-session file-list cache: { state, files, truncated, t() }
      var cache = new Map(); // sessionId -> { state, files, truncated }
      var fetches = new Map(); // sessionId -> { promise, abort }
      var listeners = new Map(); // sessionId -> Set<listener>
      var t = ctx.locale.bind(NS);

      function notify(sessionId) {
        var set = listeners.get(sessionId);
        if (!set) return;
        for (var _i = 0; _i < set.length; _i++) {
          try {
            set[_i]();
          } catch (error) {
            console.error("[dsh-input-file-ref] lexicon listener failed:", error);
          }
        }
      }

      function fetchOnce(sessionId, signal) {
        var existing = fetches.get(sessionId);
        if (existing !== void 0) return existing;
        var controller = new AbortController();
        var promise = fetch("/api/input-file-list?sessionId=" + encodeURIComponent(sessionId), {
          signal: controller.signal,
          headers: { accept: "application/json" }
        }).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          cache.set(sessionId, {
            state: data && data.noCwd ? "nocwd" : "ready",
            files: data && Array.isArray(data.files) ? data.files : [],
            truncated: !!(data && data.truncated)
          });
          notify(sessionId);
          return cache.get(sessionId);
        }, function (error) {
          if (error && error.name === "AbortError") return void 0;
          cache.set(sessionId, { state: "error", files: [], truncated: false, error: error instanceof Error ? error.message : String(error) });
          notify(sessionId);
          return cache.get(sessionId);
        });
        var entry = { promise: promise, controller: controller };
        fetches.set(sessionId, entry);
        promise.finally(function () {
          if (fetches.get(sessionId) === entry) fetches.delete(sessionId);
        });
        return entry.promise;
      }

      function entryOf(sessionId) {
        var hit = cache.get(sessionId);
        if (hit === void 0) return null;
        return hit;
      }

      var source = {
        trigger: "@",
        name: "file",
        order: 1,
        warm: function warm(session) {
          if (entryOf(session.sessionId) !== null) return;
          fetchOnce(session.sessionId, void 0).catch(function () {});
        },
        candidates: function candidates(session, req) {
          var sessionId = session.sessionId;
          var hit = entryOf(sessionId);
          if (hit !== null) return Promise.resolve(buildCandidates(hit, req, t));
          var pending = fetches.get(sessionId);
          if (pending !== void 0) {
            return pending.promise.then(function (entry) {
              if (entry === void 0 || entry === null) return [];
              return buildCandidates(entry, req, t);
            });
          }
          return fetchOnce(sessionId, req.signal).then(function (entry) {
            if (entry === void 0 || entry === null) return [];
            return buildCandidates(entry, req, t);
          });
        },
        onPick: function onPick(pick) {
          var candidate = pick.candidate;
          if (candidate.kind === HINT) return void 0;
          var ref = candidate.ref;
          return {
            insert: {
              source: "file",
              ref: ref,
              label: "@" + ref,
              clipboardText: "@" + ref
            }
          };
        },
        lexicon: function lexicon(session) {
          var entry = entryOf(session.sessionId);
          if (entry === null || entry.state !== "ready") return void 0;
          var out = [];
          for (var i = 0; i < entry.files.length; i++) out.push(entry.files[i].path);
          return out;
        },
        subscribeLexicon: function subscribeLexicon(session, listener) {
          var sessionId = session.sessionId;
          var set = listeners.get(sessionId) || [];
          set.push(listener);
          listeners.set(sessionId, set);
          return function () {
            var cur = listeners.get(sessionId) || [];
            var idx = cur.indexOf(listener);
            if (idx >= 0) {
              cur.splice(idx, 1);
              if (cur.length === 0) listeners.delete(sessionId);
              else listeners.set(sessionId, cur);
            }
          };
        },
        codec: {
          clipboardText: function clipboardText(ref) { return "@" + ref; },
          serialize: function serialize(ref, signal) { return Promise.resolve("<file>" + ref + "</file>"); }
        }
      };

      var inputTriggers = ctx.get("inputTriggers");
      ctx.effect(function () {
        var unregister = inputTriggers.registerSource(source);
        return unregister;
      }, "dsh-input-file-ref: @ file source");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map

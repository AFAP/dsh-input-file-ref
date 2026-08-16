// dsh-input-file-ref — browser half.
//
// Adds a dedicated file picker to the DeepSeek Harness composer '@' trigger:
// typing `@` opens a custom, full-width panel (registered into the
// conversation.input.overlay list slot) with
//   - a search bar on top (also mirrors characters typed after '@' in the
//     composer; more characters reveal more results),
//   - single-level directory browsing with drill-down into every subfolder
//     (including dot-dirs / node_modules / target — visible when navigating,
//     never in search results),
//   - relative full paths with mid-ellipsis when long,
//   - a 50-result default cap that grows as the query lengthens.
//
// The built-in trigger MenuView is hidden (data-ifr-hidden) while this panel
// is open, and the '@' file source still registers a sentinel candidate so the
// menu store stays open. Picking a file replaces the "@…" trigger token with
// the full relative path as ordinary, editable text (via the scoped
// slash/input-insert-text event, using the controller's live hit span so the
// draft-revision CAS stays intact).
window.__ModuleLoader__.load({
  id: "dsh-input-file-ref",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;

    // ── styles (injected like the shipped bundles, themed via DSW vars) ────
    var css =
      ".ifr_menu{box-sizing:border-box;z-index:120;position:absolute;bottom:calc(100% + 4px);left:0;right:0;" +
      "display:flex;flex-direction:column;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-inverted);" +
      "border-radius:12px;box-shadow:var(--dsw-shadow-lv3);max-height:min(440px,64vh);overflow:hidden;padding:6px}" +
      ".ifr_head{display:flex;flex-direction:column;gap:4px;padding:2px 2px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}" +
      ".ifr_search{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);" +
      "border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);" +
      "font-family:var(--dsw-font-family);font-size:13px;line-height:20px;outline:none}" +
      ".ifr_search:focus{border-color:var(--dsw-alias-state-business-primary)}" +
      ".ifr_path{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}" +
      ".ifr_body{display:flex;flex-direction:column;gap:1px;overflow-y:auto;padding-top:4px}" +
      ".ifr_row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:5px 8px;" +
      "border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);" +
      "font-family:var(--dsw-font-family);font-size:13px;line-height:20px;text-align:left;cursor:pointer}" +
      ".ifr_row:hover,.ifr_rowActive{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".ifr_rowIcon{flex:none;width:16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}" +
      ".ifr_rowMain{flex:1;min-width:0;display:flex;align-items:baseline;gap:10px}" +
      ".ifr_rowName{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);font-size:12px;" +
      "white-space:nowrap;text-overflow:ellipsis;overflow:hidden}" +
      ".ifr_rowDesc{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}" +
      ".ifr_rowGo{flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px}" +
      ".ifr_hintRow{color:var(--dsw-alias-label-tertiary);cursor:default;justify-content:center;font-size:12px}" +
      "div[role=listbox][data-ifr-hidden]{display:none!important}";
    var tagId = "dsh-input-file-ref/input-file-ref.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-input-file-ref";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    var styles = {
      menu: "ifr_menu",
      head: "ifr_head",
      search: "ifr_search",
      path: "ifr_path",
      body: "ifr_body",
      row: "ifr_row",
      rowActive: "ifr_rowActive",
      rowIcon: "ifr_rowIcon",
      rowMain: "ifr_rowMain",
      rowName: "ifr_rowName",
      rowDesc: "ifr_rowDesc",
      rowGo: "ifr_rowGo",
      hintRow: "ifr_hintRow"
    };

    // ── constants & helpers ───────────────────────────────────────────────
    /** Plugin-owned locale namespace. */
    var NS = "input-file-ref";
    /** Human-size steps {bytes, unit}. */
    var SIZE_STEPS = [[1, "B"], [1024, "KB"], [1024 * 1024, "MB"], [1024 * 1024 * 1024, "GB"]];
    /** Result caps revealed as the query lengthens (item: show 50 by default). */
    var CAP_0 = 50;
    var CAP_1 = 100;
    var CAP_3 = 200;
    var CAP_5 = 500;

    /** How many rows are allowed for a query: more criteria → more results. */
    function visibleLimit(query) {
      var len = (query || "").trim().length;
      if (len === 0) return CAP_0;
      if (len <= 2) return CAP_1;
      if (len <= 4) return CAP_3;
      return CAP_5;
    }

    /** Full path with a middle ellipsis when over `max` — head + "…" + tail. */
    function midEllipsis(path, max) {
      if (path.length <= max) return path;
      var keep = max - 1;
      var head = Math.ceil(keep * 0.35);
      var tail = keep - head;
      return path.slice(0, head) + "…" + path.slice(-tail);
    }

    /** Human-readable file size ("2.3 KB"). */
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

    /** Parent of a relative "/"-joined path ("" for the root). */
    function parentOf(rel) {
      var at = rel.lastIndexOf("/");
      return at === -1 ? "" : rel.slice(0, at);
    }

    // ── bilingual dictionaries (source of truth: zh key set) ──────────────
    var zh = {
      "up": "↑ 上级目录",
      "root": "当前目录",
      "search.placeholder": "搜索文件 — 输入更多关键字显示更多结果",
      "search.aria": "输入关键字搜索文件",
      "cwd": "当前目录：{dir}",
      "searching": "搜索 “{q}”",
      "panel.aria": "文件选择器",
      "loading": "正在加载…",
      "nocwd": "当前会话没有工作目录",
      "nocwd.detail": "请先选择工作目录，再使用『@』引用文件。",
      "load.error": "无法列出文件：{error}",
      "more": "结果未全部显示，请输入更多关键字",
      "size": "{size} {unit}"
    };
    var en = {
      "up": "↑ Parent directory",
      "root": "Current directory",
      "search.placeholder": "Search files — type more to reveal more results",
      "search.aria": "Filter files by keyword",
      "cwd": "Current: {dir}",
      "searching": "Searching “{q}”",
      "panel.aria": "File picker",
      "loading": "Loading…",
      "nocwd": "This session has no working directory",
      "nocwd.detail": "Pick a working directory first, then reference files with '@'.",
      "load.error": "Unable to list files: {error}",
      "more": "Not all results shown — type more to narrow.",
      "size": "{size} {unit}"
    };

    // ── plugin body ───────────────────────────────────────────────────────
    var inject = ["inputTriggers", "sessions", "slots", "locale"];

    /**
     * The custom file picker panel. Renders while the '@' trigger menu is open;
     * the built-in MenuView is hidden by the component's layout effect.
     */
    function FilePickerMenu(props) {
      var menu = props.menu;
      var controller = props.controller;
      var actx = props.actx;
      var sessionId = props.sessionId;
      var onDismiss = props.onDismiss;
      var t = props.t;

      var state = React.useSyncExternalStore(
        function (cb) { return menu.subscribe(cb); },
        function () { return menu.getSnapshot(); },
        function () { return { open: false, hit: null, groups: [], highlight: null, generation: 0 }; }
      );
      var open = state.open && state.hit !== null && state.hit.trigger === "@";
      var composerQuery = open ? state.hit.query : "";

      var focusedPair = React.useState(false);
      var focused = focusedPair[0];
      var setFocused = focusedPair[1];
      var inputPair = React.useState("");
      var inputText = inputPair[0];
      var setInputText = inputPair[1];
      var dirPair = React.useState("");
      var dir = dirPair[0];
      var setDir = dirPair[1];
      var dataPair = React.useState({ status: "idle", dirs: [], files: [], truncated: false, error: "" });
      var data = dataPair[0];
      var setData = dataPair[1];
      var highlightPair = React.useState(0);
      var highlight = highlightPair[0];
      var setHighlight = highlightPair[1];
      var rootRef = React.useRef(null);
      var inputRef = React.useRef(null);

      var query = focused ? inputText : composerQuery;
      var trimmed = (query || "").trim();

      // Reset the browse position and highlight each time the panel opens.
      React.useEffect(function () {
        if (open) {
          setDir("");
          setHighlight(0);
        }
      }, [open]);

      // Mirror the composer's '@…' query into the search bar (unless the user
      // is typing in the bar itself), and clear on close.
      React.useEffect(function () {
        if (!focused) setInputText(composerQuery);
      }, [composerQuery, focused]);

      // Fetch listings: search (query non-empty) or browse (current dir).
      React.useEffect(function () {
        if (!open) return;
        var sup = new AbortController();
        var timer = null;
        var run = function () {
          var q = (focused ? inputText : composerQuery).trim();
          var parts = "sessionId=" + encodeURIComponent(sessionId);
          if (q !== "") parts += "&query=" + encodeURIComponent(q);
          else if (dir !== "") parts += "&dir=" + encodeURIComponent(dir);
          setData({ status: "loading", dirs: [], files: [], truncated: false, error: "" });
          fetch("/api/input-file-list?" + parts, { signal: sup.signal, headers: { accept: "application/json" } })
            .then(function (res) {
              if (!res.ok) throw new Error("HTTP " + res.status);
              return res.json();
            })
            .then(function (payload) {
              if (payload && payload.noCwd) {
                setData({ status: "nocwd", dirs: [], files: [], truncated: false, error: "" });
                return;
              }
              setData({
                status: "ready",
                dirs: payload && Array.isArray(payload.dirs) ? payload.dirs : [],
                files: payload && Array.isArray(payload.files) ? payload.files : [],
                truncated: !!(payload && payload.truncated),
                error: ""
              });
            })
            .catch(function (error) {
              if (error && error.name === "AbortError") return;
              setData({ status: "error", dirs: [], files: [], truncated: false, error: error instanceof Error ? error.message : String(error) });
            });
        };
        if (trimmed !== "") timer = setTimeout(run, 160);
        else run();
        return function () {
          if (timer !== null) clearTimeout(timer);
          sup.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, dir, query, sessionId]);

      // Hide the built-in trigger MenuView while this panel is open.
      React.useLayoutEffect(function () {
        if (typeof document === "undefined") return;
        var el = document.querySelector('[data-composer-card] div[role="listbox"]');
        if (!open) {
          if (el && el.dataset.ifrHidden) delete el.dataset.ifrHidden;
          return;
        }
        if (el && !el.dataset.ifrHidden) el.dataset.ifrHidden = "true";
        return function () {
          if (el && el.dataset.ifrHidden) delete el.dataset.ifrHidden;
        };
      }, [open]);

      // Dismiss on pointer-down outside the composer card.
      React.useEffect(function () {
        if (!open || typeof document === "undefined") return;
        function onPointerDown(e) {
          if (!(e.target instanceof Node)) return;
          if (rootRef.current && rootRef.current.contains(e.target)) return;
          var card = rootRef.current && rootRef.current.closest("[data-composer-card]");
          if (card && card.contains(e.target)) return;
          onDismiss();
        }
        document.addEventListener("pointerdown", onPointerDown, true);
        return function () { document.removeEventListener("pointerdown", onPointerDown, true); };
      }, [open, onDismiss]);

      // ── rows ────────────────────────────────────────────────────────────
      var rows = [];
      if (data.status === "ready") {
        if (dir !== "") rows.push({ kind: "up", key: "..", label: t("up"), icon: "⬆", title: dir });
        var cap = visibleLimit(trimmed);
        var i;
        for (i = 0; i < data.dirs.length && rows.length < cap; i++) {
          var drow = { kind: "dir", key: "d:" + data.dirs[i], rel: dir === "" ? data.dirs[i] : dir + "/" + data.dirs[i], icon: "📁" };
          drow.label = midEllipsis(drow.rel + "/", 64);
          drow.title = drow.rel + "/";
          rows.push(drow);
        }
        for (i = 0; i < data.files.length && rows.length < cap; i++) {
          var f = data.files[i];
          rows.push({ kind: "file", key: "f:" + f.path, ref: f.path, label: midEllipsis(f.path, 64), title: f.path, desc: formatSize(f.size, t), icon: "📄" });
        }
        if (data.truncated || data.dirs.length + data.files.length > cap || rows.length >= cap) {
          rows.push({ kind: "hint", key: "-more", label: t("more"), icon: "…" });
        }
      } else if (data.status === "nocwd") {
        rows.push({ kind: "hint", key: "-nocwd", label: t("nocwd"), desc: t("nocwd.detail"), icon: "⚠️" });
      } else if (data.status === "error") {
        rows.push({ kind: "hint", key: "-err", label: t("load.error", { error: data.error }), icon: "🛑" });
      } else {
        rows.push({ kind: "hint", key: "-loading", label: t("loading"), icon: "…" });
      }

      // Keyboard: capture-phase takeover of menu keys while the panel is open
      // (the composer only preventDefaults; capture lets us own them cleanly).
      var rowsRef = React.useRef(rows);
      rowsRef.current = rows;
      var hlRef = React.useRef(highlight);
      hlRef.current = highlight;
      var actionsRef = React.useRef({ pick: null, dismiss: onDismiss });
      React.useEffect(function () {
        if (!open || typeof document === "undefined") return;
        function onKeyDown(e) {
          if (e.isComposing || e.nativeEvent.isComposing) return;
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          var rs = rowsRef.current;
          if (e.key === "Escape") { actionsRef.current.dismiss(); return; }
          if (rs.length === 0) return;
          if (e.key === "ArrowDown") { setHighlight(function (h) { return (h + 1) % rs.length; }); return; }
          if (e.key === "ArrowUp") { setHighlight(function (h) { return (h - 1 + rs.length) % rs.length; }); return; }
          if (e.key === "Enter") {
            if (e.shiftKey || e.repeat) return;
            if (actionsRef.current.pick) actionsRef.current.pick(rs[hlRef.current]);
          }
        }
        document.addEventListener("keydown", onKeyDown, true);
        return function () { document.removeEventListener("keydown", onKeyDown, true); };
      }, [open]);

      // ── actions ─────────────────────────────────────────────────────────
      function pickRow(row) {
        if (!row) return;
        if (row.kind === "file") insertFile(row.ref);
        else if (row.kind === "dir") { setDir(row.rel); setHighlight(0); }
        else if (row.kind === "up") { setDir(parentOf(dir)); setHighlight(0); }
      }
      actionsRef.current.pick = pickRow;
      actionsRef.current.dismiss = onDismiss;

      function insertFile(ref) {
        var span = controller.hit ? controller.hit.span : void 0;
        if (span === void 0) {
          onDismiss();
          return;
        }
        try {
          // Plain-text backfill: replace the "@…" trigger token with the full
          // relative path, preceded and followed by a single space, so it is
          // visible and editable in the composer as ordinary text.
          actx.bail(actx, "slash/input-insert-text", {
            text: " " + ref + " ",
            span: span
          });
        } catch (error) {
          console.error("[dsh-input-file-ref] insert failed:", error);
        }
        onDismiss();
      }

      if (!open) return null;

      return jsxs("div", {
        ref: rootRef,
        className: styles.menu,
        role: "dialog",
        "aria-label": t("panel.aria"),
        children: [
          jsxs("div", {
            className: styles.head,
            children: [
              jsx("input", {
                ref: inputRef,
                type: "text",
                className: styles.search,
                value: inputText,
                placeholder: t("search.placeholder"),
                spellCheck: false,
                autoComplete: "off",
                "aria-label": t("search.aria"),
                onChange: function (e) { setInputText(e.target.value); },
                onFocus: function () { setFocused(true); },
                onBlur: function () { setFocused(false); setInputText(composerQuery); }
              }),
              jsx("div", {
                className: styles.path,
                title: trimmed === "" ? (dir === "" ? t("root") : dir) : trimmed,
                children: trimmed !== "" ? t("searching", { q: trimmed }) : t("cwd", { dir: dir === "" ? t("root") : midEllipsis(dir, 80) })
              })
            ]
          }),
          jsx("div", {
            className: styles.body,
            children: rows.map(function (row, index) {
              return jsxs("button", {
                type: "button",
                key: row.key,
                className: styles.row + (index === highlight ? " " + styles.rowActive : "") + (row.kind === "hint" ? " " + styles.hintRow : ""),
                onMouseEnter: function () { setHighlight(index); },
                onClick: function () { pickRow(row); },
                children: [
                  jsx("span", { className: styles.rowIcon, "aria-hidden": true, children: row.icon }),
                  jsxs("span", {
                    className: styles.rowMain,
                    children: [
                      jsx("span", { className: styles.rowName, title: row.title || row.label, children: row.label }),
                      row.desc !== void 0 ? jsx("span", { className: styles.rowDesc, children: row.desc }) : null
                    ]
                  }),
                  row.kind === "dir" || row.kind === "up" ? jsx("span", { className: styles.rowGo, "aria-hidden": true, children: "›" }) : null
                ]
              }, row.key);
            })
          })
        ]
      });
    }

    /**
     * Client plugin body: register the dictionaries, the '@' file source (a
     * sentinel candidate keeps the trigger menu store open), and the custom
     * picker panel into the input overlay slot.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-input-file-ref: dictionaries");

      var t = ctx.locale.bind(NS);

      var source = {
        trigger: "@",
        name: "file",
        order: 1,
        candidates: function () {
          // Sentinel row: keeps the file group non-empty so the trigger menu
          // stays open; the real UI is the custom panel. Picking it does nothing.
          return Promise.resolve([{ name: t("loading"), icon: "…", kind: "hint" }]);
        },
        onPick: function () {
          return void 0;
        }
      };

      var inputTriggers = ctx.get("inputTriggers");
      ctx.effect(function () {
        var unregister = inputTriggers.registerSource(source);
        return unregister;
      }, "dsh-input-file-ref: @ file source");

      ctx.slots.inject("conversation.input.overlay", function () {
        return ctx.slots.register({
          name: "conversation.input.overlay",
          id: "input-file-ref-menu",
          order: 1,
          locale: NS,
          inject: function (sessionId) {
            var actx = ctx.get("sessions").scope(sessionId);
            if (actx === void 0) throw new Error(`dsh-input-file-ref: session "${String(sessionId)}" resolved no scope`);
            var controller = inputTriggers.sessionOf(actx);
            return {
              sessionId: sessionId,
              actx: actx,
              menu: controller.menu,
              controller: controller,
              onDismiss: function () { controller.dismiss(); }
            };
          }
        }, FilePickerMenu);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
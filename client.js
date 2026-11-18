/**
 * 浏览器半边：侧栏入口 + 主区页面。
 *
 * 面板干两件事，都是用户直接要求的那两个开关：
 *  1. 逐模型的「显示 / 不显示」—— 决定它进不进 dsh 的模型选择器；
 *  2. 「无工具文本通道 / 带工具 agent 通道」的切换。
 * 另外把 agent 通道必需的三项（权限策略、工作目录、agent）放在同一页里，
 * 因为不给它们就没有一条能安全使用的 agent 通道：默认的 build agent 是
 * 全放行，插件必须显式下发权限策略，否则那个「权限」概念在界面上是假的。
 *
 * 加载约定（抄自本机已装的同族面板）：包成
 * window.__ModuleLoader__.load({ id, factory })，工厂返回 exports.apply / exports.inject；
 * 座位用 ctx.slots.inject 注入，只有宿主声明了该座位才会真正挂上。
 *
 * 所有 fetch 都是【文档相对】路径（api/... 无前导斜杠）：GUI 用 <base href="./">，
 * 根绝对路径会逃出子路径部署，请求根本到不了插件路由（issue #1707）。
 *
 * @module client.js
 */
window.__ModuleLoader__.load({
  id: "dsh-local-opencode",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    /** 侧栏行与主区页面共用的稳定 id（两处必须一致，否则点不动）。 */
    var PANEL_ID = "local-opencode";
    /** 侧栏行序：Plugins 0 / Schedule 10 / task-board 20 / skill-explorer 30 → 本插件 40。 */
    var PANEL_ORDER = 40;

    /** 宿主路由（src/index.js 的 api()），一律文档相对。 */
    var API = {
      status: "api/local-opencode/status",
      refresh: "api/local-opencode/refresh",
      visibility: "api/local-opencode/visibility",
      channel: "api/local-opencode/channel",
      agentSettings: "api/local-opencode/agent-settings",
      agents: "api/local-opencode/agents",
    };

    var ZH = {
      entry: "Local OpenCode",
      title: "Local OpenCode",
      subtitle: "本机 opencode 的零成本模型",
      refresh: "刷新目录",
      refreshing: "刷新中…",
      channelTitle: "通道",
      channelText: "无工具文本通道",
      channelTextDesc: "一次进一次出，不调用任何工具；不会读写你的文件。",
      channelAgent: "带工具 agent 通道",
      channelAgentDesc: "交给 opencode 的 agent 循环，可读写文件、执行命令。",
      agentWarning: "带工具通道下模型会真的读写文件。放行范围由下面的权限策略决定，越权动作会被自动拒绝。",
      permissionTitle: "权限策略",
      permissionRead: "只放行读",
      permissionReadDesc: "读、搜、列目录放行；写文件与执行命令一律拒绝。",
      permissionAll: "全部放行",
      permissionAllDesc: "模型可以改你的文件、执行命令。只在明确知情时用。",
      permissionReject: "一律拒绝",
      permissionRejectDesc: "所有工具都被拒；只剩多轮推理。",
      workingDirTitle: "工作目录",
      workingDirDesc: "工具在这个目录里执行。留空则沿用 opencode 自己的位置。",
      workingDirPlaceholder: "例如 C:/Users/HP/Desktop/默认工作区",
      agentTitle: "opencode agent",
      agentDesc: "使用哪个 opencode agent；留空用服务端默认。",
      agentDefault: "（服务端默认）",
      modelsTitle: "模型显示",
      modelsDesc: "关掉的模型不会出现在 dsh 的模型选择器里，配置仍然保留。",
      groupFree: "显示中 · 免费",
      groupPaid: "显示中 · 计费",
      groupHidden: "已隐藏",
      groupUnlisted: "计费未纳入",
      groupUnavailable: "不可用",
      show: "显示",
      hide: "不显示",
      empty: "还没有模型目录。先点「刷新目录」。",
      emptyHidden: "没有隐藏任何模型。",
      connected: "已连接",
      disconnected: "未连接",
      idle: "还没连过",
      working: "处理中…",
      save: "保存",
      failed: "操作失败：",
      noAgents: "没有取到 agent 列表；留空即用服务端默认。",
      loadHint: "正在读取状态…",
    };

    var EN = {
      entry: "Local OpenCode",
      title: "Local OpenCode",
      subtitle: "Free models from the local opencode",
      refresh: "Refresh catalog",
      refreshing: "Refreshing…",
      channelTitle: "Channel",
      channelText: "Text only (no tools)",
      channelTextDesc: "One request, one answer, no tool calls. Never touches your files.",
      channelAgent: "Agent (with tools)",
      channelAgentDesc: "Runs through opencode's agent loop; may read/write files and run commands.",
      agentWarning: "The agent channel really reads and writes files. What it may do is set by the permission policy below; anything beyond it is rejected.",
      permissionTitle: "Permission policy",
      permissionRead: "Read only",
      permissionReadDesc: "Read/search/list allowed; writes and commands rejected.",
      permissionAll: "Allow everything",
      permissionAllDesc: "The model may modify your files and run commands. Use knowingly.",
      permissionReject: "Reject everything",
      permissionRejectDesc: "All tools denied; only multi-step reasoning remains.",
      workingDirTitle: "Working directory",
      workingDirDesc: "Tools run inside this directory. Empty means opencode's own location.",
      workingDirPlaceholder: "e.g. C:/Users/HP/Desktop/workspace",
      agentTitle: "opencode agent",
      agentDesc: "Which opencode agent to use; empty means the server default.",
      agentDefault: "(server default)",
      modelsTitle: "Model visibility",
      modelsDesc: "Hidden models disappear from the dsh model picker; their settings are kept.",
      groupFree: "Shown · free",
      groupPaid: "Shown · paid",
      groupHidden: "Hidden",
      groupUnlisted: "Paid, not included",
      groupUnavailable: "Unavailable",
      show: "Show",
      hide: "Hide",
      empty: "No catalog yet. Press Refresh catalog.",
      emptyHidden: "Nothing hidden.",
      connected: "connected",
      disconnected: "disconnected",
      idle: "never connected",
      working: "Working…",
      save: "Save",
      failed: "Failed: ",
      noAgents: "No agent list; leaving it empty uses the server default.",
      loadHint: "Loading…",
    };

    var t = String(navigator.language || "").toLowerCase().indexOf("zh") === 0 ? ZH : EN;

    /** 主题变量取自 dsh 的 alias token；缺变量时退回中性灰，绝不硬编码亮色。 */
    var C = {
      text: "var(--dsw-alias-label-primary, inherit)",
      dim: "var(--dsw-alias-label-dimmed, #888)",
      border: "var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
      layer: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.08))",
      layer2: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))",
      accent: "var(--dsw-alias-brand-primary, #4f7cff)",
      danger: "var(--dsw-alias-label-danger, #c0392b)",
      ok: "var(--dsw-alias-label-success, #2e8b57)",
    };

    function request(path, options) {
      var init = { method: (options && options.method) || "GET", cache: "no-store" };
      if (options && options.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(options.body);
      }
      return fetch(path, init).then(function (response) {
        return response.json().catch(function () { return undefined; }).then(function (body) {
          if (response.ok === true) return body;
          var message = body && typeof body.error === "string" ? body.error : "HTTP " + response.status;
          throw new Error(message);
        });
      });
    }

    /**
     * 面板状态：宿主是唯一事实源，每次动作都用路由返回的 statusView 整体替换。
     * 不做乐观更新——「显示/不显示」改的是选择器的成员表，猜错了比慢半拍更难查。
     */
    function createStore() {
      var state = { status: undefined, busy: false, error: undefined };
      var listeners = new Set();
      function emit() { listeners.forEach(function (fn) { fn() }) }
      function set(patch) {
        state = Object.assign({}, state, patch);
        emit();
      }
      return {
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn) };
        },
        get: function () { return state },
        load: function () {
          var self = this;
          return request(API.status).then(function (status) { set({ status: status, error: undefined }) }).catch(function (error) { set({ error: String(error.message || error) }) });
        },
        act: function (path, body) {
          var self = this;
          set({ busy: true, error: undefined });
          return request(path, { method: "POST", body: body })
            .then(function (status) { if (status && status.visibility) set({ status: status, busy: false }) ; else return self.load().then(function () { set({ busy: false }) }) })
            .catch(function (error) { set({ busy: false, error: String(error.message || error) }) });
        },
        loadAgents: function () {
          var self = this;
          return request(API.agents).then(function (payload) {
            var status = self.get().status;
            if (status === undefined || payload === undefined) return;
            set({ status: Object.assign({}, status, { agents: payload.agents || [] }) });
          }).catch(function () { /* 拿不到就留空：留空等于服务端默认，不影响可用性 */ });
        },
      };
    }

    function badge(text, tone) {
      var color = tone === "danger" ? C.danger : tone === "ok" ? C.ok : C.dim;
      return h("span", {
        key: "b-" + text,
        style: {
          fontSize: 11, lineHeight: "16px", padding: "0 6px", borderRadius: 6,
          border: "1px solid " + C.border, color: color, whiteSpace: "nowrap",
        },
      }, text);
    }

    function button(label, onClick, options) {
      var opt = options || {};
      return h("button", {
        type: "button",
        onClick: onClick,
        disabled: opt.disabled === true,
        style: {
          appearance: "none", font: "inherit", fontSize: 12, lineHeight: "20px",
          padding: "2px 10px", borderRadius: 7, cursor: opt.disabled === true ? "default" : "pointer",
          border: "1px solid " + (opt.active === true ? C.accent : C.border),
          background: opt.active === true ? C.accent : "transparent",
          color: opt.active === true ? "#fff" : (opt.disabled === true ? C.dim : C.text),
          opacity: opt.disabled === true ? 0.55 : 1,
          whiteSpace: "nowrap",
        },
      }, label);
    }

    function section(title, description, children) {
      return h("section", { style: { marginBottom: 22 } },
        h("div", { style: { fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 3 } }, title),
        description === undefined ? null : h("div", { style: { fontSize: 11.5, color: C.dim, lineHeight: "17px", marginBottom: 9 } }, description),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, children));
    }

    function row(key, left, right) {
      return h("div", {
        key: key,
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          padding: "7px 10px", borderRadius: 8, border: "1px solid " + C.border, background: C.layer,
        },
      }, h("div", { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 3 } }, left), right);
    }

    function modelRow(row_, store, busy) {
      var shown = row_.hidden === false && (row_.group === "free" || row_.group === "paid");
      var left = [
        h("div", { key: "n", style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 12.5, color: C.text } }, row_.name),
          badge(row_.provider),
          row_.free === true ? badge("free", "ok") : badge("paid")),
        h("div", {
          key: "i",
          style: { fontSize: 11, color: C.dim, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis" },
        }, row_.id + (row_.contextWindow ? "  ·  " + Math.round(row_.contextWindow / 1000) + "k" : "")),
      ];
      var action = row_.toggleable === true
        ? button(shown ? t.hide : t.show, function () {
          store.act(API.visibility, { id: row_.id, hidden: shown });
        }, { disabled: busy, active: shown === false })
        : h("span", { style: { fontSize: 11, color: C.dim } }, "—");
      return row(row_.id, left, action);
    }

    function ModelGroup(props) {
      var items = props.items;
      if (items.length === 0) return null;
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 4 } },
        h("div", { style: { fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: C.dim, marginTop: 6 } }, props.title + " · " + items.length),
        items.map(function (item) { return modelRow(item, props.store, props.busy) }));
    }

    function AgentSection(props) {
      var status = props.status;
      var store = props.store;
      var busy = props.busy;
      var modes = status.permissionModes || ["allow-read", "allow-all", "reject"];
      var modeLabels = {};
      modeLabels["allow-read"] = { label: t.permissionRead, desc: t.permissionReadDesc };
      modeLabels["allow-all"] = { label: t.permissionAll, desc: t.permissionAllDesc };
      modeLabels["reject"] = { label: t.permissionReject, desc: t.permissionRejectDesc };
      var current = status.permissionMode;
      var agents = status.agents || [];

      var modeRows = modes.map(function (mode) {
        var meta = modeLabels[mode] || { label: mode, desc: "" };
        return h("div", {
          key: mode,
          style: {
            display: "flex", alignItems: "flex-start", gap: 9, padding: "8px 10px", borderRadius: 8,
            border: "1px solid " + (mode === current ? C.accent : C.border),
            background: mode === current ? C.layer2 : C.layer, cursor: busy ? "default" : "pointer",
          },
          onClick: busy ? undefined : function () { store.act(API.agentSettings, { permissionMode: mode }) },
        },
        h("span", {
          style: {
            width: 12, height: 12, marginTop: 3, borderRadius: 999, flex: "0 0 auto",
            border: "2px solid " + (mode === current ? C.accent : C.border),
            background: mode === current ? C.accent : "transparent",
          },
        }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
          h("span", { style: { fontSize: 12.5, color: C.text } }, meta.label),
          h("span", { style: { fontSize: 11, color: C.dim, lineHeight: "16px" } }, meta.desc)));
      });

      var dirInput = h("input", {
        type: "text",
        defaultValue: status.workingDirectory || "",
        placeholder: t.workingDirPlaceholder,
        onKeyDown: function (event) {
          if (event.key !== "Enter") return;
          store.act(API.agentSettings, { workingDirectory: event.currentTarget.value });
        },
        style: {
          font: "inherit", fontSize: 12, padding: "5px 8px", borderRadius: 7, minWidth: 0, flex: 1,
          border: "1px solid " + C.border, background: "transparent", color: C.text,
        },
      });
      var dirRow = h("div", { key: "dir", style: { display: "flex", gap: 8, alignItems: "center" } }, dirInput,
        button(t.save, function () { store.act(API.agentSettings, { workingDirectory: dirInput.value }) }, { disabled: busy }));

      var agentSelect = h("select", {
        defaultValue: status.agentName || "",
        onChange: function (event) { store.act(API.agentSettings, { agentName: event.currentTarget.value }) },
        style: {
          font: "inherit", fontSize: 12, padding: "5px 8px", borderRadius: 7,
          border: "1px solid " + C.border, background: "transparent", color: C.text,
        },
      },
      h("option", { value: "" }, t.agentDefault),
      agents.map(function (agent) { return h("option", { key: agent.id, value: agent.id }, agent.id) }));

      return h("div", null,
        h("div", {
          style: {
            display: "flex", gap: 8, alignItems: "flex-start", padding: "9px 11px", marginBottom: 16,
            borderRadius: 9, border: "1px solid " + C.danger, background: C.layer,
          },
        }, h("span", { style: { fontSize: 12, color: C.danger, lineHeight: "18px" } }, t.agentWarning)),
        section(t.permissionTitle, undefined, modeRows),
        section(t.workingDirTitle, t.workingDirDesc, dirRow),
        section(t.agentTitle, t.agentDesc,
          agents.length === 0 ? h("div", { style: { fontSize: 11.5, color: C.dim } }, t.noAgents) : agentSelect));
    }

    function PanelPage(props) {
      var store = props.store;
      var [snapshot, setSnapshot] = react.useState(store.get());

      react.useEffect(function () {
        var unsubscribe = store.subscribe(function () { setSnapshot(store.get()) });
        store.load().then(function () { store.loadAgents() });
        return unsubscribe;
      }, []);

      var status = snapshot.status;
      var busy = snapshot.busy === true;

      if (status === undefined) {
        return h("div", { style: { padding: "24px 26px", color: C.dim, fontSize: 12.5 } },
          snapshot.error === undefined ? t.loadHint : t.failed + snapshot.error);
      }

      var rows = status.visibility || [];
      var groups = { free: [], paid: [], hidden: [], unlisted: [], unavailable: [] };
      rows.forEach(function (item) {
        var bucket = groups[item.group];
        if (bucket !== undefined) bucket.push(item);
      });

      var connection = status.connection || {};
      var connectionText = connection.status === "connected" ? t.connected : connection.status === "idle" ? t.idle : t.disconnected;
      var shownCount = groups.free.length + groups.paid.length;

      var channelText = status.channel === "agent" ? t.channelAgent : t.channelText;

      var header = h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 20 } },
        h("div", null,
          h("div", { style: { fontSize: 16, fontWeight: 600, color: C.text } }, t.title),
          h("div", { style: { fontSize: 11.5, color: C.dim, marginTop: 3 } },
            t.subtitle + " · " + connectionText + " · " + shownCount + "/" + rows.length)),
        button(busy ? t.refreshing : t.refresh, function () {
          store.act(API.refresh, {});
        }, { disabled: busy }));

      var errorBar = snapshot.error === undefined ? null : h("div", {
        style: {
          marginBottom: 16, padding: "8px 11px", borderRadius: 8, fontSize: 12,
          border: "1px solid " + C.danger, color: C.danger,
        },
      }, t.failed + snapshot.error);

      var channelChoices = h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        h("div", {
          key: "text",
          onClick: busy || status.channel === "text" ? undefined : function () { store.act(API.channel, { channel: "text" }) },
          style: {
            flex: "1 1 210px", padding: "10px 12px", borderRadius: 9, cursor: busy ? "default" : "pointer",
            border: "1px solid " + (status.channel === "text" ? C.accent : C.border),
            background: status.channel === "text" ? C.layer2 : C.layer,
          },
        },
        h("div", { style: { fontSize: 12.5, color: C.text, fontWeight: status.channel === "text" ? 600 : 400 } }, t.channelText),
        h("div", { style: { fontSize: 11, color: C.dim, lineHeight: "16px", marginTop: 4 } }, t.channelTextDesc)),
        h("div", {
          key: "agent",
          onClick: busy || status.channel === "agent" ? undefined : function () { store.act(API.channel, { channel: "agent" }) },
          style: {
            flex: "1 1 210px", padding: "10px 12px", borderRadius: 9, cursor: busy ? "default" : "pointer",
            border: "1px solid " + (status.channel === "agent" ? C.accent : C.border),
            background: status.channel === "agent" ? C.layer2 : C.layer,
          },
        },
        h("div", { style: { fontSize: 12.5, color: C.text, fontWeight: status.channel === "agent" ? 600 : 400 } }, t.channelAgent),
        h("div", { style: { fontSize: 11, color: C.dim, lineHeight: "16px", marginTop: 4 } }, t.channelAgentDesc)));

      return h("div", {
        style: {
          padding: "22px 26px 40px", height: "100%", overflowY: "auto", boxSizing: "border-box",
          color: C.text, fontFamily: "inherit", maxWidth: 860,
        },
      },
      header,
      errorBar,
      section(t.channelTitle, undefined, channelChoices),
      status.channel === "agent" ? AgentSection({ status: status, store: store, busy: busy }) : null,
      section(t.modelsTitle, t.modelsDesc,
        rows.length === 0
          ? h("div", { style: { fontSize: 12, color: C.dim } }, t.empty)
          : [
            ModelGroup({ key: "free", title: t.groupFree, items: groups.free, store: store, busy: busy }),
            ModelGroup({ key: "paid", title: t.groupPaid, items: groups.paid, store: store, busy: busy }),
            ModelGroup({ key: "hidden", title: t.groupHidden, items: groups.hidden, store: store, busy: busy }),
            ModelGroup({ key: "unlisted", title: t.groupUnlisted, items: groups.unlisted, store: store, busy: busy }),
            ModelGroup({ key: "unavailable", title: t.groupUnavailable, items: groups.unavailable, store: store, busy: busy }),
          ].filter(function (node) { return node !== null })),
      h("div", { style: { fontSize: 11, color: C.dim } }, status.plugin && status.plugin.version ? "dsh-local-opencode " + status.plugin.version : "dsh-local-opencode"));
    }

    /** 侧栏行只画字形：行盒子、标签、高亮、折叠态都归宿主。 */
    function PanelIcon(props) {
      var size = props && props.size ? props.size : 16;
      return h("svg", {
        "data-dsh-panel-entry": PANEL_ID,
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.3",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      h("path", { d: "M2.4 4.6h11.2v6.8H2.4z" }),
      h("path", { d: "M5.2 4.6 6.6 2.6h2.8l1.4 2" }),
      h("path", { d: "M5.6 8h4.8" }));
    }

    function apply(ctx) {
      var store = createStore();
      var disposers = [];
      try {
        var slots = ctx.slots;
        disposers.push(slots.inject("sidebar.panellist", function () {
          return slots.register({
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () { return t.entry },
          }, PanelIcon);
        }));
        disposers.push(slots.inject("main", function () {
          return slots.register({
            name: "main",
            key: PANEL_ID,
            inject: function () { return { store: store } },
          }, PanelPage);
        }));
      } catch (error) {
        // 座位没被宿主声明时面板就该安静缺席，而不是把启动流程带崩。
        if (typeof console !== "undefined" && console.warn) console.warn("[local-opencode] panel registration failed:", error);
      }
      ctx.effect(function () {
        return function () {
          var list = disposers.splice(0);
          for (var i = 0; i < list.length; i += 1) {
            try { list[i]() } catch { /* 已释放 */ }
          }
        };
      }, "local-opencode: panel mounts");
    }

    var inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

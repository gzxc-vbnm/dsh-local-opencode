/**
 * 浏览器半边：侧栏入口 + 主区页面。
 *
 * 面板是三件事的可见面：
 *  1. 逐模型的「显示 / 不显示」—— 决定它进不进 dsh 的模型选择器；
 *  2. 「无工具文本通道 / 带工具 agent 通道」的切换，以及 agent 通道必需的三项；
 *  3. 运行环境：本机有没有 opencode、后台服务起没起来；没装时给一个一键安装入口，
 *     装过就把整块折起来 —— 那条命令是给新用户补缺的，不是升级按钮。
 *
 * 加载约定（抄自本机已装的同族面板）：包成
 * window.__ModuleLoader__.load({ id, factory })，工厂返回 exports.apply / exports.inject；
 * 座位用 ctx.slots.inject 注入，只有宿主声明了该座位才会真正挂上。
 *
 * 所有 fetch 都是【文档相对】路径（api/... 无前导斜杠）：GUI 用 <base href="./">，
 * 根绝对路径会逃出子路径部署，请求根本到不了插件路由（issue #1707）。
 *
 * 样式只用 dsh 的设计 token，并且都写成 var(--token, 回退值)：token 在运行时由
 * ui-theme 注入，静态 CSS 里查不到，缺了就得有中性灰兜底，不能硬编码亮色。
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

    /** 宿主路由（index.js 的 api()），一律文档相对。 */
    var API = {
      status: "api/local-opencode/status",
      refresh: "api/local-opencode/refresh",
      visibility: "api/local-opencode/visibility",
      channel: "api/local-opencode/channel",
      agentSettings: "api/local-opencode/agent-settings",
      agents: "api/local-opencode/agents",
      install: "api/local-opencode/install",
      service: "api/local-opencode/service",
    };

    var ZH = {
      entry: "Local OpenCode",
      title: "Local OpenCode",
      subtitle: "本机 opencode 的零成本模型",
      refresh: "刷新目录",
      refreshing: "刷新中…",
      serviceTitle: "后台服务",
      serviceUnknown: "还没查过",
      serviceStarting: "正在后台启动…",
      serviceRunning: "已就绪",
      serviceFailed: "启动失败",
      serviceUnavailable: "尚未安装",
      serviceStart: "重新启动",
      serviceRestarting: "启动中…",
      installTitle: "还没有 opencode",
      installDesc: "这台机器上没有找到 opencode。下面这条命令会装 2.x 那条线；1.x 走的是另一套协议，装上本插件也连不上。",
      installButton: "一键下载并安装",
      installRunning: "正在安装…",
      installDone: "安装完成，正在探测…",
      installFailed: "安装失败",
      installRetry: "重试安装",
      installNote: "已经装过 opencode 的机器不需要点它；装好后面板会自动收起这一块。",
      installedLine: "已安装",
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
      statShown: "进选择器",
      statChannel: "通道",
      statService: "服务",
      statFree: "免费",
    };

    var EN = {
      entry: "Local OpenCode",
      title: "Local OpenCode",
      subtitle: "Free models from the local opencode",
      refresh: "Refresh catalog",
      refreshing: "Refreshing…",
      serviceTitle: "Background service",
      serviceUnknown: "Not checked yet",
      serviceStarting: "Starting in background…",
      serviceRunning: "Ready",
      serviceFailed: "Failed to start",
      serviceUnavailable: "Not installed",
      serviceStart: "Restart",
      serviceRestarting: "Starting…",
      installTitle: "opencode is missing",
      installDesc: "No opencode binary was found on this machine. The command below installs the 2.x line; 1.x speaks a different protocol and will not work with this plugin.",
      installButton: "Download and install",
      installRunning: "Installing…",
      installDone: "Installed, probing…",
      installFailed: "Install failed",
      installRetry: "Retry install",
      installNote: "Machines that already have opencode never need this; the block folds away once it is found.",
      installedLine: "Installed",
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
      statShown: "in picker",
      statChannel: "channel",
      statService: "service",
      statFree: "free",
    };

    var t = String(navigator.language || "").toLowerCase().indexOf("zh") === 0 ? ZH : EN;

    /** 主题变量取自 dsh 的 alias token；缺变量时退回中性灰，绝不硬编码亮色。 */
    var C = {
      text: "var(--dsw-alias-label-primary, inherit)",
      dim: "var(--dsw-alias-label-dimmed, #8b8b8b)",
      faint: "var(--dsw-alias-label-caption, var(--dsw-alias-label-dimmed, #9a9a9a))",
      border: "var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
      borderSoft: "var(--dsw-alias-border-l1, rgba(127,127,127,.16))",
      layer: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.07))",
      layer2: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.13))",
      surface: "var(--dsw-alias-surface-raised, var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05)))",
      accent: "var(--dsw-alias-brand-primary, #4f7cff)",
      accentSoft: "var(--dsw-alias-button-ghost-active-fill, rgba(79,124,255,.12))",
      danger: "var(--dsw-alias-label-error, #c0392b)",
      dangerSoft: "var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,.10))",
      ok: "var(--dsw-alias-state-success-primary, #2e8b57)",
      warn: "var(--dsw-alias-state-warn-primary, #b8860b)",
    };

    var MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    var RADIUS = 10;

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
          return request(API.status)
            .then(function (status) { set({ status: status, error: undefined }) })
            .catch(function (error) { set({ error: String(error.message || error) }) });
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
        /** 安装是长任务：宿主没有推送，只能按拍轮询，直到 install.state 不再是 running。 */
        watchInstall: function (beats) {
          var self = this;
          var left = typeof beats === "number" ? beats : 80;
          function step() {
            var status = self.get().status;
            var install = status && status.runtime && status.runtime.install;
            if (install === undefined || install.state !== "running" || left <= 0) return;
            left -= 1;
            setTimeout(function () { self.load().then(step) }, 1500);
          }
          step();
        },
      };
    }

    // ---- 展示原语 ------------------------------------------------------------

    function toneColor(tone) {
      if (tone === "danger") return C.danger;
      if (tone === "ok") return C.ok;
      if (tone === "warn") return C.warn;
      if (tone === "accent") return C.accent;
      return C.dim;
    }

    function badge(text, tone) {
      return h("span", {
        key: "b-" + text,
        style: {
          fontSize: 10.5, lineHeight: "17px", padding: "0 7px", borderRadius: 999,
          border: "1px solid " + (tone === undefined ? C.borderSoft : "transparent"),
          background: tone === undefined ? "transparent" : C.layer2,
          color: toneColor(tone), whiteSpace: "nowrap", letterSpacing: ".01em",
        },
      }, text);
    }

    function dot(tone) {
      return h("span", {
        key: "dot",
        style: {
          width: 7, height: 7, borderRadius: 999, flex: "0 0 auto",
          background: toneColor(tone), boxShadow: "0 0 0 3px " + C.layer,
        },
      });
    }

    function button(label, onClick, options) {
      var opt = options || {};
      var filled = opt.active === true;
      return h("button", {
        type: "button",
        onClick: opt.disabled === true ? undefined : onClick,
        disabled: opt.disabled === true,
        style: {
          appearance: "none", font: "inherit", fontSize: 12, lineHeight: "20px", fontWeight: filled ? 600 : 400,
          padding: "4px 12px", borderRadius: 8, cursor: opt.disabled === true ? "default" : "pointer",
          transition: "background .12s ease, border-color .12s ease",
          border: "1px solid " + (filled ? "transparent" : C.border),
          background: filled ? C.accent : (opt.danger === true ? C.dangerSoft : C.layer),
          color: filled ? "#fff" : (opt.danger === true ? C.danger : (opt.disabled === true ? C.dim : C.text)),
          opacity: opt.disabled === true ? 0.55 : 1,
          whiteSpace: "nowrap",
        },
      }, label);
    }

    /** 分段控件：一个盒子里的互斥选项，比两个独立按钮更容易读成「二选一」。 */
    function segmented(items) {
      return h("div", {
        style: {
          display: "flex", gap: 3, padding: 3, borderRadius: RADIUS,
          border: "1px solid " + C.borderSoft, background: C.layer, marginBottom: 9,
        },
      }, items.map(function (item) {
        var on = item.active === true;
        return h("button", {
          key: item.key,
          type: "button",
          onClick: item.disabled === true ? undefined : item.onClick,
          style: {
            appearance: "none", font: "inherit", flex: 1, minWidth: 0, cursor: item.disabled === true ? "default" : "pointer",
            fontSize: 12, lineHeight: "20px", fontWeight: on ? 600 : 400, padding: "5px 10px", borderRadius: 7,
            border: "1px solid " + (on ? C.border : "transparent"),
            background: on ? C.surface : "transparent",
            color: on ? C.text : C.dim, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis",
          },
        }, item.label);
      }));
    }

    function card(children, extra) {
      var style = {
        padding: "12px 14px", borderRadius: RADIUS, border: "1px solid " + C.borderSoft,
        background: C.surface, marginBottom: 14,
      };
      return h("div", { style: Object.assign(style, extra || {}) }, children);
    }

    function section(title, description, children) {
      return h("section", { style: { marginBottom: 20 } },
        h("div", {
          style: {
            fontSize: 11, fontWeight: 600, color: C.faint, letterSpacing: ".07em",
            textTransform: "uppercase", marginBottom: 4,
          },
        }, title),
        description === undefined ? null : h("div", { style: { fontSize: 11.5, color: C.dim, lineHeight: "17px", marginBottom: 9 } }, description),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, children));
    }

    function stat(label, value, tone) {
      return h("div", { key: label, style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
        h("span", { style: { fontSize: 10.5, color: C.faint, letterSpacing: ".04em" } }, label),
        h("span", {
          style: {
            fontSize: 12.5, color: tone === undefined ? C.text : toneColor(tone),
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          },
        }, value));
    }

    function modelRow(row_, store, busy) {
      var shown = row_.hidden === false && (row_.group === "free" || row_.group === "paid");
      var meta = [];
      if (row_.contextWindow) meta.push(Math.round(row_.contextWindow / 1000) + "k ctx");
      if (row_.modalities && row_.modalities.length > 0) meta.push(row_.modalities.join("/"));

      var left = h("div", { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 12.5, color: C.text, fontWeight: shown ? 600 : 400 } }, row_.name),
          badge(row_.provider),
          row_.free === true ? badge("free", "ok") : badge("paid", "warn")),
        h("div", {
          style: {
            fontSize: 10.5, color: C.faint, fontFamily: MONO, minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          },
        }, row_.id + (meta.length === 0 ? "" : "  ·  " + meta.join("  ·  "))));

      var action = row_.toggleable === true
        ? button(shown ? t.hide : t.show, function () {
          store.act(API.visibility, { id: row_.id, hidden: shown });
        }, { disabled: busy, active: shown === false })
        : h("span", { style: { fontSize: 11, color: C.faint } }, "—");

      return h("div", {
        key: row_.id,
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          padding: "8px 11px", borderRadius: 9,
          border: "1px solid " + (shown ? C.borderSoft : "transparent"),
          background: shown ? C.layer : "transparent",
          opacity: row_.group === "unavailable" ? 0.6 : 1,
        },
      }, left, action);
    }

    function ModelGroup(props) {
      var items = props.items;
      if (items.length === 0) return null;
      return h("div", { key: props.name, style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 6 } },
        h("div", {
          style: {
            display: "flex", alignItems: "center", gap: 6, marginTop: 4,
            fontSize: 10.5, letterSpacing: ".05em", textTransform: "uppercase", color: C.faint,
          },
        },
        h("span", null, props.title),
        h("span", { style: { opacity: 0.7 } }, String(items.length))),
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
        var on = mode === current;
        return h("div", {
          key: mode,
          style: {
            display: "flex", alignItems: "flex-start", gap: 9, padding: "8px 11px", borderRadius: 9,
            border: "1px solid " + (on ? C.accent : C.borderSoft),
            background: on ? C.accentSoft : "transparent",
            cursor: busy || on ? "default" : "pointer",
          },
          onClick: busy || on ? undefined : function () { store.act(API.agentSettings, { permissionMode: mode }) },
        },
        h("span", {
          style: {
            width: 13, height: 13, marginTop: 3, borderRadius: 999, flex: "0 0 auto",
            border: "2px solid " + (on ? C.accent : C.border),
            background: on ? C.accent : "transparent", boxSizing: "border-box",
          },
        }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
          h("span", { style: { fontSize: 12.5, color: C.text, fontWeight: on ? 600 : 400 } }, meta.label),
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
          font: "inherit", fontSize: 12, padding: "6px 9px", borderRadius: 8, minWidth: 0, flex: 1,
          border: "1px solid " + C.border, background: "transparent", color: C.text,
        },
      });
      var dirRow = h("div", { key: "dir", style: { display: "flex", gap: 8, alignItems: "center" } }, dirInput,
        button(t.save, function () { store.act(API.agentSettings, { workingDirectory: dirInput.value }) }, { disabled: busy }));

      var agentSelect = h("select", {
        defaultValue: status.agentName || "",
        onChange: function (event) { store.act(API.agentSettings, { agentName: event.currentTarget.value }) },
        style: {
          font: "inherit", fontSize: 12, padding: "6px 9px", borderRadius: 8, width: "100%",
          border: "1px solid " + C.border, background: "transparent", color: C.text,
        },
      },
      h("option", { value: "" }, t.agentDefault),
      agents.map(function (agent) { return h("option", { key: agent.id, value: agent.id }, agent.id) }));

      return h("div", null,
        h("div", {
          style: {
            display: "flex", gap: 8, alignItems: "flex-start", padding: "9px 12px", marginBottom: 16,
            borderRadius: 9, border: "1px solid " + C.border, background: C.dangerSoft,
          },
        }, dot("danger"), h("span", { style: { fontSize: 11.5, color: C.danger, lineHeight: "18px" } }, t.agentWarning)),
        section(t.permissionTitle, undefined, modeRows),
        section(t.workingDirTitle, t.workingDirDesc, dirRow),
        section(t.agentTitle, t.agentDesc,
          agents.length === 0 ? h("div", { style: { fontSize: 11.5, color: C.dim } }, t.noAgents) : agentSelect));
    }

    /**
     * 运行环境卡。
     *
     * 装过 opencode 就把整块折起来（安装是补缺，不是升级）；没装时给出命令和按钮，
     * 并在安装进行中把宿主抓到的输出原样贴出来——那几十秒里用户唯一想知道的就是
     * "它还在动吗"。
     */
    function RuntimeSection(props) {
      var runtime = props.runtime || {};
      var service = runtime.service || {};
      var install = runtime.install || {};
      var store = props.store;
      var busy = props.busy;
      var serviceText = t.serviceUnknown;
      if (service.state === "running") serviceText = t.serviceRunning;
      else if (service.state === "starting") serviceText = t.serviceStarting;
      else if (service.state === "failed") serviceText = t.serviceFailed;
      else if (service.state === "unavailable") serviceText = t.serviceUnavailable;
      var serviceTone = service.state === "running" ? "ok" : service.state === "failed" ? "danger" : service.state === "starting" ? "warn" : undefined;

      if (runtime.installed === true) return null;

      var running = install.state === "running";
      var lines = [];
      if (install.output) lines = String(install.output).split(String.fromCharCode(10)).slice(-6);

      return card([
        h("div", { key: "t", style: { display: "flex", alignItems: "center", gap: 7, marginBottom: 5 } },
          dot("warn"),
          h("span", { style: { fontSize: 13, fontWeight: 600, color: C.text } }, t.installTitle)),
        h("div", { key: "d", style: { fontSize: 11.5, color: C.dim, lineHeight: "18px", marginBottom: 9 } }, t.installDesc),
        h("div", {
          key: "cmd",
          style: {
            fontFamily: MONO, fontSize: 11, color: C.text, padding: "7px 9px", borderRadius: 7,
            border: "1px solid " + C.borderSoft, background: C.layer, marginBottom: 9,
            overflowX: "auto", whiteSpace: "nowrap",
          },
        }, install.command || runtime.installCommand || "npm install -g @opencode/cli@latest"),
        h("div", { key: "act", style: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" } },
          button(running ? t.installRunning : (install.state === "failed" ? t.installRetry : t.installButton), function () {
            store.act(API.install, {}).then(function () { store.watchInstall(120) });
          }, { disabled: busy || running, active: running === false && install.state !== "failed", danger: install.state === "failed" }),
          install.state === "done" ? badge(t.installDone, "ok") : null,
          install.state === "failed" ? badge(t.installFailed, "danger") : null,
          service.state === "running" ? badge(serviceText, serviceTone) : null),
        lines.length === 0 ? null : h("pre", {
          key: "log",
          style: {
            margin: "9px 0 0", padding: "7px 9px", borderRadius: 7, maxHeight: 120, overflow: "auto",
            fontFamily: MONO, fontSize: 10.5, lineHeight: "15px", color: C.dim,
            background: C.layer, border: "1px solid " + C.borderSoft, whiteSpace: "pre-wrap",
          },
        }, lines.join(String.fromCharCode(10))),
        h("div", { key: "n", style: { fontSize: 10.5, color: C.faint, marginTop: 8, lineHeight: "16px" } }, t.installNote),
      ]);
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
      var connectionTone = connection.status === "connected" ? "ok" : connection.status === "idle" ? undefined : "danger";
      var shownCount = groups.free.length + groups.paid.length;
      var runtime = status.runtime || {};
      var service = runtime.service || {};
      var serviceTone = service.state === "running" ? "ok" : service.state === "failed" ? "danger" : undefined;
      var serviceLabel = service.state === "running" ? t.serviceRunning : service.state === "starting" ? t.serviceStarting : service.state === "failed" ? t.serviceFailed : service.state === "unavailable" ? t.serviceUnavailable : t.serviceUnknown;

      var header = h("div", {
        style: {
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
          marginBottom: 14, paddingBottom: 13, borderBottom: "1px solid " + C.borderSoft,
        },
      },
      h("div", { style: { minWidth: 0 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 16, fontWeight: 650, color: C.text, letterSpacing: "-.01em" } }, t.title),
          status.plugin && status.plugin.version ? badge("v" + status.plugin.version) : null),
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 5 } },
          dot(connectionTone),
          h("span", { style: { fontSize: 11.5, color: C.dim } }, t.subtitle + "  ·  " + connectionText))),
      button(busy ? t.refreshing : t.refresh, function () {
        store.act(API.refresh, {});
      }, { disabled: busy }));

      var stats = h("div", {
        style: {
          display: "flex", gap: 16, flexWrap: "wrap", padding: "10px 14px", marginBottom: 16,
          borderRadius: RADIUS, border: "1px solid " + C.borderSoft, background: C.layer,
        },
      },
      stat(t.statShown, shownCount + " / " + rows.length),
      stat(t.statFree, String(groups.free.length), groups.free.length > 0 ? "ok" : undefined),
      stat(t.statChannel, status.channel === "agent" ? t.channelAgent : t.channelText),
      stat(t.statService, serviceLabel, serviceTone));

      var errorBar = snapshot.error === undefined ? null : h("div", {
        style: {
          marginBottom: 14, padding: "8px 11px", borderRadius: 9, fontSize: 12,
          border: "1px solid " + C.border, background: C.dangerSoft, color: C.danger,
        },
      }, t.failed + snapshot.error);

      var channelSegments = segmented([
        { key: "text", label: t.channelText, active: status.channel === "text", disabled: busy, onClick: function () { store.act(API.channel, { channel: "text" }) } },
        { key: "agent", label: t.channelAgent, active: status.channel === "agent", disabled: busy, onClick: function () { store.act(API.channel, { channel: "agent" }) } },
      ]);

      var channelBody = h("div", null, channelSegments,
        h("div", { style: { fontSize: 11, color: C.dim, lineHeight: "17px" } },
          status.channel === "agent" ? t.channelAgentDesc : t.channelTextDesc));

      return h("div", {
        style: {
          padding: "20px 26px 40px", height: "100%", overflowY: "auto", boxSizing: "border-box",
          color: C.text, fontFamily: "inherit", maxWidth: 760,
        },
      },
      header,
      stats,
      errorBar,
      RuntimeSection({ runtime: runtime, store: store, busy: busy }),
      section(t.channelTitle, undefined, channelBody),
      status.channel === "agent" ? AgentSection({ status: status, store: store, busy: busy }) : null,
      section(t.modelsTitle, t.modelsDesc,
        rows.length === 0
          ? h("div", { style: { fontSize: 12, color: C.dim } }, t.empty)
          : [
            ModelGroup({ key: "free", name: "free", title: t.groupFree, items: groups.free, store: store, busy: busy }),
            ModelGroup({ key: "paid", name: "paid", title: t.groupPaid, items: groups.paid, store: store, busy: busy }),
            ModelGroup({ key: "hidden", name: "hidden", title: t.groupHidden, items: groups.hidden, store: store, busy: busy }),
            ModelGroup({ key: "unlisted", name: "unlisted", title: t.groupUnlisted, items: groups.unlisted, store: store, busy: busy }),
            ModelGroup({ key: "unavailable", name: "unavailable", title: t.groupUnavailable, items: groups.unavailable, store: store, busy: busy }),
          ].filter(function (node) { return node !== null })),
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 18, paddingTop: 12, borderTop: "1px solid " + C.borderSoft } },
        h("span", { style: { fontSize: 10.5, color: C.faint, fontFamily: MONO } }, "dsh-local-opencode " + ((status.plugin && status.plugin.version) || "")),
        runtime.installed === true && runtime.binary ? h("span", { style: { fontSize: 10.5, color: C.faint, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.installedLine + ": " + runtime.binary) : null));
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

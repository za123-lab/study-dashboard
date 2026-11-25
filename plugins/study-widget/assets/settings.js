/* 学业工作台 · 设置页逻辑（自包含，无框架、无构建）
 *
 * 宿主接口（Host 侧实现，前缀 /dsh-study-widget，全部同源请求）：
 *   GET  /api/settings         { ok, settings: SettingsView, status: SourceStatus,
 *                                desktop: {running, pinned, bounds}, plugin: {entryId, enabled, phase} }
 *   POST /api/settings         { settings: Partial<SettingsInput> }  → 同上
 *   POST /api/settings/test    { settings: Partial<SettingsInput> }
 *                              → { ok, auth: {ok, email, userId}, data: {ok, rev, updatedAt, todoOpen, courses} }
 *   POST /api/plugin           { action: "enable" | "disable" | "restart", packageName? } → { ok, applied, message }
 *   POST /api/sources/export   → { ok, filename, text }
 *   POST /api/sources/import   { text } → { ok, summary }
 *
 * 约定：
 *   - 页面可能在 DSH 内被 iframe 嵌入，也可能直接路由打开；**没有** window.studyWidget
 *     （那是 Electron preload 才会注入的东西），所以一律走 fetch。
 *   - 密码永远不回传：hasPassword=true 时输入框只显示占位「已保存（留空则不改）」。
 *   - 保存时只 POST 有变化的字段；改到需要重启的属性时额外提示「下次打开小窗生效」。
 */
(function () {
  "use strict";

  var BASE = "/dsh-study-widget";

  // 关于分区里的链接（README 在仓库里，网页版在 GitHub Pages）
  var REPO_URL = "https://github.com/glebah23/study-dashboard";
  var README_URL = REPO_URL + "/blob/main/plugins/study-widget/README.md";
  var WEB_URL = "https://glebah23.github.io/study-dashboard/";

  // 只认这些嵌套路径（防止把后端多给的字段原样回写）
  var FIELD_PATHS = [
    "supabase.url",
    "supabase.anonKey",
    "supabase.email",
    "supabase.password",
    "desktop.autoOpen",
    "desktop.alwaysOnTop",
    "desktop.width",
    "desktop.height",
    "refresh.autoRefresh",
    "refresh.pageSeconds",
    "refresh.summaryTtlSeconds",
    "data.offline",
    "data.stateFile",
    "advanced.electronPath",
  ];
  // 改了只影响「下次打开小窗」的属性
  var RESTART_PATHS = ["advanced.electronPath", "desktop.width", "desktop.height", "desktop.autoOpen", "desktop.alwaysOnTop"];

  var SECTIONS = [
    { id: "connection", icon: "🔗", label: "连接" },
    { id: "window", icon: "🪟", label: "窗口" },
    { id: "refresh", icon: "🔄", label: "数据与刷新" },
    { id: "plugin", icon: "🧩", label: "插件" },
    { id: "advanced", icon: "⚙️", label: "高级" },
    { id: "about", icon: "ℹ️", label: "关于" },
  ];

  var SHELL = document.getElementById("shell");
  var CONTENT = document.getElementById("content");
  var SECTIONS_NAV = document.getElementById("sections");
  var STATUS_STRIP = document.getElementById("statusStrip");
  var TOASTS = document.getElementById("toasts");
  var BRAND_DOT = document.getElementById("brandDot");
  var PAGE_HINT = document.getElementById("pageHint");
  var BTN_RELOAD = document.getElementById("btnReload");

  // 服务端整包快照 + 表单草稿（草稿里的 password 永远从空开始）
  var VIEW = null;
  var DRAFT = null;
  var BUILT = null; // { sectionId: { els: {fieldName: element}, nodes: [...] } }
  var BUSY = {};
  var ACTIVE_SECTION = "connection";

  // 嵌入式打开时去掉外框样式
  try {
    if (window.top && window.top !== window.self) document.body.dataset.embed = "iframe";
  } catch (err) {
    // 跨域访问 window.top 会抛错，说明确实被别的页面嵌了
    document.body.dataset.embed = "iframe";
  }

  // ---------- 小工具 ----------

  /** 建节点；attrs 里的 text 走 textContent，其余走 setAttribute */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "text") node.textContent = String(v);
        else if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "value") node.value = String(v);
        else if (k === "checked") node.checked = !!v;
        else if (k === "disabled") node.disabled = !!v;
        else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : String(v));
      });
    }
    appendChildren(node, children);
    return node;
  }

  /** 子节点入树：字符串变文本节点，数组递归展开（saveFoot 传 [btnTest] 也能正常挂上） */
  function appendChildren(node, children) {
    if (children == null || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) {
        appendChildren(node, c);
      });
      return;
    }
    node.appendChild(typeof children === "string" || typeof children === "number" ? document.createTextNode(String(children)) : children);
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function clone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
  }

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function getPath(obj, path) {
    var parts = path.split(".");
    var cur = obj;
    for (var i = 0; i < parts.length; i += 1) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /** 往目标对象里写嵌套路径（自动补中间对象） */
  function setPath(obj, path, value) {
    var parts = path.split(".");
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i += 1) {
      if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function fmtTime(value) {
    if (value == null || value === "") return "";
    var d;
    if (typeof value === "number") d = new Date(value);
    else d = new Date(String(value));
    if (!d || isNaN(d.getTime())) return String(value);
    function p(n) {
      return n < 10 ? "0" + n : String(n);
    }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtAgo(ms) {
    if (!ms) return "";
    var diff = Date.now() - Number(ms);
    if (!Number.isFinite(diff) || diff < 0) return fmtTime(ms);
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.round(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.round(diff / 3600000) + " 小时前";
    return Math.round(diff / 86400000) + " 天前";
  }

  function errText(err) {
    if (!err) return "未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  // ---------- 提示（toast） ----------

  function toast(message, tone, ttl) {
    if (!TOASTS) return;
    var mark = tone === "error" ? "✕" : tone === "warn" ? "!" : "✓";
    var node = el("div", { class: "toast", "data-tone": tone || "ok", role: tone === "error" ? "alert" : "status" }, [
      el("span", { class: "toast-ic", text: mark }),
      el("span", { text: message }),
    ]);
    TOASTS.appendChild(node);
    // 最多同时留 4 条
    while (TOASTS.children.length > 4) TOASTS.removeChild(TOASTS.firstChild);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, ttl || (tone === "error" ? 7000 : 3200));
  }

  // ---------- HTTP ----------

  /**
   * 统一请求：永远返回 { ok, data }，不抛异常。
   * 服务端约定失败时给 { ok:false, error:{code,message} }，message 原样展示以便定位。
   */
  function request(method, path, body) {
    var opts = { method: method, cache: "no-store", headers: { Accept: "application/json" }, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(BASE + path, opts)
      .then(function (res) {
        return res
          .text()
          .then(function (text) {
            var payload = null;
            try {
              payload = text ? JSON.parse(text) : null;
            } catch (e) {
              payload = null;
            }
            if (!payload) {
              return {
                ok: false,
                data: {
                  ok: false,
                  error: { code: "BAD_RESPONSE", message: "服务端返回的不是 JSON（HTTP " + res.status + "）：" + text.slice(0, 200) },
                },
              };
            }
            return { ok: res.ok && payload.ok !== false, data: payload, status: res.status };
          })
          .catch(function (err) {
            return { ok: false, data: { ok: false, error: { code: "READ_FAILED", message: errText(err) } } };
          });
      })
      .catch(function (err) {
        return {
          ok: false,
          data: {
            ok: false,
            error: { code: "NETWORK", message: "连不上宿主：" + errText(err) },
          },
        };
      });
  }

  function errorOf(data) {
    return (data && data.error) || { code: "UNKNOWN", message: "未知错误" };
  }

  /**
   * 失败时给一个可定位的 code：服务端给了 error.code 就用它，
   * 否则按 HTTP 状态码兜底（404=路由没挂、401=鉴权没过），最后才是 UNKNOWN。
   * 这样「是路由没挂还是鉴权没过」一眼能看出来。
   */
  function failureOf(result) {
    var data = (result && result.data) || {};
    var err = errorOf(data);
    var status = result && result.status;
    if (!data.error || !err.code) {
      if (status === 404) err = { code: "NOT_MOUNTED", message: err.message || "接口没挂上（HTTP 404）" };
      else if (status === 401) err = { code: "UNAUTHORIZED", message: err.message || "没有访问桌面上小组件数据的权限（HTTP 401）" };
      else if (status && status >= 400) err = { code: "HTTP_" + status, message: err.message || "HTTP " + status };
    }
    return { code: err.code || "UNKNOWN", message: errText(err), status: status || 0 };
  }

  // ---------- 状态条 ----------

  /** 四个状态格：数据源 / 同步 / 桌面窗口 / 插件 */
  function renderStatus(data) {
    var status = (data && data.status) || {};
    var desktop = (data && data.desktop) || {};
    var plugin = (data && data.plugin) || {};
    var settings = (data && data.settings) || {};

    var online = !!status.online;
    var sourceKind = status.source || "";
    var offline = (settings.data && settings.data.offline) || false;
    var lastError = status.error;

    // 1) 数据源
    var srcLabel = "未连接";
    var srcTone = "";
    var srcSub = "";
    if (offline) {
      srcLabel = "离线";
      srcTone = "warn";
      srcSub = "只读本地快照";
    } else if (online && sourceKind === "supabase") {
      srcLabel = "Supabase 实时";
      srcTone = "ok";
      srcSub = status.email || "已登录";
    } else if (sourceKind === "file" || sourceKind === "cache") {
      srcLabel = "本地快照";
      srcTone = lastError ? "warn" : "";
      srcSub = lastError ? "上次同步失败，显示缓存" : "读的是本地文件";
    } else if (lastError) {
      srcLabel = "读取失败";
      srcTone = "error";
      srcSub = lastError.message || "";
    } else if (sourceKind) {
      srcLabel = String(sourceKind);
    }
    if (!offline && lastError && srcLabel === "Supabase 实时") {
      // 实时可用但有报错：降级提示，别骗用户
      srcLabel = "Supabase 实时";
      srcSub = "最近一次错误：" + (lastError.message || "");
      srcTone = "warn";
    }

    // 2) 同步
    var revText = status.rev ? "rev " + status.rev : "还没有数据";
    var timeText = status.updatedAt ? fmtTime(status.updatedAt) : "";
    if (status.fetchedAt) timeText = (timeText ? timeText + " · " : "") + fmtAgo(status.fetchedAt) + "读取";

    // 3) 桌面窗口
    var deskLabel = desktop.running ? "运行中" : "未打开";
    var deskTone = desktop.running ? "ok" : "";
    var deskSub = desktop.running ? (desktop.pinned ? "已置顶" : "未置顶") : "可在「窗口」分区打开";
    if (desktop.error) {
      deskTone = "error";
      deskSub = errText(desktop.error);
    }

    // 4) 插件
    var plugLabel = plugin.enabled === false ? "已禁用" : plugin.enabled ? "已启用" : "未知";
    var plugTone = plugin.enabled ? "ok" : plugin.enabled === false ? "warn" : "";
    var plugSub = plugin.phase ? String(plugin.phase) : plugin.entryId ? String(plugin.entryId) : "";

    var cells = [
      { k: "数据源", v: srcLabel, tone: srcTone, sub: srcSub },
      { k: "上次同步", v: revText, tone: status.error ? "warn" : "", sub: timeText },
      { k: "桌面窗口", v: deskLabel, tone: deskTone, sub: deskSub },
      { k: "插件", v: plugLabel, tone: plugTone, sub: plugSub },
    ];

    clear(STATUS_STRIP);
    cells.forEach(function (c) {
      STATUS_STRIP.appendChild(
        el("div", { class: "status-cell", "data-tone": c.tone || null, title: c.sub || "" }, [
          el("div", { class: "status-k" }, [document.createTextNode(c.k)]),
          el("div", { class: "status-v", text: c.v }),
          c.sub ? el("div", { class: "status-sub", text: c.sub, title: c.sub }) : null,
        ])
      );
    });

    // 顶栏小圆点与副标题
    var dotKind = "ok";
    if (lastError || deskTone === "error") dotKind = "error";
    else if (srcTone === "warn" || srcTone === "error" || plugTone === "warn") dotKind = "warn";
    BRAND_DOT.dataset.kind = dotKind;
    PAGE_HINT.textContent = srcLabel + (timeText ? " · " + timeText : "");
  }

  // ---------- 表单：字段工厂 ----------

  /** 读草稿当前值（草稿结构 = SettingsInput） */
  function val(path) {
    return getPath(DRAFT, path);
  }

  function markDirty(path) {
    if (!BUILT) return;
    Object.keys(BUILT).forEach(function (sid) {
      var b = BUILT[sid];
      if (!b) return;
      var dirty = false;
      Object.keys(b.els).forEach(function (p) {
        if (isChanged(p)) dirty = true;
      });
      var link = SECTIONS_NAV.querySelector('[data-section="' + sid + '"]');
      if (link) link.dataset.dirty = dirty ? "true" : "";
      if (b.foot && b.foot.note) b.foot.note.dataset.tone = dirty ? "warn" : "";
      if (b.foot && b.foot.note) b.foot.note.textContent = dirty ? "有未保存的修改" : "没有未保存的修改";
    });
    // 高级分区是 read-only 的，不做脏标记
    void path;
  }

  function setField(path, value) {
    setPath(DRAFT, path, value);
    markDirty(path);
  }

  function labelEl(text, tagText, tagTone) {
    return el("label", { class: "label" }, [
      document.createTextNode(text),
      tagText ? el("span", { class: "tag", "data-tone": tagTone || null, text: tagText }) : null,
    ]);
  }

  /** 文本输入 */
  function textField(path, opt) {
    opt = opt || {};
    var input = el("input", {
      class: "input",
      type: opt.type || "text",
      autocomplete: opt.autocomplete || "off",
      spellcheck: "false",
      placeholder: opt.placeholder || "",
    });
    input.value = val(path) == null ? "" : String(val(path));
    if (opt.inputMode) input.setAttribute("inputmode", opt.inputMode);
    var hint = el("p", { class: "hint", text: opt.hint || "" });
    input.addEventListener("input", function () {
      setField(path, input.value);
      input.dataset.invalid = "";
      if (hint.isConnected) hint.dataset.tone = "";
    });
    if (opt.onEnter) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          opt.onEnter();
        }
      });
    }
    return {
      input: input,
      node: el("div", { class: "field" }, [labelEl(opt.label || path, opt.tag, opt.tagTone), input, hint]),
      hint: hint,
    };
  }

  /** 密码：留空 = 不修改；hasPassword 时显示占位「已保存（留空则不改）」 */
  function passwordField(path, opt) {
    opt = opt || {};
    var hasPassword = !!(VIEW && VIEW.settings && VIEW.settings.supabase && VIEW.settings.supabase.hasPassword);
    var input = el("input", {
      class: "input",
      type: "password",
      autocomplete: "new-password",
      spellcheck: "false",
      placeholder: hasPassword ? "已保存（留空则不改）" : opt.placeholder || "",
    });
    input.value = "";
    var hint = el("p", {
      class: "hint",
      text: hasPassword
        ? "密码只存服务端，永不回传；留空表示保持现有密码，填写则覆盖。"
        : "首次使用请填写 Supabase 密码；密码只存服务端，不会回传到页面。",
    });

    var toggle = el("button", { type: "button", class: "btn btn-ghost", text: "显示" });
    toggle.addEventListener("click", function () {
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggle.textContent = showing ? "显示" : "隐藏";
    });

    input.addEventListener("input", function () {
      setField(path, input.value);
      input.dataset.invalid = "";
      hint.dataset.tone = "";
    });

    return {
      input: input,
      hint: hint,
      node: el("div", { class: "field" }, [
        labelEl(opt.label || "密码", hasPassword ? "已保存" : "未设置", hasPassword ? "ok" : "warn"),
        el("div", { class: "input-group" }, [input, toggle]),
        hint,
      ]),
    };
  }

  /** 数字输入：为空就回退到 fallback，非法值标红并交给校验 */
  function numberField(path, opt) {
    opt = opt || {};
    var input = el("input", { class: "input", type: "number", min: opt.min, max: opt.max, step: opt.step || 1 });
    var lastGood = val(path);
    input.value = lastGood == null ? "" : String(lastGood);
    var hint = el("p", { class: "hint", text: opt.hint || "" });
    input.addEventListener("input", function () {
      var raw = input.value.trim();
      if (raw === "") {
        // 输入框清空时不立刻回填空值，等失焦再回退到上次合法值（否则光标会被打断）
        setField(path, "");
        input.dataset.invalid = "";
        hint.dataset.tone = "";
        return;
      }
      var n = Number(raw);
      if (Number.isFinite(n)) {
        lastGood = n;
        setField(path, n);
      }
      input.dataset.invalid = "";
      hint.dataset.tone = "";
    });
    input.addEventListener("blur", function () {
      var raw = input.value.trim();
      var n = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(n)) {
        n = opt.fallback != null ? opt.fallback : lastGood;
        if (n == null || !Number.isFinite(Number(n))) n = opt.min;
        input.value = String(n);
        setField(path, Number(n));
      }
    });
    return {
      input: input,
      hint: hint,
      node: el("div", { class: "field" }, [labelEl(opt.label || path), input, opt.hint ? hint : null]),
    };
  }

  /** 开关：原生 checkbox + 胶囊壳 */
  function toggleField(path, opt) {
    opt = opt || {};
    var input = el("input", { type: "checkbox", role: "switch" });
    input.checked = !!val(path);
    input.addEventListener("change", function () {
      setField(path, !!input.checked);
    });
    return {
      input: input,
      node: el("div", { class: "switch-field" }, [
        el("div", { class: "switch-text" }, [
          el("div", { class: "switch-title", text: opt.label || path }),
          opt.desc ? el("p", { class: "switch-desc", text: opt.desc }) : null,
        ]),
        el("label", { class: "switch" }, [input, el("span", { class: "knob" })]),
      ]),
    };
  }

  /** 只读信息行 */
  function readonlyRow(key, value, title) {
    return el("div", { class: "readonly-row" }, [
      el("span", { class: "readonly-k", text: key }),
      el("span", { class: "readonly-v", text: value == null || value === "" ? "—" : String(value), title: title || null }),
    ]);
  }

  function card(title, desc, bodyNodes, footNodes) {
    return el("section", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { class: "card-title", text: title }),
        desc ? el("p", { class: "card-desc", text: desc }) : null,
      ]),
      el("div", { class: "card-body" }, bodyNodes),
      footNodes && footNodes.length ? el("div", { class: "card-foot" }, footNodes) : null,
    ]);
  }

  /** 卡片底栏按钮组：保存 + 说明 */
  function saveFoot(sectionId, extraButtons) {
    var note = el("span", { class: "foot-note", text: "没有未保存的修改" });
    var btn = el("button", { type: "button", class: "btn btn-primary", text: "保存" });
    btn.addEventListener("click", function () {
      save(sectionId);
    });
    return {
      node: el("div", { class: "card-foot" }, [extraButtons || [], el("span", { class: "foot-spacer" }), note, btn]),
      note: note,
      button: btn,
    };
  }

  // ---------- 各分区的字段注册（用于取值与脏检查） ----------

  /** 记录「路径 → 控件」，供 markDirty / 回填使用 */
  function registerField(sectionId, path, ctl) {
    if (!BUILT[sectionId]) BUILT[sectionId] = { els: {}, foot: null };
    BUILT[sectionId].els[path] = ctl.input;
    return ctl;
  }

  // ---------- 分区：连接 ----------

  function buildConnection() {
    BUILT.connection = BUILT.connection || { els: {}, foot: null };
    var out = [];

    var url = registerField("connection", "supabase.url", textField("supabase.url", {
      label: "Supabase URL",
      placeholder: "https://xxxx.supabase.co",
      hint: "Supabase 控制台 → Project Settings → API → Project URL。",
      tag: "项目地址",
    }));

    var anon = registerField("connection", "supabase.anonKey", textField("supabase.anonKey", {
      label: "anon key（公开密钥）",
      placeholder: "eyJhbGciOi...",
      hint: "同一页面里的 anon public key。只做只读查询，不要填 service_role。",
      tag: "只读",
    }));

    var email = registerField("connection", "supabase.email", textField("supabase.email", {
      label: "登录邮箱",
      type: "email",
      autocomplete: "username",
      placeholder: "you@example.com",
      hint: "与网页端登录同一个账号，用于只读拉取学习数据。",
    }));

    var pwd = registerField("connection", "supabase.password", passwordField("supabase.password", { label: "密码" }));

    var testBox = el("div", { class: "test-result" });

    var btnTest = el("button", { type: "button", class: "btn btn-ghost", text: "测试连接" });
    btnTest.addEventListener("click", function () {
      testConnection(btnTest, testBox);
    });

    var foot = saveFoot("connection", [btnTest]);
    BUILT.connection.foot = foot;

    out.push(
      card(
        "Supabase 连接",
        "保存后立即生效，取代手写的 ~/.dsh/study-widget/login.json；这里只读数据，不会往云端写。",
        [
          url.node,
          anon.node,
          el("div", { class: "field-row" }, [email.node, pwd.node]),
          testBox,
        ],
        [foot.node]
      )
    );
    return out;
  }

  // ---------- 分区：窗口 ----------

  function buildWindow() {
    BUILT.window = BUILT.window || { els: {}, foot: null };
    var s = (VIEW && VIEW.settings && VIEW.settings.desktop) || {};
    var floor = { width: 300, height: 320 };

    var autoOpen = registerField("window", "desktop.autoOpen", toggleField("desktop.autoOpen", {
      label: "随 DSH 启动自动打开小窗",
      desc: "下次打开 DSH 时生效（小窗由 Electron 承载）。",
    }));
    var onTop = registerField("window", "desktop.alwaysOnTop", toggleField("desktop.alwaysOnTop", {
      label: "窗口置顶",
      desc: "小窗始终显示在其他窗口之上。",
    }));
    var width = registerField("window", "desktop.width", numberField("desktop.width", {
      label: "窗口宽度（像素）",
      min: floor.width,
      max: 1600,
      fallback: s.width || 380,
      hint: "最小 " + floor.width + "，过窄会挤坏排版。",
    }));
    var height = registerField("window", "desktop.height", numberField("desktop.height", {
      label: "窗口高度（像素）",
      min: floor.height,
      max: 1600,
      fallback: s.height || 640,
      hint: "最小 " + floor.height + "。",
    }));

    var info = el("div", { class: "readonly-row-set" }, []);
    var desk = (VIEW && VIEW.desktop) || {};
    info.appendChild(readonlyRow("当前状态", desk.running ? "运行中" : "未打开", desk.running ? "桌面小窗已启动" : ""));
    if (desk.bounds) {
      info.appendChild(
        readonlyRow(
          "当前位置",
          (desk.bounds.x != null ? desk.bounds.x : "?") + ", " + (desk.bounds.y != null ? desk.bounds.y : "?") +
            " · " + (desk.bounds.width || "?") + "×" + (desk.bounds.height || "?")
        )
      );
    }
    info.appendChild(readonlyRow("置顶", desk.pinned ? "是" : "否"));

    var foot = saveFoot("window");
    BUILT.window.foot = foot;

    return [
      card(
        "桌面小窗",
        "这些属性影响 Electron 小窗；改动保存后对「下次打开小窗」生效，已打开的窗口不会即时变形。",
        [autoOpen.node, onTop.node, el("div", { class: "field-row" }, [width.node, height.node]), info],
        [foot.node]
      ),
    ];
  }

  // ---------- 分区：数据与刷新 ----------

  function buildRefresh() {
    BUILT.refresh = BUILT.refresh || { els: {}, foot: null };
    var s = (VIEW && VIEW.settings && VIEW.settings.refresh) || {};
    var d = (VIEW && VIEW.settings && VIEW.settings.data) || {};

    var auto = registerField("refresh", "refresh.autoRefresh", toggleField("refresh.autoRefresh", {
      label: "自动刷新",
      desc: "面板可见时按页面刷新间隔自动拉一次数据。",
    }));
    var page = registerField("refresh", "refresh.pageSeconds", numberField("refresh.pageSeconds", {
      label: "页面刷新间隔（秒）",
      min: 10,
      max: 86400,
      fallback: s.pageSeconds || 300,
      hint: "面板/小窗多久自动刷新一次，最小 10 秒。",
    }));
    var ttl = registerField("refresh", "refresh.summaryTtlSeconds", numberField("refresh.summaryTtlSeconds", {
      label: "数据缓存时长（秒）",
      min: 0,
      max: 3600,
      fallback: s.summaryTtlSeconds == null ? 30 : s.summaryTtlSeconds,
      hint: "同一份快照在服务端缓存多久；0 表示每次都读云端。",
    }));
    var offline = registerField("refresh", "data.offline", toggleField("data.offline", {
      label: "离线模式",
      desc: "只读本地快照（latest.json / stateFile），不访问 Supabase。",
    }));
    var stateFile = registerField("refresh", "data.stateFile", textField("data.stateFile", {
      label: "本地数据文件（stateFile）",
      placeholder: "留空使用默认 ~/.dsh/study-widget/latest.json",
      hint: "可填网页版导出的备份文件路径；留空表示用默认快照。",
    }));

    var foot = saveFoot("refresh");
    BUILT.refresh.foot = foot;

    var home = (VIEW && VIEW.settings && VIEW.settings.advanced && VIEW.settings.advanced.homeDir) || "";

    return [
      card(
        "刷新策略",
        "控制数据多久读一次、缓存多久；离线模式下不联网。",
        [auto.node, el("div", { class: "field-row" }, [page.node, ttl.node]), offline.node, stateFile.node],
        [foot.node]
      ),
      card("数据目录", "只读展示，供排查用。", [readonlyRow("目录", home || "—", home)]),
    ];
  }

  // ---------- 分区：插件 ----------

  function buildPlugin() {
    var plugin = (VIEW && VIEW.plugin) || {};
    var appliedBox = el("div", { class: "test-result" });

    var stateText = el("div", { class: "plugin-state" }, [
      el("span", {
        class: "pill",
        "data-tone": plugin.enabled ? "ok" : plugin.enabled === false ? "warn" : null,
        text: plugin.enabled === false ? "已禁用" : plugin.enabled ? "已启用" : "未知",
      }),
      el("span", { text: "入口：" + (plugin.entryId || "—") }),
      plugin.phase ? el("span", { class: "pill", text: "阶段 " + plugin.phase }) : null,
    ]);

    var btnEnable = el("button", { type: "button", class: "btn btn-ghost", text: "启用" });
    var btnDisable = el("button", { type: "button", class: "btn btn-ghost", text: "禁用" });
    var btnRestart = el("button", { type: "button", class: "btn btn-ghost", text: "重载" });
    btnEnable.disabled = plugin.enabled === true;
    btnDisable.disabled = plugin.enabled === false;

    btnEnable.addEventListener("click", function () {
      pluginAction("enable", btnEnable, appliedBox);
    });
    btnDisable.addEventListener("click", function () {
      pluginAction("disable", btnDisable, appliedBox);
    });
    btnRestart.addEventListener("click", function () {
      // 重载 = 先禁用再启用（宿主只有这两个动作）
      restartPlugin(btnRestart, appliedBox);
    });

    var footNote = el("span", { class: "foot-note", text: "开关走 Host 的 /api/plugin，不改 profile 配置。" });

    return [
      card(
        "插件开关",
        "禁用后左栏入口、数据接口与桌面小窗都会停止，重新启用即可恢复。",
        [stateText, el("div", { class: "action-row" }, [btnEnable, btnDisable, btnRestart]), appliedBox],
        [footNote]
      ),
    ];
  }

  /**
   * 取插件包名，给 POST /api/plugin 用。
   * 后端口径（lead 定）：GET /api/plugin 的 packageName 是可选的（有就出现、没有就没这个键）；
   * POST 时优先用它走 setBundleEnabled，没有就用 entryId 走 setPluginEnabled。
   * 所以这里只直读 plugin.packageName，不从 bundleInfo 里猜字段名。
   */
  function bundlePackageName() {
    var p = VIEW && VIEW.plugin;
    if (!p) return "";
    if (typeof p.packageName === "string" && p.packageName.trim()) return p.packageName.trim();
    return "";
  }

  function showApplied(box, result, label) {
    clear(box);
    if (!result) {
      box.dataset.tone = "";
      return;
    }
    var d = result.data || {};
    var ok = !!result.ok;
    box.dataset.tone = ok ? "ok" : "error";
    box.appendChild(
      el("div", { class: "test-title", "data-tone": ok ? "ok" : "error", text: label + (ok ? "成功" : "失败") })
    );
    if (d.applied !== undefined) {
      box.appendChild(
        el("div", { class: "test-line" }, [
          el("span", { class: "k", text: "applied" }),
          el("span", { class: "v", "data-tone": d.applied ? "ok" : "error", text: String(d.applied) }),
        ])
      );
    }
    if (d.message) {
      box.appendChild(
        el("div", { class: "test-line" }, [
          el("span", { class: "k", text: "message" }),
          el("span", { class: "v", text: errText(d.message) }),
        ])
      );
    }
    if (!ok) {
      var err = errorOf(d);
      box.appendChild(
        el("div", { class: "test-line" }, [
          el("span", { class: "k", text: "error" }),
          el("span", { class: "v", "data-tone": "error", text: (err.code ? err.code + "：" : "") + errText(err) }),
        ])
      );
    }
  }

  function setBusy(btn, key, on) {
    BUSY[key] = on;
    if (btn) {
      btn.dataset.busy = on ? "true" : "";
      btn.disabled = on;
    }
  }

  function pluginAction(action, btn, box) {
    setBusy(btn, "plugin:" + action, true);
    var body = { action: action };
    var pkg = bundlePackageName();
    if (pkg) body.packageName = pkg;
    return request("POST", "/api/plugin", body)
      .then(function (r) {
        showApplied(box, r, action === "enable" ? "启用" : action === "disable" ? "禁用" : "重载");
        if (r.ok && r.data && r.data.applied) toast("插件已" + (action === "enable" ? "启用" : "禁用"));
        else if (r.ok) toast("请求已受理，但服务端未应用（applied=false）", "warn");
        else toast(errText(errorOf(r.data)), "error");
        return load().catch(function () {});
      })
      .then(function () {
        setBusy(btn, "plugin:" + action, false);
      });
  }

  /**
   * 重载：后端 restart = 先 disable 再 enable（已由 host-settings 实现），
   * 前端只发一次 restart 并展示 applied / message，不自己串两次调用。
   */
  function restartPlugin(btn, box) {
    if (BUSY["plugin:restart"]) return;
    setBusy(btn, "plugin:restart", true);
    var body = { action: "restart" };
    var pkg = bundlePackageName();
    if (pkg) body.packageName = pkg;
    request("POST", "/api/plugin", body)
      .then(function (r) {
        showApplied(box, r, "重载");
        if (r.ok && r.data && r.data.applied) toast("插件已重载");
        else if (r.ok) toast("重载请求已受理，但服务端未应用（applied=false）", "warn");
        else toast("重载失败：" + errText(errorOf(r.data)), "error");
        return load().catch(function () {});
      })
      .then(function () {
        setBusy(btn, "plugin:restart", false);
      });
  }

  // ---------- 分区：高级 ----------

  function buildAdvanced() {
    var s = (VIEW && VIEW.settings && VIEW.settings.advanced) || {};
    var electron = registerField("advanced", "advanced.electronPath", textField("advanced.electronPath", {
      label: "Electron 可执行文件路径",
      placeholder: "留空自动探测（node_modules/electron/dist/electron.exe）",
      hint: "改了只在「下次打开小窗」时生效。填绝对路径。",
    }));

    var ioBox = el("div", { class: "test-result" });
    var textarea = el("textarea", {
      class: "textarea",
      placeholder: "导出后这里会出现完整 JSON；或者把网页版备份 / latest.json 的内容粘贴进来再点「导入快照」。",
      spellcheck: "false",
    });

    var btnExport = el("button", { type: "button", class: "btn btn-ghost", text: "导出快照" });
    btnExport.addEventListener("click", function () {
      setBusy(btnExport, "export", true);
      request("POST", "/api/sources/export", {})
        .then(function (r) {
          if (!r.ok) {
            clear(ioBox);
            ioBox.dataset.tone = "error";
            ioBox.appendChild(el("div", { class: "test-line" }, [el("span", { class: "v", "data-tone": "error", text: errText(errorOf(r.data)) })]));
            toast(errText(errorOf(r.data)), "error");
            return;
          }
          var d = r.data || {};
          textarea.value = d.text || "";
          // 顺手触发下载，失败不影响复制
          try {
            var blob = new Blob([textarea.value], { type: "application/json" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = d.filename || "study-dashboard-snapshot.json";
            document.body.appendChild(a);
            a.click();
            window.setTimeout(function () {
              URL.revokeObjectURL(a.href);
              if (a.parentNode) a.parentNode.removeChild(a);
            }, 0);
          } catch (e) {
            /* 下载失败就手动复制 */
          }
          clear(ioBox);
          ioBox.dataset.tone = "ok";
          ioBox.appendChild(el("div", { class: "test-title", "data-tone": "ok", text: "已导出" + (d.filename ? "：" + d.filename : "") }));
          toast("已导出快照");
        })
        .then(function () {
          setBusy(btnExport, "export", false);
        });
    });

    var btnImport = el("button", { type: "button", class: "btn btn-ghost", text: "导入快照" });
    btnImport.addEventListener("click", function () {
      var text = textarea.value.trim();
      if (!text) {
        toast("先把快照内容粘贴到下面的文本框里", "warn");
        return;
      }
      setBusy(btnImport, "import", true);
      request("POST", "/api/sources/import", { text: text })
        .then(function (r) {
          clear(ioBox);
          ioBox.dataset.tone = r.ok ? "ok" : "error";
          if (!r.ok) {
            ioBox.appendChild(el("div", { class: "test-line" }, [el("span", { class: "v", "data-tone": "error", text: errText(errorOf(r.data)) })]));
            toast(errText(errorOf(r.data)), "error");
            return;
          }
          var sum = (r.data && r.data.summary) || {};
          var line = "导入成功";
          var bits = [];
          if (sum.rev != null) bits.push("rev " + sum.rev);
          if (sum.email) bits.push(sum.email);
          if (sum.courses != null) bits.push(sum.courses + " 门课程");
          if (sum.todoOpen != null) bits.push(sum.todoOpen + " 条待办");
          if (sum.source) bits.push("来源 " + sum.source);
          if (bits.length) line += "：" + bits.join(" · ");
          ioBox.appendChild(el("div", { class: "test-title", "data-tone": "ok", text: line }));
          toast("已导入快照");
          return load().catch(function () {});
        })
        .then(function () {
          setBusy(btnImport, "import", false);
        });
    });

    var foot = saveFoot("advanced");
    BUILT.advanced.foot = foot;

    return [
      card("运行环境", "Electron 路径与数据目录；数据目录只读展示。", [
        electron.node,
        readonlyRow("数据目录", s.homeDir || "—", s.homeDir || ""),
        readonlyRow("settings.json", s.settingsFile || (s.homeDir ? s.homeDir + "\\settings.json" : "—")),
        readonlyRow("login.json", s.loginFile || (s.homeDir ? s.homeDir + "\\login.json" : "—")),
      ], [foot.node]),
      card("数据快照", "导出当前数据做备份，或导入网页版备份覆盖本地快照（只影响本地缓存）。", [
        ioBox,
        textarea,
        el("div", { class: "action-row" }, [btnExport, btnImport]),
      ]),
    ];
  }

  // ---------- 分区：关于 ----------

  function buildAbout() {
    var plugin = (VIEW && VIEW.plugin) || {};
    var status = (VIEW && VIEW.status) || {};
    // 版本来源依次：整包 version → plugin.version → 打包时的默认值（后端不一定给，给就拿）
    var version = (VIEW && VIEW.version) || (plugin.version != null ? plugin.version : "") || "1.0.0";

    var srcText = status.source || "—";
    var srcMap = { supabase: "Supabase 云端", file: "本地快照", cache: "本地缓存" };
    srcText = srcMap[srcText] || srcText;
    if (status.error) srcText += "（只读缓存）";
    if (VIEW && VIEW.settings && VIEW.settings.data && VIEW.settings.data.offline) srcText += " · 离线模式";

    return [
      card("关于", "学业工作台桌面小组件，DeepSeek Harness 插件。", [
        el("div", { class: "about-grid" }, [
          el("div", { class: "about-block" }, [
            el("div", { class: "about-k", text: "版本" }),
            el("div", { class: "about-v", text: version }),
          ]),
          el("div", { class: "about-block" }, [
            el("div", { class: "about-k", text: "当前数据源" }),
            el("div", { class: "about-v", text: srcText }),
          ]),
          el("div", { class: "about-block" }, [
            el("div", { class: "about-k", text: "插件入口" }),
            el("div", { class: "about-v", text: plugin.entryId || "—" }),
          ]),
          el("div", { class: "about-block" }, [
            el("div", { class: "about-k", text: "上次同步" }),
            el("div", {
              class: "about-v",
              text: (status.rev ? "rev " + status.rev + " · " : "") + (status.updatedAt ? fmtTime(status.updatedAt) : "—"),
            }),
          ]),
        ]),
      ], [
        el("a", { class: "link", href: README_URL, target: "_blank", rel: "noopener noreferrer", text: "插件 README" }),
        el("a", { class: "link", href: REPO_URL, target: "_blank", rel: "noopener noreferrer", text: "仓库" }),
        el("a", { class: "link", href: WEB_URL, target: "_blank", rel: "noopener noreferrer", text: "网页版" }),
        el("span", { class: "foot-spacer" }),
        el("span", { class: "foot-note", text: "只读数据，不会修改云端" }),
      ]),
    ];
  }

  var BUILDERS = {
    connection: buildConnection,
    window: buildWindow,
    refresh: buildRefresh,
    plugin: buildPlugin,
    advanced: buildAdvanced,
    about: buildAbout,
  };

  // ---------- 分区导航与滚动定位 ----------

  function buildNav() {
    clear(SECTIONS_NAV);
    SECTIONS.forEach(function (s) {
      var link = el("button", { type: "button", class: "section-link", "data-section": s.id, "aria-current": s.id === ACTIVE_SECTION ? "true" : "false" }, [
        el("span", { class: "ic", "aria-hidden": "true", text: s.icon }),
        el("span", { text: s.label }),
      ]);
      link.addEventListener("click", function () {
        scrollToSection(s.id);
      });
      SECTIONS_NAV.appendChild(link);
    });
  }

  function scrollToSection(id) {
    var target = CONTENT.querySelector('[data-anchor="' + id + '"]');
    if (!target) return;
    ACTIVE_SECTION = id;
    syncNavActive();
    try {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      target.scrollIntoView();
    }
  }

  function syncNavActive() {
    Array.prototype.forEach.call(SECTIONS_NAV.children, function (link) {
      link.setAttribute("aria-current", link.dataset.section === ACTIVE_SECTION ? "true" : "false");
    });
  }

  /** 滚动时根据分区位置高亮导航（内容不足一屏时按当前分区） */
  function observeSections() {
    if (typeof window.IntersectionObserver !== "function") return;
    var io = new IntersectionObserver(
      function (entries) {
        var best = null;
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          if (!best || e.intersectionRatio > best.intersectionRatio || e.boundingClientRect.top < best.boundingClientRect.top) best = e;
        });
        if (best && best.target && best.target.dataset) {
          ACTIVE_SECTION = best.target.dataset.anchor;
          syncNavActive();
        }
      },
      { rootMargin: "-90px 0px -55% 0px", threshold: [0, 0.15, 0.5] }
    );
    Array.prototype.forEach.call(CONTENT.querySelectorAll("[data-anchor]"), function (node) {
      io.observe(node);
    });
  }

  // ---------- 渲染整页 ----------

  function renderAll() {
    clear(CONTENT);
    BUILT = {};
    SECTIONS.forEach(function (s) {
      var holder = el("div", { "data-anchor": s.id, class: "section-group" });
      var nodes = BUILDERS[s.id] ? BUILDERS[s.id]() : [];
      nodes.forEach(function (n) {
        if (n) holder.appendChild(n);
      });
      CONTENT.appendChild(holder);
    });
    buildNav();
    markDirty();
  }

  // ---------- 读取 / 保存 ----------

  /** 从服务端读一次，重置草稿并重画表单 */
  function load() {
    if (BTN_RELOAD) BTN_RELOAD.dataset.busy = "true";
    SHELL.dataset.state = "loading";
    return request("GET", "/api/settings")
      .then(function (r) {
        if (!r.ok) {
          renderFatal(failureOf(r));
          return;
        }
        VIEW = r.data;
        DRAFT = draftFromView(VIEW.settings);
        SHELL.dataset.state = "ready";
        renderStatus(VIEW);
        renderAll();
        observeSections();
      })
      .then(function () {
        if (BTN_RELOAD) BTN_RELOAD.dataset.busy = "";
      });
  }

  function draftFromView(settings) {
    var s = settings || {};
    var d = clone(s) || {};
    // 密码只进不出：草稿里永远是空串
    if (!isObj(d.supabase)) d.supabase = {};
    d.supabase.password = "";
    delete d.supabase.hasPassword;
    delete d.supabase.hasRefreshToken;
    if (isObj(d.advanced)) {
      delete d.advanced.homeDir;
      delete d.advanced.settingsFile;
      delete d.advanced.loginFile;
    }
    return d;
  }

  /** 当前草稿与基线不同的路径（规范化后比较） */
  function changedPaths() {
    var out = [];
    var base = VIEW && VIEW.settings;
    if (!base) return out;
    FIELD_PATHS.forEach(function (path) {
      var a = normalize(path, getPath(DRAFT, path));
      var b = normalize(path, getPath(base, path));
      if (path === "supabase.password") {
        if (a !== "") out.push(path);
        return;
      }
      if (a !== b) out.push(path);
    });
    return out;
  }

  function isChanged(path) {
    var base = VIEW && VIEW.settings;
    if (!base) return false;
    if (path === "supabase.password") return String(getPath(DRAFT, path) || "") !== "";
    return normalize(path, getPath(DRAFT, path)) !== normalize(path, getPath(base, path));
  }

  function normalize(path, value) {
    if (path === "desktop.width" || path === "desktop.height" || path === "refresh.pageSeconds" || path === "refresh.summaryTtlSeconds") {
      var n = Number(value);
      return Number.isFinite(n) ? n : value == null ? "" : String(value);
    }
    if (path === "desktop.autoOpen" || path === "desktop.alwaysOnTop" || path === "refresh.autoRefresh" || path === "data.offline") {
      return value === true || value === "true" || value === 1 ? "1" : "0";
    }
    if (path === "supabase.password") return String(value || "");
    return value == null ? "" : String(value);
  }

  /** 校验表单：返回 { ok, message, focusPath } */
  function validate(paths) {
    var bad = {};
    var first = null;

    function fail(path, message) {
      bad[path] = message;
      if (!first) first = { path: path, message: message };
    }

    var width = Number(getPath(DRAFT, "desktop.width"));
    if (paths.indexOf("desktop.width") >= 0 && (!Number.isFinite(width) || width < 300 || width > 1600)) {
      fail("desktop.width", "宽度需在 300–1600 之间");
    }
    var height = Number(getPath(DRAFT, "desktop.height"));
    if (paths.indexOf("desktop.height") >= 0 && (!Number.isFinite(height) || height < 320 || height > 1600)) {
      fail("desktop.height", "高度需在 320–1600 之间");
    }
    var page = Number(getPath(DRAFT, "refresh.pageSeconds"));
    if (paths.indexOf("refresh.pageSeconds") >= 0 && (!Number.isFinite(page) || page < 10 || page > 86400)) {
      fail("refresh.pageSeconds", "刷新间隔需在 10–86400 秒之间");
    }
    var ttl = Number(getPath(DRAFT, "refresh.summaryTtlSeconds"));
    if (paths.indexOf("refresh.summaryTtlSeconds") >= 0 && (!Number.isFinite(ttl) || ttl < 0 || ttl > 3600)) {
      fail("refresh.summaryTtlSeconds", "缓存时长需在 0–3600 秒之间");
    }
    var url = String(getPath(DRAFT, "supabase.url") || "").trim();
    if (paths.indexOf("supabase.url") >= 0 && url && !/^https?:\/\/[^\s/]+/i.test(url)) {
      fail("supabase.url", "URL 需以 https:// 开头");
    }
    var email = String(getPath(DRAFT, "supabase.email") || "").trim();
    if (paths.indexOf("supabase.email") >= 0 && email && email.indexOf("@") < 1) {
      fail("supabase.email", "邮箱格式看起来不对");
    }

    // 标红
    Object.keys(bad).forEach(function (p) {
      Object.keys(BUILT).forEach(function (sid) {
        var ctl = BUILT[sid] && BUILT[sid].els[p];
        if (ctl) {
          ctl.dataset.invalid = "true";
          ctl.setAttribute("title", bad[p]);
        }
      });
    });

    return { ok: !first, first: first, bad: bad };
  }

  /** 把「改动路径集合」包成 { settings: Partial<SettingsInput> } */
  function packPartial(paths) {
    var out = {};
    paths.forEach(function (p) {
      var v = getPath(DRAFT, p);
      setPath(out, p, v);
    });
    return out;
  }

  function save(sectionId) {
    var key = "save:" + sectionId;
    if (BUSY[key]) return;
    // 只提交本分区里有变化的字段；数据目录等只读项不在 els 里，自然不会带上
    var paths = [];
    Object.keys((BUILT[sectionId] && BUILT[sectionId].els) || {}).forEach(function (p) {
      if (isChanged(p)) paths.push(p);
    });

    if (!paths.length) {
      toast("没有改动，无需保存");
      return;
    }

    var v = validate(paths);
    if (!v.ok) {
      toast(v.first.message + "（" + fieldLabel(v.first.path) + "）", "error");
      focusField(v.first.path);
      return;
    }

    var foot = BUILT[sectionId] && BUILT[sectionId].foot;
    var btn = foot && foot.button;
    if (btn) {
      btn.dataset.busy = "true";
      btn.disabled = true;
    }
    BUSY[key] = true;

    request("POST", "/api/settings", { settings: packPartial(paths) })
      .then(function (r) {
        if (!r.ok) {
          toast("保存失败：" + errText(errorOf(r.data)), "error");
          return;
        }
        toast("已保存");
        var needsRestart = paths.filter(function (p) {
          return RESTART_PATHS.indexOf(p) >= 0;
        });
        if (needsRestart.length) toast("下次打开小窗生效（" + needsRestart.map(fieldLabel).join("、") + "）", "warn", 5200);

        // 用返回结果刷新页面（后端可能做了规整，比如补全 URL）
        VIEW = r.data;
        DRAFT = draftFromView(VIEW.settings);
        renderStatus(VIEW);
        renderAll();
        observeSections();
        scrollToSection(sectionId);
      })
      .then(function () {
        BUSY[key] = false;
        if (btn) {
          btn.dataset.busy = "";
          btn.disabled = false;
        }
      });
  }

  var LABELS = {
    "supabase.url": "Supabase URL",
    "supabase.anonKey": "anon key",
    "supabase.email": "登录邮箱",
    "supabase.password": "密码",
    "desktop.autoOpen": "自动打开",
    "desktop.alwaysOnTop": "置顶",
    "desktop.width": "宽度",
    "desktop.height": "高度",
    "refresh.autoRefresh": "自动刷新",
    "refresh.pageSeconds": "页面刷新间隔",
    "refresh.summaryTtlSeconds": "缓存时长",
    "data.offline": "离线模式",
    "data.stateFile": "stateFile",
    "advanced.electronPath": "Electron 路径",
  };

  function fieldLabel(path) {
    return LABELS[path] || path;
  }

  function focusField(path) {
    Object.keys(BUILT).forEach(function (sid) {
      var ctl = BUILT[sid] && BUILT[sid].els[path];
      if (!ctl) return;
      var anchor = ctl.closest ? ctl.closest("[data-anchor]") : null;
      if (anchor && anchor.dataset) {
        ACTIVE_SECTION = anchor.dataset.anchor;
        syncNavActive();
      }
      try {
        ctl.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (e) {
        /* 忽略 */
      }
      ctl.focus();
    });
  }

  // ---------- 测试连接 ----------

  /** 测试连接：{auth:{...}, data:{...}} 分行渲染，成功绿色、失败红色 */
  function testConnection(btn, box) {
    if (BUSY.test) return;
    setBusy(btn, "test", true);
    clear(box);
    box.dataset.tone = "";
    box.appendChild(el("div", { class: "test-sub", text: "正在测试…" }));

    var payload = {
      settings: {
        supabase: {
          url: getPath(DRAFT, "supabase.url") || "",
          anonKey: getPath(DRAFT, "supabase.anonKey") || "",
          email: getPath(DRAFT, "supabase.email") || "",
        },
      },
    };
    // 留空表示沿用已保存的密码 / 其余字段，不传
    var pwd = String(getPath(DRAFT, "supabase.password") || "");
    if (pwd) payload.settings.supabase.password = pwd;

    request("POST", "/api/settings/test", payload)
      .then(function (r) {
        clear(box);
        var d = r.data || {};
        var auth = d.auth || {};
        var data = d.data || null;
        var ok = !!(r.ok && auth.ok !== false && (!data || data.ok !== false));

        box.dataset.tone = ok ? "ok" : "error";
        box.appendChild(
          el("div", {
            class: "test-title",
            "data-tone": ok ? "ok" : "error",
            text: ok ? "连接正常" : r.ok && auth.ok ? "登录成功，但读不到数据" : "连接失败",
          })
        );

        // 认证部分
        if (r.ok || d.auth) {
          var authOk = auth.ok !== false;
          box.appendChild(
            el("div", { class: "test-line" }, [
              el("span", { class: "k", text: "认证" }),
              el("span", {
                class: "v",
                "data-tone": authOk && d.auth ? "ok" : d.auth ? "error" : null,
                text: !d.auth ? "未返回认证结果" : authOk ? "通过" : "失败",
              }),
            ])
          );
          if (auth.email) {
            box.appendChild(el("div", { class: "test-line" }, [el("span", { class: "k", text: "账号" }), el("span", { class: "v", text: auth.email })]));
          }
          if (auth.userId) {
            box.appendChild(el("div", { class: "test-line" }, [el("span", { class: "k", text: "user_id" }), el("span", { class: "v", text: auth.userId })]));
          }
          if (auth.error) {
            box.appendChild(
              el("div", { class: "test-line" }, [
                el("span", { class: "k", text: "auth 错误" }),
                el("span", { class: "v", "data-tone": "error", text: errText(auth.error) }),
              ])
            );
          }
        }

        // 数据部分（成功时绿色显示）
        if (data) {
          var dataOk = data.ok !== false;
          box.appendChild(
            el("div", { class: "test-line" }, [
              el("span", { class: "k", text: "数据读取" }),
              el("span", { class: "v", "data-tone": dataOk ? "ok" : "error", text: dataOk ? "通过" : "失败" }),
            ])
          );
          if (data.rev != null) {
            box.appendChild(el("div", { class: "test-line" }, [el("span", { class: "k", text: "rev" }), el("span", { class: "v", text: String(data.rev) })]));
          }
          if (data.updatedAt) {
            box.appendChild(
              el("div", { class: "test-line" }, [el("span", { class: "k", text: "更新时间" }), el("span", { class: "v", text: fmtTime(data.updatedAt) })])
            );
          }
          if (data.todoOpen != null) {
            box.appendChild(
              el("div", { class: "test-line" }, [el("span", { class: "k", text: "未完成待办" }), el("span", { class: "v", text: String(data.todoOpen) })])
            );
          }
          if (data.courses != null) {
            var coursesText = Array.isArray(data.courses) ? data.courses.length + " 门课程" : String(data.courses);
            box.appendChild(el("div", { class: "test-line" }, [el("span", { class: "k", text: "课程" }), el("span", { class: "v", text: coursesText })]));
          }
          if (data.error) {
            box.appendChild(
              el("div", { class: "test-line" }, [
                el("span", { class: "k", text: "data 错误" }),
                el("span", { class: "v", "data-tone": "error", text: errText(data.error) }),
              ])
            );
          }
        }

        // 整包失败：原样显示 error.message（必要时带 code）
        if (!r.ok) {
          var err = errorOf(d);
          box.appendChild(
            el("div", { class: "test-line" }, [
              el("span", { class: "k", text: "错误" + (err.code ? " " + err.code : "") }),
              el("span", { class: "v", "data-tone": "error", text: errText(err) }),
            ])
          );
        }

        if (ok) toast("连接正常");
        else toast("连接失败：" + errText((d.auth && d.auth.error) || (data && data.error) || errorOf(d)), "error");
      })
      .then(function () {
        setBusy(btn, "test", false);
      });
  }

  // ---------- 致命错误（整页读不到设置） ----------

  /**
   * 整页读不到设置时的错误态：不白屏，且状态条显式显示「未连接」，
   * 标题里带 code（404 → NOT_MOUNTED、401 → UNAUTHORIZED，一眼区分路由没挂还是鉴权没过）。
   */
  function renderFatal(err) {
    SHELL.dataset.state = "error";
    BRAND_DOT.dataset.kind = "error";
    PAGE_HINT.textContent = "读取设置失败";

    // 状态条：四个格子都填上「未连接 / —」，不留空格子
    clear(STATUS_STRIP);
    [
      { k: "数据源", v: "未连接", tone: "error", sub: err && err.code ? err.code : "接口不可用" },
      { k: "上次同步", v: "—", tone: "", sub: "" },
      { k: "桌面窗口", v: "—", tone: "", sub: "" },
      { k: "插件", v: "—", tone: "", sub: "" },
    ].forEach(function (c) {
      STATUS_STRIP.appendChild(
        el("div", { class: "status-cell", "data-tone": c.tone || null, title: c.sub || "" }, [
          el("div", { class: "status-k", text: c.k }),
          el("div", { class: "status-v", text: c.v }),
          c.sub ? el("div", { class: "status-sub", text: c.sub }) : null,
        ])
      );
    });

    clear(CONTENT);
    var title = "读不到设置";
    if (err && err.code) title += "（" + err.code + "）";
    if (err && err.status) title += " · HTTP " + err.status;

    var hintText = "请确认插件已启用、页面是从 /dsh-study-widget/settings 同源打开的；点「重试」再读一次。";
    if (err && err.code === "NOT_MOUNTED") hintText = "接口没挂上（HTTP 404）：插件已在跑但路由未注册，多半是宿主侧挂载问题。";
    else if (err && err.code === "UNAUTHORIZED") hintText = "鉴权没过（HTTP 401）：宿主只放行本机同源 / DSH Cookie / 小窗 token，看看是不是跨源打开的。";

    var banner = el("div", { class: "banner", "data-tone": "error" }, [
      el("div", { class: "banner-main" }, [
        el("div", { class: "banner-title", text: title }),
        el("div", { class: "banner-msg", text: (err && err.message) || "未知错误" }),
        el("p", { class: "hint", text: hintText }),
      ]),
    ]);
    var retry = el("button", { type: "button", class: "btn btn-ghost", text: "重试" });
    retry.addEventListener("click", function () {
      load();
    });
    CONTENT.appendChild(banner);
    CONTENT.appendChild(el("div", { class: "action-row" }, [retry]));
  }

  // ---------- 事件接线 ----------

  if (BTN_RELOAD) {
    BTN_RELOAD.addEventListener("click", function () {
      var dirty = changedPaths().length > 0;
      if (dirty && !window.confirm("有未保存的修改，重新读取会丢弃它们，继续？")) return;
      load();
    });
  }

  // 保存快捷键：Ctrl/⌘ + S 保存当前可见分区
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      save(ACTIVE_SECTION);
    }
  });

  // 有未保存修改时离开页面提醒
  window.addEventListener("beforeunload", function (e) {
    if (changedPaths().length) {
      e.preventDefault();
      e.returnValue = "";
      return "";
    }
    return undefined;
  });

  load();
})();

/* ============================================================
   ПУЛЬС — SPA панели контроля открытых линий
   ============================================================ */
(() => {
  "use strict";

  const S = {
    data: null,
    page: "pulse",
    period: 7,
    chatId: null,
    filter: "all",
    q: "",
    promiseFilter: "all",
    employeeFilter: null,
    presence: "observer",
    loading: true,
    error: null,
  };

  const STATIC = Boolean(window.PULSE_STATIC);
  const GITHUB_URL = window.PULSE_GITHUB || "https://github.com/saoneclick/pulse-openlines";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const icon = (name, cls = "") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const num = (n) => new Intl.NumberFormat("ru-RU").format(Number(n || 0));
  const verdictLabel = { ok: "В норме", watch: "Внимание", critical: "Проблема" };
  const sevLabel = { critical: "критично", high: "важно", medium: "средне", low: "мелко" };
  const statusLabel = { kept: "Выполнено", open: "В работе", overdue: "Просрочено" };

  const fmtDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  const fmtWeekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  const dt = (iso) => (iso ? fmtDate.format(new Date(iso)).replace(".", "") : "—");
  const day = (iso) => (iso ? fmtDay.format(new Date(iso)).replace(".", "") : "—");

  function minutes(value) {
    if (value == null) return "—";
    const v = Math.max(0, Math.round(value));
    if (v < 60) return `${v} мин`;
    const h = Math.floor(v / 60);
    const m = v % 60;
    if (h < 24) return m ? `${h} ч ${m} мин` : `${h} ч`;
    const d = Math.floor(h / 24);
    const hh = h % 24;
    return hh ? `${d} д ${hh} ч` : `${d} д`;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 60000;
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (sameDay) return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === yesterday.toDateString()) return "вчера";
    return fmtDay.format(d).replace(".", "");
  }

  const scoreClass = (verdict) => (verdict === "critical" ? "critical" : verdict === "watch" ? "watch" : "ok");
  const isOverdue = (p) => p.status === "overdue";

  function plural(n, one, few, many) {
    n = Math.abs(n);
    if (n % 10 === 1 && n % 100 !== 11) return one;
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return few;
    return many;
  }

  // ---------------------------------------------------------------- api
  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Ошибка ${res.status}`);
    return data;
  }

  async function loadState() {
    S.loading = true;
    S.error = null;
    render();
    try {
      if (STATIC) {
        const res = await fetch(`state-${S.period}.json`, { cache: "no-store" });
        if (!res.ok) throw new Error("Не удалось загрузить демо-данные");
        S.data = await res.json();
      } else {
        S.data = await api(`/state?period=${S.period}`);
      }
      if (!S.chatId) {
        const first = S.data.overview.attention[0] || S.data.chats[0];
        S.chatId = first ? first.id || first.chat_id : null;
      }
      if (S.data.settings?.presence?.mode) S.presence = S.data.settings.presence.mode;
    } catch (err) {
      S.error = err.message;
    }
    S.loading = false;
    render();
  }

  // ---------------------------------------------------------------- ui bits
  function toast(message, type = "ok") {
    const node = document.createElement("div");
    node.className = `toast ${type === "err" ? "err" : ""}`;
    node.textContent = message;
    $("#toasts").appendChild(node);
    setTimeout(() => node.remove(), 3800);
  }

  function openModal(html) {
    $("#modal-card").innerHTML = html;
    $("#modal").hidden = false;
  }
  function closeModal() { $("#modal").hidden = true; }
  function openDrawer(title, html) {
    $("#drawer-title").textContent = title;
    $("#drawer-body").innerHTML = html;
    $("#drawer").hidden = false;
    $("#scrim").hidden = false;
  }
  function closeDrawer() {
    $("#drawer").hidden = true;
    $("#scrim").hidden = true;
  }

  function chip(text, tone = "") {
    return `<span class="chip ${tone}">${esc(text)}</span>`;
  }

  function scoreBadge(score, verdict) {
    return `<span class="score-badge ${scoreClass(verdict)}">${score}</span>`;
  }

  function findingRow(f, compact = false) {
    const good = f.tone === "good";
    return `
      <div class="finding ${good ? "good" : "bad"}">
        <span class="finding-icon">${icon(good ? "check" : "alert")}</span>
        <div class="finding-body">
          <div class="finding-title">
            ${esc(f.title)}
            <span class="sev ${f.severity}">${sevLabel[f.severity] || f.severity}</span>
          </div>
          <div class="finding-meta">${esc(f.client || "")}${f.employee ? ` · ${esc(f.employee)}` : ""}</div>
          <div class="finding-text">${esc(f.detail)}</div>
          ${f.quote ? `<div class="finding-quote">«${esc(f.quote)}»</div>` : ""}
          ${!compact && f.recommendation ? `<div class="finding-rec">${icon("bolt")}<span>${esc(f.recommendation)}</span></div>` : ""}
        </div>
      </div>`;
  }

  function ring(score, size = 142) {
    const r = 58;
    const c = 2 * Math.PI * r;
    const dash = Math.max(0, Math.min(100, score)) / 100 * c;
    return `
      <div class="ring" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 142 142" style="width:${size}px;height:${size}px">
          <circle class="track" cx="71" cy="71" r="${r}"></circle>
          <circle class="bar" cx="71" cy="71" r="${r}" stroke-dasharray="${dash} ${c}"></circle>
        </svg>
        <div class="ring-center"><b>${score}</b><small>из 100</small></div>
      </div>`;
  }

  function trendChart(trend) {
    const W = 660, H = 190, L = 34, R = 14, T = 14, B = 28;
    const iw = W - L - R, ih = H - T - B;
    const n = trend.length;
    const x = (i) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = (v) => T + ih - (v / 100) * ih;
    const maxCrit = Math.max(6, ...trend.map((t) => t.critical));
    const points = trend.map((t, i) => `${x(i)},${y(t.score)}`).join(" ");
    const area = `${L},${T + ih} ${points} ${x(n - 1)},${T + ih}`;
    const grid = [0, 25, 50, 75, 100].map((v) => `
      <line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"></line>
      <text x="${L - 7}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("");
    const bars = trend.map((t, i) => {
      const h = (t.critical / maxCrit) * 24;
      return `<rect class="bar" x="${x(i) - 5}" y="${T + ih - h}" width="10" height="${h}" rx="2"></rect>`;
    }).join("");
    const dots = trend.map((t, i) => `<circle class="point" cx="${x(i)}" cy="${y(t.score)}" r="3"></circle>`).join("");
    const labels = trend.map((t, i) => (n > 12 && i % 3 !== 0 && i !== n - 1) ? "" :
      `<text x="${x(i)}" y="${H - 7}" text-anchor="middle">${esc(t.label)}</text>`).join("");
    const last = trend[n - 1];
    return `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Динамика пульса">
        <defs>
          <linearGradient id="pulseFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#c8f36a" stop-opacity="0.38"></stop>
            <stop offset="100%" stop-color="#c8f36a" stop-opacity="0.02"></stop>
          </linearGradient>
        </defs>
        ${grid}
        ${bars}
        <polygon class="area" points="${area}"></polygon>
        <polyline class="line" points="${points}"></polyline>
        ${dots}
        ${labels}
        <text x="${x(n - 1)}" y="${y(last.score) - 10}" text-anchor="end" style="font-weight:600;fill:#17211d">${last.score}</text>
      </svg>`;
  }

  // ---------------------------------------------------------------- pulse
  function pagePulse() {
    const d = S.data;
    const o = d.overview;
    const p = o.pulse;
    const date = new Date(d.meta.generated_at);
    const weekday = fmtWeekday.format(date);
    const total = o.status_split.ok + o.status_split.watch + o.status_split.critical || 1;
    const w = (v) => Math.round(v * 100 / total);
    const criticalList = o.attention.filter((a) => a.verdict === "critical");
    const watchList = o.attention.filter((a) => a.verdict !== "critical");
    const mainList = criticalList.length ? criticalList : o.attention;

    return `
      <div class="page-head">
        <div>
          <h1>Пульс открытых линий</h1>
          <p>${esc(weekday.charAt(0).toUpperCase() + weekday.slice(1))} · ${o.kpis[0].value} ${plural(o.kpis[0].value, "активный чат", "активных чата", "активных чатов")} · ${d.meta.demo ? "демонстрационные данные" : "данные из Битрикс24"}</p>
        </div>
        <div class="page-actions">
          <div class="segmented" data-period-group>
            <button data-period="7" class="${S.period === 7 ? "active" : ""}">7 дней</button>
            <button data-period="14" class="${S.period === 14 ? "active" : ""}">14 дней</button>
            <button data-period="30" class="${S.period === 30 ? "active" : ""}">30 дней</button>
          </div>
          <button class="btn btn-dark" data-nav="report">${icon("doc")}Отчёт за неделю</button>
        </div>
      </div>

      <div class="hero-grid">
        <section class="pulse-card">
          <div class="pulse-top">
            <span class="eyebrow">Пульс команды</span>
            <span class="pulse-watch"><i class="dot"></i>наблюдение</span>
          </div>
          <div class="pulse-main">
            ${ring(p.score)}
            <div class="pulse-copy">
              <div class="verdict-line">${esc(p.label)}</div>
              <div class="delta ${p.delta >= 0 ? "" : "down"}">${p.delta >= 0 ? "↑" : "↓"} ${Math.abs(p.delta)} за ${S.period} ${plural(S.period, "день", "дня", "дней")}</div>
            </div>
          </div>
          <p class="pulse-caption">${esc(p.caption)}</p>
          <div class="split-bar" title="Норма / внимание / проблема">
            <span class="ok" style="width:${w(o.status_split.ok)}%"></span>
            <span class="watch" style="width:${w(o.status_split.watch)}%"></span>
            <span class="critical" style="width:${w(o.status_split.critical)}%"></span>
          </div>
          <div class="pulse-legend">
            <span><i style="background:var(--lime)"></i>норма · ${o.status_split.ok}</span>
            <span><i style="background:#e2b15a"></i>внимание · ${o.status_split.watch}</span>
            <span><i style="background:#e0745f"></i>проблема · ${o.status_split.critical}</span>
          </div>
        </section>

        <div class="kpi-grid">
          ${o.kpis.map((k) => kpiCard(k)).join("")}
        </div>
      </div>

      <div class="grid g-3-2 mt">
        <section class="card">
          <div class="card-head">
            <h3>Требуют вмешательства</h3>
            <span class="chip red">${mainList.length}</span>
            <span class="muted right">Сначала самые тяжёлые</span>
          </div>
          <div class="att-list">
            ${mainList.length ? mainList.map((a) => attentionRow(a)).join("") : `<div class="empty"><b>Красной зоны нет</b>Все чаты в норме или под наблюдением.</div>`}
          </div>
          ${watchList.length ? `<div class="att-more" data-nav="chats">Под наблюдением: ${watchList.length} ${plural(watchList.length, "чат", "чата", "чатов")} · открыть все ${icon("arrow")}</div>` : ""}
        </section>

        <section class="card">
          <div class="card-head">
            <h3>План на сегодня</h3>
            <span class="muted right">${o.plan.length} ${plural(o.plan.length, "действие", "действия", "действий")}</span>
          </div>
          <div class="plan-list">
            ${o.plan.map((item) => `
              <div class="plan-item ${item.priority}" data-chat="${item.chat_id}">
                <span class="plan-dot"></span>
                <div class="plan-copy">
                  <div class="plan-title">${esc(item.title)}</div>
                  <div class="plan-detail">${esc(item.detail)}</div>
                  ${item.chat ? `<div class="plan-client">${icon("chat")}${esc(item.chat.client)} · ${esc(item.chat.topic)}</div>` : ""}
                </div>
              </div>`).join("")}
          </div>
        </section>
      </div>

      <div class="grid g-3-2 mt">
        <section class="card">
          <div class="card-head">
            <h3>Динамика пульса</h3>
            <span class="muted right">${esc(o.trend[0]?.label || "")} — ${esc(o.trend[o.trend.length - 1]?.label || "")}</span>
          </div>
          <div class="chart-wrap">
            ${trendChart(o.trend)}
            <div class="legend">
              <span><i style="background:#17211d"></i>оценка команды</span>
              <span><i style="background:rgba(184,58,38,.45)"></i>чаты в проблеме</span>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Команда</h3>
            <span class="muted right">оценка по чатам</span>
          </div>
          <div class="team-list">
            ${o.team.map((t) => `
              <div class="team-row" data-person="${t.id}">
                <span class="avatar">${esc(t.initials)}</span>
                <div>
                  <div class="team-name">${esc(t.name)}</div>
                  <div class="team-role">${esc(t.role)} · ${t.chats} ${plural(t.chats, "чат", "чата", "чатов")}</div>
                </div>
                <div class="team-score ${scoreClass(t.verdict)}">
                  <b>${t.score}</b><small>${esc(verdictLabel[t.verdict])}</small>
                  <div class="bar-line"><i class="${scoreClass(t.verdict)}" style="width:${t.score}%"></i></div>
                </div>
              </div>`).join("")}
          </div>
        </section>
      </div>

      <div class="grid g2 mt">
        <section class="card">
          <div class="card-head">
            <h3>Что хорошо</h3>
            <span class="chip green">${o.good.length}</span>
            <span class="muted right">примеры для команды</span>
          </div>
          <div class="card-body findings">
            ${o.good.map((f) => findingRow(f, true)).join("")}
          </div>
        </section>
        <section class="card">
          <div class="card-head">
            <h3>Что плохо</h3>
            <span class="chip red">${o.bad.length}</span>
            <span class="muted right">с цитатами из переписки</span>
          </div>
          <div class="card-body findings">
            ${o.bad.map((f) => findingRow(f, true)).join("")}
          </div>
        </section>
      </div>
    `;
  }

  function kpiCard(k) {
    const cls = k.tone === "bad" ? "bad" : k.tone === "warn" ? "warn" : k.tone === "good" ? "good" : "";
    const ico = k.key === "money" ? "alert" : k.key === "promises" ? "check-circle" : k.key === "response" ? "clock" : k.key === "attention" ? "bolt" : "chat";
    const value = k.key === "money" ? `${num(k.value)} <small>₽</small>` : `${num(k.value)}${k.unit ? (k.unit === "%" ? `<small class="tight">%</small>` : ` <small>${esc(k.unit)}</small>`) : ""}`;
    return `
      <div class="card kpi ${cls}">
        <span class="kpi-icon">${icon(ico)}</span>
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value">${value}</div>
        <div class="kpi-note">${esc(k.note)}</div>
      </div>`;
  }

  function attentionRow(a) {
    return `
      <div class="att-row" data-chat="${a.chat_id}">
        ${scoreBadge(a.score, a.verdict)}
        <div class="att-main">
          <div class="att-top">
            <b>${esc(a.client)}</b>
            ${a.risk_amount ? `<span class="chip red tiny">${icon("alert")}риск ухода</span>` : `<span class="chip ${a.verdict === "critical" ? "red" : "amber"} tiny">${esc(verdictLabel[a.verdict])}</span>`}
          </div>
          <div class="att-sub">${esc(a.employee)} · ${esc(a.topic)}</div>
          <div class="att-reason">${icon("clock")}${esc(a.reason)}${a.waiting_min ? ` · ждёт ${minutes(a.waiting_min)}` : ""}</div>
        </div>
        <div class="att-right">
          ${a.risk_amount ? `<b>${num(a.risk_amount)} ₽</b><small>под риском</small>` : `<b>${timeAgo(a.last_activity)}</b><small>активность</small>`}
        </div>
        ${icon("arrow")}
      </div>`;
  }

  // ---------------------------------------------------------------- chats
  function filteredChats() {
    if (!S.data) return [];
    const rank = { critical: 0, watch: 1, ok: 2 };
    let items = S.data.chats.filter((c) => c.status === "active");
    if (S.employeeFilter) items = items.filter((c) => c.employee_id === S.employeeFilter);
    if (S.filter !== "all") items = items.filter((c) => c.verdict === S.filter);
    if (S.q) {
      const q = S.q.toLowerCase();
      items = items.filter((c) =>
        [c.client, c.topic, c.employee, c.line, ...(c.tags || [])].join(" ").toLowerCase().includes(q)
      );
    }
    return items.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.score - b.score) || (new Date(b.last_activity) - new Date(a.last_activity)));
  }

  function chatListItem(c) {
    return `
      <div class="chat-item ${c.id === S.chatId ? "active" : ""}" data-chat-id="${c.id}">
        <div class="chat-item-main">
          <div class="chat-item-top">
            <b>${esc(c.client)}</b>
            <span class="chip outline tiny">${esc(c.client_kind)}</span>
            <span class="score-mini ${scoreClass(c.verdict)}">${c.score}</span>
          </div>
          <div class="chat-item-sub">${esc(c.topic)}</div>
          <div class="chat-item-sub">${esc(c.employee)} · ${esc(c.line)}</div>
          <div class="chat-item-foot">
            ${c.waiting_min ? `<span class="chip red tiny">${icon("clock")}ждёт ${minutes(c.waiting_min)}</span>` : `<span class="chip ${scoreClass(c.verdict)} tiny">${esc(verdictLabel[c.verdict])}</span>`}
            ${(c.tags || []).slice(0, 2).map((t) => `<span class="chip tiny">${esc(t)}</span>`).join("")}
            <span class="chat-item-time">${timeAgo(c.last_activity)}</span>
          </div>
        </div>
      </div>`;
  }

  function chatListBlock() {
    const items = filteredChats();
    if (!items.length) return `<div class="empty"><b>Ничего не найдено</b>Измените фильтр или поиск.</div>`;
    return items.map(chatListItem).join("");
  }

  function pageChats() {
    const d = S.data;
    const active = d.chats.filter((c) => c.status === "active");
    const counts = {
      all: active.length,
      critical: active.filter((c) => c.verdict === "critical").length,
      watch: active.filter((c) => c.verdict === "watch").length,
      ok: active.filter((c) => c.verdict === "ok").length,
    };
    const current = d.chats.find((c) => c.id === S.chatId) || active[0];
    const employee = S.employeeFilter ? d.people.find((p) => p.id === S.employeeFilter) : null;

    return `
      <div class="page-head">
        <div>
          <h1>Чаты открытых линий</h1>
          <p>Каждый диалог разобран по фактам: время ответа, обещания, тон, риски. Нажмите на чат, чтобы увидеть разбор и цитаты.</p>
        </div>
        <div class="page-actions">
          ${employee ? `<span class="chip lime">${esc(employee.name)} <button class="link-x" data-action="clear-employee">${icon("x")}</button></span>` : ""}
          <button class="btn btn-ghost" data-nav="report">${icon("doc")}Сводка</button>
        </div>
      </div>

      <div class="chat-layout">
        <section class="card chat-list">
          <div class="list-head">
            <div class="segmented">
              ${[["all", "Все"], ["critical", "Проблема"], ["watch", "Внимание"], ["ok", "Норма"]].map(([key, label]) =>
                `<button data-filter="${key}" class="${S.filter === key ? "active" : ""}">${label} ${counts[key]}</button>`).join("")}
            </div>
            <label class="search">${icon("search")}<input class="input" id="chat-search" placeholder="Клиент, тема, сотрудник…" value="${esc(S.q)}"></label>
          </div>
          <div class="list-scroll" id="chat-items">${chatListBlock()}</div>
        </section>

        <section class="card chat-view" id="chat-view">
          ${current ? chatDetail(current) : `<div class="chat-empty">Выберите чат слева</div>`}
        </section>
      </div>`;
  }

  function chatDetail(c) {
    const bad = c.findings.filter((f) => f.tone === "bad");
    const good = c.findings.filter((f) => f.tone === "good");
    const promises = c.promises;
    const messages = c.messages;

    return `
      <div class="chat-detail-scroll">
        <div class="chat-head">
          <div class="chat-title">
            <h2>${esc(c.client)}</h2>
            <div class="chat-title-sub">
              ${chip(c.client_kind, "outline")}
              ${esc(c.topic)} · ${esc(c.line)}
              ${c.industry ? `<span>· ${esc(c.industry)}</span>` : ""}
            </div>
          </div>
          <div class="chat-head-right">
            <div class="chat-score ${scoreClass(c.verdict)}">${c.score}</div>
            <small>${esc(verdictLabel[c.verdict])}</small>
          </div>
        </div>

        <div class="chat-meta">
          <span class="row"><span class="avatar sm">${esc(c.initials)}</span><b>${esc(c.employee)}</b></span>
          <span class="row"><span class="dot live"></span><span>ПУЛЬС в чате</span></span>
          <span>Ждёт: <b class="${c.waiting_min && c.waiting_min > 60 ? "text-bad" : ""}">${c.waiting_min ? minutes(c.waiting_min) : "нет"}</b></span>
          <span>Активность: <b>${dt(c.last_activity)}</b></span>
          <span>Договор: <b>${num(c.contract_value)} ₽/мес</b></span>
          ${c.risk_amount ? `<span>${chip(`Риск: ${num(c.risk_amount)} ₽/год`, "red")}</span>` : ""}
        </div>

        <div class="verdict">
          <div class="verdict-head">${icon("spark")}Вердикт ПУЛЬС</div>
          <p>${esc(c.summary)}</p>
          <div class="verdict-actions">
            ${bad.length ? `<span class="chip" style="background:rgba(184,58,38,.22);color:#ffb4a4">${bad.length} ${plural(bad.length, "проблема", "проблемы", "проблем")}</span>` : ""}
            ${good.length ? `<span class="chip" style="background:rgba(200,243,106,.16);color:var(--lime)">${good.length} ${plural(good.length, "сильная сторона", "сильные стороны", "сильных сторон")}</span>` : ""}
            ${promises.filter(isOverdue).length ? `<span class="chip" style="background:rgba(184,58,38,.22);color:#ffb4a4">${promises.filter(isOverdue).length} ${plural(promises.filter(isOverdue).length, "просрочка", "просрочки", "просрочек")}</span>` : ""}
          </div>
        </div>

        <div class="mini-metrics">
          <div class="mm"><div class="mm-label">Первый ответ</div><div class="mm-value ${c.first_response_min && c.first_response_min > 30 ? "warn" : ""}">${minutes(c.first_response_min)}</div></div>
          <div class="mm"><div class="mm-label">Средний ответ</div><div class="mm-value ${c.avg_response_min && c.avg_response_min > 30 ? "warn" : ""}">${minutes(c.avg_response_min)}</div></div>
          <div class="mm"><div class="mm-label">Клиент ждёт</div><div class="mm-value ${c.waiting_min && c.waiting_min > 60 ? "bad" : ""}">${c.waiting_min ? minutes(c.waiting_min) : "—"}</div></div>
          <div class="mm"><div class="mm-label">Обещания</div><div class="mm-value ${promises.some(isOverdue) ? "bad" : ""}">${promises.filter((p) => p.status === "kept").length}/${promises.length || 0}</div></div>
        </div>

        ${bad.length ? `
          <div class="chat-section">
            <h4>Что плохо · ${bad.length}</h4>
            <div class="findings">${bad.map((f) => findingRow(f)).join("")}</div>
          </div>` : ""}

        ${good.length ? `
          <div class="chat-section">
            <h4>Что хорошо · ${good.length}</h4>
            <div class="findings">${good.map((f) => findingRow(f)).join("")}</div>
          </div>` : ""}

        ${promises.length ? `
          <div class="chat-section">
            <h4>Обещания сотрудника</h4>
            ${promises.map((p) => `
              <div class="promise-row ${p.status}">
                ${icon(p.status === "kept" ? "check-circle" : p.status === "overdue" ? "alert" : "clock")}
                <div>
                  <div class="promise-text">${esc(p.text)}</div>
                  <div class="promise-meta">${statusLabel[p.status]}${p.status === "overdue" ? ` · просрочено ${minutes(p.overdue_min)}` : ""} · срок ${dt(p.due_at)}</div>
                </div>
              </div>`).join("")}
          </div>` : ""}

        <div class="chat-section">
          <h4>Переписка</h4>
        </div>
        <div class="thread-scroll">
          ${messages.map((m) => messageRow(m)).join("")}
        </div>
      </div>
      <div class="chat-actions">
        <button class="btn btn-dark" data-action="notify" data-chat-id="${c.id}">${icon("send")}Написать сотруднику</button>
        <button class="btn btn-ghost" data-action="task" data-chat-id="${c.id}">${icon("plus")}Поставить задачу</button>
        <button class="btn btn-ghost" data-action="demo-link">${icon("link")}Открыть в Битрикс24</button>
      </div>`;
  }

  function messageRow(m) {
    if (m.internal || m.author === "system") {
      return `<div class="msg-system">${icon("eye")}<span>${esc(m.text)}</span></div>`;
    }
    const side = m.author === "employee" ? "employee" : "client";
    return `
      <div class="msg-row ${side}">
        <div>
          ${m.notes && m.notes.length ? `<div class="msg-notes">${m.notes.map((n) => `<span class="note ${n.tone}">${esc(n.text)}</span>`).join("")}</div>` : ""}
          <div class="msg-author">${esc(m.author_name)}</div>
          <div class="msg ${side}">${esc(m.text)}</div>
          <div class="msg-meta">${dt(m.at)}</div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- people
  function pagePeople() {
    const people = S.data.people;
    return `
      <div class="page-head">
        <div>
          <h1>Люди</h1>
          <p>Оценка собрана из чатов: скорость, обещания, тон и риски. Это не рейтинг «кто лучше», а карта сильных сторон и точек роста.</p>
        </div>
        <div class="page-actions">
          <span class="chip outline">${people.length} ${plural(people.length, "сотрудник", "сотрудника", "сотрудников")}</span>
        </div>
      </div>

      <div class="people-grid">
        ${people.map((p) => personCard(p)).join("")}
      </div>

      <section class="card mt">
        <div class="card-head"><h3>Сравнение</h3><span class="muted right">за выбранный период</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Сотрудник</th><th>Оценка</th><th>Чаты</th><th>Первый ответ</th><th>Обещания в срок</th><th>Риск</th><th></th></tr></thead>
            <tbody>
              ${people.map((p) => `
                <tr data-person="${p.id}" style="cursor:pointer">
                  <td><div class="row"><span class="avatar sm">${esc(p.initials)}</span><div><b>${esc(p.name)}</b><div class="muted small">${esc(p.role)}</div></div></div></td>
                  <td><b class="${p.verdict === "critical" ? "text-bad" : p.verdict === "watch" ? "text-warn" : "text-ok"}" style="font-family:var(--display)">${p.score}</b></td>
                  <td class="num">${p.chats}</td>
                  <td class="num">${minutes(p.avg_first_response_min)}</td>
                  <td class="num">${p.promises_kept_pct == null ? "—" : p.promises_kept_pct + "%"}</td>
                  <td class="num">${p.risk_amount ? num(p.risk_amount) + " ₽" : "—"}</td>
                  <td class="actions"><button class="btn btn-sm btn-soft" data-person="${p.id}">Карточка</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function personCard(p) {
    const s = p.strengths[0];
    const w = p.weaknesses[0];
    return `
      <div class="card person-card" data-person="${p.id}">
        <div class="person-top">
          <span class="avatar">${esc(p.initials)}</span>
          <div class="person-id">
            <div class="person-name">${esc(p.name)}</div>
            <div class="person-role">${esc(p.role)} · с ${esc(p.since)}</div>
          </div>
          <div class="person-score ${scoreClass(p.verdict)}"><b>${p.score}</b><small>${esc(verdictLabel[p.verdict])}</small></div>
        </div>
        <div class="person-stats">
          <div class="ps"><b>${p.chats}</b><small>${plural(p.chats, "чат", "чата", "чатов")}</small></div>
          <div class="ps"><b>${p.avg_first_response_min == null ? "—" : minutes(p.avg_first_response_min)}</b><small>первый ответ</small></div>
          <div class="ps"><b>${p.promises_kept_pct == null ? "—" : p.promises_kept_pct + "%"}</b><small>обещания</small></div>
        </div>
        <div class="person-note">
          ${s ? `<div><b class="plus">+</b> ${esc(s.title)}</div>` : ""}
          ${w ? `<div><b class="minus">−</b> ${esc(w.title)}</div>` : ""}
        </div>
        <div class="person-foot">${icon("chat")}${p.critical} ${plural(p.critical, "критичный чат", "критичных чата", "критичных чатов")}${p.no_response ? ` · ${p.no_response} без ответа` : ""} · открыть разбор</div>
      </div>`;
  }

  function openPerson(id) {
    const p = S.data.people.find((x) => x.id === id);
    if (!p) return;
    const chats = p.chat_ids.map((cid) => S.data.chats.find((c) => c.id === cid)).filter(Boolean);
    openDrawer(p.name, `
      <div class="row" style="gap:12px">
        <span class="avatar" style="width:46px;height:46px;font-size:14px">${esc(p.initials)}</span>
        <div class="grow"><b style="font-size:15px">${esc(p.name)}</b><div class="muted small">${esc(p.role)} · в компании с ${esc(p.since)}</div></div>
        <div class="person-score ${scoreClass(p.verdict)}"><b>${p.score}</b><small>${esc(verdictLabel[p.verdict])}</small></div>
      </div>
      <div class="divider"></div>
      <div class="person-stats" style="margin-top:0;padding-top:0;border-top:0">
        <div class="ps"><b>${p.chats}</b><small>чатов</small></div>
        <div class="ps"><b>${minutes(p.avg_first_response_min)}</b><small>первый ответ</small></div>
        <div class="ps"><b>${p.promises_kept_pct == null ? "—" : p.promises_kept_pct + "%"}</b><small>обещания</small></div>
      </div>
      <div class="hint" style="margin:16px 0">${icon("spark")}<span>${esc(p.name.split(" ")[0])}, сильное: ${p.strengths[0] ? esc(p.strengths[0].title.toLowerCase()) : "—"}. Зона роста: ${p.weaknesses[0] ? esc(p.weaknesses[0].title.toLowerCase()) : "—"}.</span></div>
      <h4 style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint)">Чаты сотрудника</h4>
      ${chats.map((c) => `
        <div class="plan-item" data-chat="${c.id}" data-close-drawer="1" style="padding:10px 0;border-top:1px solid var(--line)">
          <span class="score-badge ${scoreClass(c.verdict)}" style="width:38px;height:38px;font-size:13px">${c.score}</span>
          <div class="plan-copy">
            <div class="plan-title">${esc(c.client)}</div>
            <div class="plan-detail">${esc(c.topic)} · ${c.waiting_min ? "ждёт " + minutes(c.waiting_min) : "активность " + timeAgo(c.last_activity)}</div>
          </div>
        </div>`).join("")}
    `);
  }

  // ---------------------------------------------------------------- promises
  function pagePromises() {
    const all = S.data.promises;
    const counts = {
      all: all.length,
      overdue: all.filter((p) => p.status === "overdue").length,
      open: all.filter((p) => p.status === "open").length,
      kept: all.filter((p) => p.status === "kept").length,
    };
    const list = all.filter((p) => S.promiseFilter === "all" || p.status === S.promiseFilter);
    return `
      <div class="page-head">
        <div>
          <h1>Обещания</h1>
          <p>Что сотрудники пообещали клиентам и в какой срок. ПУЛЬС сам сверяет обещание с результатом в переписке и подсвечивает просрочку.</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" data-nav="chats">${icon("chat")}Перейти в чаты</button>
        </div>
      </div>

      <div class="tiles">
        <div class="card tile"><span class="tile-icon bad">${icon("alert")}</span><div><b>${counts.overdue}</b><small>просрочено</small></div></div>
        <div class="card tile"><span class="tile-icon warn">${icon("clock")}</span><div><b>${counts.open}</b><small>в работе</small></div></div>
        <div class="card tile"><span class="tile-icon ok">${icon("check")}</span><div><b>${counts.kept}</b><small>выполнено</small></div></div>
      </div>

      <section class="card">
        <div class="card-head">
          <h3>Все обещания</h3>
          <div class="segmented right">
            ${[["all", "Все"], ["overdue", "Просрочено"], ["open", "В работе"], ["kept", "Выполнено"]].map(([key, label]) =>
              `<button data-promise-filter="${key}" class="${S.promiseFilter === key ? "active" : ""}">${label}</button>`).join("")}
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Статус</th><th>Обещание</th><th>Клиент</th><th>Сотрудник</th><th>Срок</th><th></th></tr></thead>
            <tbody>
              ${list.map((p) => `
                <tr>
                  <td>${chip(statusLabel[p.status], p.status === "overdue" ? "red" : p.status === "kept" ? "green" : "amber")}</td>
                  <td class="main-cell"><b>${esc(p.text)}</b><small>${esc(p.topic)}</small></td>
                  <td>${esc(p.client)}</td>
                  <td>${esc(p.employee)}</td>
                  <td class="num">${dt(p.due_at)}${p.status === "overdue" ? `<div class="text-bad small">+${minutes(p.overdue_min)}</div>` : ""}</td>
                  <td class="actions">${p.status === "overdue" ? `<button class="btn btn-sm btn-danger" data-remind="${p.id}">Напомнить</button>` : `<button class="btn btn-sm btn-soft" data-chat="${p.chat_id}">Открыть чат</button>`}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  // ---------------------------------------------------------------- report
  function pageReport() {
    const r = S.data.report;
    return `
      <div class="page-head">
        <div>
          <h1>Отчёт собственнику</h1>
          <p>Готовый текст на одну страницу: что хорошо, что плохо, где деньги и что делать на следующей неделе.</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" data-action="copy-report">${icon("copy")}Скопировать</button>
          <button class="btn btn-ghost" data-action="download-report">${icon("download")}Скачать .md</button>
          <button class="btn btn-dark" data-action="print-report">${icon("print")}Печать / PDF</button>
        </div>
      </div>

      <div class="report-shell">
        <article class="paper" id="report-paper">
          <div class="paper-head">
            <div class="paper-brand">
              <span class="mark"><svg><use href="#i-pulse"/></svg></span>
              <div><b>ПУЛЬС</b><small>One Click Studio</small></div>
            </div>
            <div class="paper-meta">
              ${esc(r.company)}<br>
              Период: ${esc(r.period)}<br>
              Сформирован: ${dt(r.generated_at)}
            </div>
          </div>
          <h1>${esc(r.title)}</h1>
          <div class="paper-score"><b>${r.score}</b><span>оценка недели<br>из 100</span></div>
          <p class="paper-lead">${esc(r.lead)}</p>

          ${r.sections.map((s) => `
            <section class="paper-section ${s.tone}">
              <h3>${esc(s.title)}</h3>
              ${s.items.map((item) => `
                <div class="paper-item">
                  <span class="bullet">${s.tone === "good" ? "+" : s.tone === "bad" ? "−" : "•"}</span>
                  <span>${esc(item.text)}</span>
                </div>`).join("")}
            </section>`).join("")}

          <div class="paper-conclusion">${esc(r.conclusion)}</div>
          <div class="paper-foot">
            <span>Подготовлено платформой ПУЛЬС · ${esc(S.data.meta.company)}</span>
            <span>Демонстрационные данные · не является налоговой консультацией</span>
          </div>
        </article>
      </div>
    `;
  }

  // ---------------------------------------------------------------- settings
  function pageSettings() {
    const st = S.data.settings;
    const presence = st.presence || {};
    const notif = st.notifications || {};
    const modes = [
      ["observer", "Наблюдатель", "Читает чаты, ничего не пишет клиенту. Только сводка собственнику.", "eye"],
      ["helper", "Помощник", "Подсказывает сотруднику в личном чате: клиент ждёт, обещание просрочено.", "spark"],
      ["controller", "Контролёр", "Эскалирует руководителю и создаёт задачи при нарушении правил.", "bolt"],
    ];
    return `
      <div class="page-head">
        <div>
          <h1>Настройки</h1>
          <p>Подключение портала, режим присутствия бота и правила, по которым ПУЛЬС считает чат проблемным.</p>
        </div>
        <div class="page-actions"><span class="demo-pill">ДЕМО-КОНТУР</span></div>
      </div>

      <div class="settings-grid">
        <div class="stack">
          <section class="card card-pad">
            <div class="row" style="margin-bottom:12px">
              <h3 style="margin:0;font-size:13px">Подключение Битрикс24</h3>
              <span class="conn-status right"><span class="dot live"></span>${st.bitrix.connected ? "подключено" : "нет связи"} ${chip(st.bitrix.mode === "demo" ? "демо" : "live", st.bitrix.mode === "demo" ? "amber" : "green")}</span>
            </div>
            <dl class="kv">
              <dt>Портал</dt><dd>${esc(st.bitrix.domain)}</dd>
              <dt>Бот</dt><dd>${esc(st.bitrix.bot)}</dd>
              <dt>ID бота</dt><dd>${esc(st.bitrix.bot_id)}</dd>
              <dt>Открытые линии</dt><dd>${st.bitrix.lines.map((l) => chip(l, "outline")).join(" ")}</dd>
              <dt>Последнее событие</dt><dd>${dt(st.bitrix.last_event)}</dd>
              <dt>Webhook</dt><dd>${st.bitrix.webhook ? "настроен" : "не настроен (демо)"}</dd>
              <dt>Версия</dt><dd><a class="link-inline" data-nav="version">${esc(S.data.meta.version)} · ${S.data.meta.demo ? "демо" : "production"}</a></dd>
            </dl>
            <div class="row" style="margin-top:14px">
              <button class="btn btn-ghost btn-sm" data-action="check-connection">${icon("refresh")}Проверить связь</button>
              <span class="muted small">В демо события имитируются</span>
            </div>
          </section>

          <section class="card card-pad">
            <h3 style="margin:0 0 4px;font-size:13px">Режим присутствия</h3>
            <p class="muted small" style="margin:0 0 12px">Как бот ведёт себя в чатах с клиентами и сотрудниками.</p>
            <div class="mode-cards">
              ${modes.map(([key, title, desc, ico]) => `
                <div class="mode-card ${S.presence === key ? "active" : ""}" data-mode="${key}">
                  <b>${icon(ico)}${title}</b>
                  <small>${desc}</small>
                </div>`).join("")}
            </div>
            <div class="setting-row" style="margin-top:6px">
              <div class="grow"><b>Молчать в чате с клиентом</b><small>Клиент не видит сообщений бота. Бот только читает и анализирует.</small></div>
              <label class="switch"><input type="checkbox" data-switch="silent_in_client_chat" ${presence.silent_in_client_chat !== false ? "checked" : ""}><span></span></label>
            </div>
            <div class="setting-row">
              <div class="grow"><b>Подсказывать сотруднику</b><small>Личные сообщения: «клиент ждёт 2 часа», «обещание просрочено».</small></div>
              <label class="switch"><input type="checkbox" data-switch="helper_to_employee" ${presence.helper_to_employee !== false ? "checked" : ""}><span></span></label>
            </div>
            <div class="setting-row">
              <div class="grow"><b>Эскалировать собственнику</b><small>Мгновенное уведомление, если клиент говорит об уходе или сорван срок.</small></div>
              <label class="switch"><input type="checkbox" data-switch="escalate_to_owner" ${presence.escalate_to_owner !== false ? "checked" : ""}><span></span></label>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><h3>Правила оценки</h3><span class="muted right">порог срабатывания</span></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Правило</th><th>Внимание</th><th>Критично</th><th>Вес</th><th></th></tr></thead>
                <tbody>
                  ${st.rules.map((r) => `
                    <tr>
                      <td><b>${esc(r.title)}</b></td>
                      <td class="muted">${esc(r.value)}</td>
                      <td class="muted">${esc(r.critical)}</td>
                      <td>${chip(r.weight, r.weight === "критичный" ? "red" : r.weight === "высокий" ? "amber" : "")}</td>
                      <td class="actions"><label class="switch"><input type="checkbox" data-rule="${r.code}" ${r.enabled ? "checked" : ""}><span></span></label></td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div class="stack">
          <section class="card card-pad">
            <h3 style="margin:0 0 10px;font-size:13px">Уведомления</h3>
            <div class="setting-row">
              <div class="grow"><b>Утренняя сводка</b><small>Каждый день в 09:00 — 5 главных событий в личный чат.</small></div>
              <label class="switch"><input type="checkbox" data-switch="daily_digest" ${notif.daily_digest !== false ? "checked" : ""}><span></span></label>
            </div>
            <div class="setting-row">
              <div class="grow"><b>Пятничный отчёт</b><small>Полный отчёт собственнику: люди, деньги, риски, план.</small></div>
              <label class="switch"><input type="checkbox" data-switch="weekly_report" ${notif.weekly_report !== false ? "checked" : ""}><span></span></label>
            </div>
            <div class="setting-row">
              <div class="grow"><b>Мгновенные тревоги</b><small>Риск ухода клиента, просрочка обещания, срок ФНС.</small></div>
              <label class="switch"><input type="checkbox" data-switch="instant_critical" ${notif.instant_critical !== false ? "checked" : ""}><span></span></label>
            </div>
          </section>

          <section class="card card-pad">
            <h3 style="margin:0 0 10px;font-size:13px">Доступ</h3>
            ${st.access.map((a) => `<div class="access-row"><b>${esc(a.role)}</b><span>${esc(a.scope)}</span></div>`).join("")}
            <div class="hint" style="margin-top:12px">${icon("eye")}<span>Сотрудник видит только свои чаты и подсказки. Оценки коллег и суммы договоров доступны только собственнику и руководителю.</span></div>
          </section>

          <section class="card card-pad">
            <h3 style="margin:0 0 4px;font-size:13px">Данные</h3>
            <p class="muted small" style="margin:0 0 12px">Демо-база пересобирается из сценария: 11 чатов, 5 сотрудников. Боевые данные не затрагиваются.</p>
            <button class="btn btn-danger btn-sm" data-action="reset-demo">${icon("refresh")}Сбросить демо-данные</button>
          </section>

          <div class="save-bar">
            <button class="btn btn-dark" data-action="save-settings">${icon("check")}Сохранить настройки</button>
          </div>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------- version
  function pageVersion() {
    const m = S.data.meta;
    const version = m.version || "1.0.0";
    const demoUrl = STATIC ? location.origin : "http://127.0.0.1:8090";
    const pdfUrl = STATIC ? "pulse-owner.pdf" : "/docs/pulse-owner.pdf";
    const release = [
      "Пульс команды: оценка 0–100, динамика и красная зона",
      "Разбор чатов: первый ответ, ожидание, обещания, тон, риски",
      "Карточки сотрудников: сильные стороны и зоны роста",
      "Обещания со сроками, просрочками и напоминаниями",
      "Отчёт собственнику на одну страницу + печать в PDF",
      "Настройки: режим наблюдателя, правила и уведомления",
      "Адаптивная панель для телефона и планшета",
    ];
    const tech = [
      ["Интерфейс", "SPA без сборки: HTML, CSS, JavaScript"],
      ["Сервер", "FastAPI + SQLAlchemy"],
      ["Данные", "SQLite в демо, PostgreSQL в production"],
      ["Битрикс24", "imbot.v2, тип supervisor, открытые линии"],
      ["Деплой", STATIC ? "Netlify: статическая демо-сборка" : "Локальный контур + Docker"],
      ["Документы", "Markdown + PDF для собственника"],
    ];
    const roadmap = [
      "Подключение реального портала Битрикс24 и пилот на одной линии",
      "Авторизация через Битрикс24 и роли доступа",
      "LLM-разметка тона, обещаний и рисков на реальных чатах",
      "Адаптеры Telegram, WhatsApp и чата на сайте",
      "Утренняя сводка и пятничный отчёт в личный чат",
    ];
    return `
      <div class="page-head">
        <div>
          <h1>Версия ${esc(version)}</h1>
          <p>Сборка платформы ПУЛЬС, состав релиза и техническая информация. Ссылка на эту страницу — в названии продукта.</p>
        </div>
        <div class="page-actions">
          <span class="demo-pill">${STATIC ? "ДЕМО-СБОРКА" : "ЛОКАЛЬНЫЙ ЗАПУСК"}</span>
          <button class="btn btn-ghost btn-sm" data-action="check-updates">${icon("refresh")}Проверить обновления</button>
        </div>
      </div>

      <section class="version-hero">
        <div class="version-top">
          <span class="eyebrow">ПУЛЬС · AI-контроль открытых линий</span>
          <span class="pulse-watch"><i class="dot"></i>${STATIC ? "статическая демо-сборка" : "локальный контур"}</span>
        </div>
        <div class="version-main">
          <div class="version-number">${esc(version)}</div>
          <div class="version-meta">
            <div><span>Сборка</span><b>${dt(m.generated_at)}</b></div>
            <div><span>Канал</span><b>${STATIC ? "Netlify" : "Local"}</b></div>
            <div><span>Данные</span><b>демонстрационные</b></div>
            <div><span>Статус</span><b>${m.demo ? "демо" : "production"}</b></div>
          </div>
        </div>
        <p>Публичная демонстрация для потенциальных заказчиков. Показывает полный цикл: чат → факты → оценка → красная зона → действие → отчёт собственнику. Боевой портал Битрикс24 к этой сборке не подключён.</p>
      </section>

      <div class="grid g-3-2 mt">
        <section class="card card-pad">
          <div class="card-head" style="padding:0 0 10px"><h3>Что в этой версии</h3><span class="muted right">релиз ${esc(version)}</span></div>
          <ul class="release-list">
            ${release.map((item) => `<li>${icon("check-circle")}<span>${esc(item)}</span></li>`).join("")}
          </ul>
        </section>
        <section class="card card-pad">
          <div class="card-head" style="padding:0 0 10px"><h3>Под капотом</h3></div>
          <div class="tech-grid">
            ${tech.map(([label, value]) => `<div class="tech-item"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join("")}
          </div>
        </section>
      </div>

      <div class="grid g2 mt">
        <section class="card card-pad">
          <div class="card-head" style="padding:0 0 10px"><h3>Ссылки</h3><span class="muted right">открываются в новой вкладке</span></div>
          <div class="version-links">
            <a class="version-link-row" href="${GITHUB_URL}" target="_blank" rel="noopener">${icon("link")}GitHub репозиторий<b>saoneclick/pulse-openlines</b></a>
            <a class="version-link-row" href="${GITHUB_URL}/blob/main/docs/CHANGELOG.md" target="_blank" rel="noopener">${icon("doc")}История версий<b>CHANGELOG</b></a>
            <a class="version-link-row" href="${pdfUrl}" target="_blank" rel="noopener">${icon("download")}PDF для собственника<b>7 страниц</b></a>
            <a class="version-link-row" href="${demoUrl}" target="_blank" rel="noopener">${icon("pulse")}Демо-стенд<b>${STATIC ? "Netlify" : "localhost"}</b></a>
          </div>
        </section>
        <section class="card card-pad">
          <div class="card-head" style="padding:0 0 10px"><h3>Что дальше</h3><span class="muted right">roadmap</span></div>
          <ul class="release-list">
            ${roadmap.map((item) => `<li>${icon("arrow")}<span>${esc(item)}</span></li>`).join("")}
          </ul>
          <div class="version-note" style="margin-top:12px">${icon("alert")}<span>Версия 1.0.0 — демонстрационная. Данные и клиенты вымышлены. Налоговые сроки приведены как пример и не являются консультацией.</span></div>
        </section>
      </div>

      <div class="row mt" style="justify-content:flex-end">
        <button class="btn btn-ghost" data-nav="report">${icon("doc")}Открыть отчёт</button>
        <a class="btn btn-dark" href="${pdfUrl}" target="_blank" rel="noopener">${icon("download")}Скачать PDF для собственника</a>
      </div>
    `;
  }

  // ---------------------------------------------------------------- render
  const PAGES = {
    pulse: { title: "Пульс", render: pagePulse },
    chats: { title: "Чаты", render: pageChats },
    people: { title: "Люди", render: pagePeople },
    promises: { title: "Обещания", render: pagePromises },
    report: { title: "Отчёт", render: pageReport },
    settings: { title: "Настройки", render: pageSettings },
    version: { title: "Версия", render: pageVersion },
  };

  function render() {
    if (S.loading) {
      $("#view").innerHTML = `<div class="loading"><span class="spinner"></span>Собираем пульс открытых линий…</div>`;
      return;
    }
    if (S.error) {
      $("#view").innerHTML = `<div class="empty"><b>Не удалось загрузить данные</b>${esc(S.error)}<div style="margin-top:14px"><button class="btn btn-dark" data-action="reload">Повторить</button></div></div>`;
      return;
    }
    const page = PAGES[S.page] ? S.page : "pulse";
    $("#page-title").textContent = PAGES[page].title;
    $("#view").innerHTML = PAGES[page].render();
    $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
    const version = S.data?.meta?.version || "1.0.0";
    if ($("#version-link")) $("#version-link").textContent = `v${version}`;
    if ($("#version-chip")) $("#version-chip").textContent = `v${version}`;
    document.title = `${PAGES[page].title} · ПУЛЬС v${version}`;

    const d = S.data;
    if (d) {
      const badge = $("#nav-chats");
      const critical = d.overview.status_split.critical;
      badge.textContent = critical;
      badge.hidden = !critical;
      const overdue = d.promises.filter((p) => p.status === "overdue").length;
      const pb = $("#nav-promises");
      pb.textContent = overdue;
      pb.hidden = !overdue;
      $("#connect-mode").textContent = d.settings.bitrix.mode === "demo" ? "демо" : "live";
      $("#connect-domain").textContent = d.settings.bitrix.domain;
      $("#demo-pill").hidden = !d.meta.demo;
      $("#owner-name").textContent = d.meta.owner;
      $("#owner-role").textContent = d.meta.owner_role;
      $("#owner-initials").textContent = d.meta.owner.split(/\s+/).map((w) => w[0] || "").slice(0, 2).join("").toUpperCase();
    }
  }

  function navigate(page) {
    if (!PAGES[page]) page = "pulse";
    S.page = page;
    if (page === "chats" && !S.chatId && S.data) {
      S.chatId = (S.data.overview.attention[0] || S.data.chats[0])?.id || null;
    }
    if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------------------------------------------------------- actions
  function openNotify(chatId, preset) {
    const c = S.data.chats.find((x) => x.id === chatId);
    if (!c) return;
    const draft = preset || `${c.employee.split(" ")[0]}, добрый день! По клиенту ${c.client} ${c.waiting_min ? `клиент ждёт ответа ${minutes(c.waiting_min)}` : "нужно подтвердить клиенту статус"}. Пожалуйста, ответьте сейчас и подтвердите новый срок. Если нужна помощь — подключусь.`;
    openModal(`
      <h3>Написать сотруднику</h3>
      <p class="modal-sub">Сообщение уйдёт сотруднику: ${esc(c.employee)}. В чат клиента ничего не попадёт.</p>
      <label class="field"><span>Текст сообщения</span><textarea class="textarea" id="notify-text">${esc(draft)}</textarea></label>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal">Отмена</button>
        <button class="btn btn-dark" data-action="send-notify" data-chat-id="${c.id}">${icon("send")}Отправить</button>
      </div>`);
  }

  function openTask(chatId) {
    const c = S.data.chats.find((x) => x.id === chatId);
    if (!c) return;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    openModal(`
      <h3>Поставить задачу</h3>
      <p class="modal-sub">Задача появится у сотрудника ${esc(c.employee)} в Битрикс24 и будет связана с клиентом ${esc(c.client)}.</p>
      <label class="field"><span>Что сделать</span><input class="input" id="task-title" value="Ответить клиенту ${esc(c.client)} и подтвердить срок"></label>
      <div style="height:10px"></div>
      <label class="field"><span>Срок</span><input class="input" type="datetime-local" id="task-due" value="${tomorrow}"></label>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal">Отмена</button>
        <button class="btn btn-dark" data-action="send-task" data-chat-id="${c.id}">${icon("check")}Создать</button>
      </div>`);
  }

  function openRemind(promiseId) {
    const p = S.data.promises.find((x) => x.id === promiseId);
    if (!p) return;
    openNotify(p.chat_id, `${p.employee.split(" ")[0]}, добрый день! По клиенту ${p.client} просрочено обещание: «${p.text}». Пожалуйста, напишите клиенту новую дату и подтвердите статус.`);
  }

  async function sendNotify(chatId) {
    const text = $("#notify-text")?.value?.trim();
    if (!text) return toast("Введите текст", "err");
    if (STATIC) {
      closeModal();
      toast("Демо-режим: сообщение сотруднику сымитировано");
      return;
    }
    try {
      const res = await api(`/chats/${chatId}/notify`, { method: "POST", body: JSON.stringify({ text }) });
      closeModal();
      toast(res.message || "Сообщение отправлено");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  async function sendTask(chatId) {
    const title = $("#task-title")?.value?.trim();
    const due = $("#task-due")?.value || null;
    if (!title) return toast("Введите задачу", "err");
    if (STATIC) {
      closeModal();
      toast("Демо-режим: задача создана бы в Битрикс24");
      return;
    }
    try {
      await api(`/chats/${chatId}/task`, { method: "POST", body: JSON.stringify({ title, due_at: due }) });
      closeModal();
      toast("Задача создана и привязана к чату");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  async function saveSettings() {
    const get = (key) => $(`[data-switch="${key}"]`)?.checked ?? true;
    const rules = {};
    $$("[data-rule]").forEach((input) => { rules[input.dataset.rule] = input.checked; });
    const payload = {
      presence_mode: S.presence,
      silent_in_client_chat: get("silent_in_client_chat"),
      helper_to_employee: get("helper_to_employee"),
      escalate_to_owner: get("escalate_to_owner"),
      daily_digest: get("daily_digest"),
      weekly_report: get("weekly_report"),
      instant_critical: get("instant_critical"),
      rules,
    };
    if (STATIC) {
      toast("Демо-режим: настройки не сохраняются");
      return;
    }
    try {
      await api("/settings", { method: "POST", body: JSON.stringify(payload) });
      toast("Настройки сохранены");
      await loadState();
    } catch (e) {
      toast(e.message, "err");
    }
  }

  async function resetDemo() {
    openModal(`
      <h3>Сбросить демо-данные?</h3>
      <p class="modal-sub">Все изменения в демо-базе будут отменены: чаты, задачи, настройки вернутся к исходному сценарию. Боевые данные не затрагиваются.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal">Отмена</button>
        <button class="btn btn-danger" data-action="confirm-reset">Сбросить</button>
      </div>`);
  }

  async function confirmReset() {
    if (STATIC) {
      S.chatId = null;
      closeModal();
      await loadState();
      toast("Демо-данные пересобраны");
      return;
    }
    try {
      await api("/demo/reset", { method: "POST" });
      S.chatId = null;
      closeModal();
      await loadState();
      toast("Демо-данные пересобраны");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  function copyReport() {
    const text = S.data?.report?.markdown || "";
    navigator.clipboard.writeText(text).then(
      () => toast("Отчёт скопирован в буфер обмена"),
      () => toast("Не удалось скопировать", "err")
    );
  }

  function downloadReport() {
    const text = S.data?.report?.markdown || "";
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pulse-report-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Файл отчёта скачан");
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) { navigate(nav.dataset.nav); return; }

    const period = e.target.closest("[data-period]");
    if (period) {
      S.period = Number(period.dataset.period);
      loadState();
      return;
    }

    const filter = e.target.closest("[data-filter]");
    if (filter) {
      S.filter = filter.dataset.filter;
      $("#chat-items").innerHTML = chatListBlock();
      $$("[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === S.filter));
      return;
    }

    const pf = e.target.closest("[data-promise-filter]");
    if (pf) {
      S.promiseFilter = pf.dataset.promiseFilter;
      render();
      return;
    }

    const mode = e.target.closest("[data-mode]");
    if (mode) {
      S.presence = mode.dataset.mode;
      $$(".mode-card").forEach((c) => c.classList.toggle("active", c.dataset.mode === S.presence));
      return;
    }

    const person = e.target.closest("[data-person]");
    if (person) { openPerson(Number(person.dataset.person)); return; }

    const action = e.target.closest("[data-action]");
    if (action) {
      const name = action.dataset.action;
      if (name === "reload") loadState();
      else if (name === "close-modal") closeModal();
      else if (name === "close-drawer") closeDrawer();
      else if (name === "notify") openNotify(Number(action.dataset.chatId));
      else if (name === "task") openTask(Number(action.dataset.chatId));
      else if (name === "send-notify") sendNotify(Number(action.dataset.chatId));
      else if (name === "send-task") sendTask(Number(action.dataset.chatId));
      else if (name === "save-settings") saveSettings();
      else if (name === "reset-demo") resetDemo();
      else if (name === "confirm-reset") confirmReset();
      else if (name === "copy-report") copyReport();
      else if (name === "download-report") downloadReport();
      else if (name === "print-report") window.print();
      else if (name === "check-connection") toast("Демо-контур: портал отвечает, события имитируются");
      else if (name === "check-updates") toast(`Установлена последняя версия — ${S.data?.meta?.version || "1.0.0"}`);
      else if (name === "demo-link") toast("Демо: ссылка появится после подключения портала");
      else if (name === "clear-employee") { S.employeeFilter = null; render(); }
      return;
    }

    const chat = e.target.closest("[data-chat], [data-chat-id]");
    if (chat) {
      const id = Number(chat.dataset.chat || chat.dataset.chatId);
      if (id) {
        if (chat.dataset.closeDrawer) closeDrawer();
        S.chatId = id;
        S.page = "chats";
        if (location.hash !== "#chats") history.replaceState(null, "", "#chats");
        render();
        if (window.innerWidth <= 900) $(".chat-view")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const remind = e.target.closest("[data-remind]");
    if (remind) { openRemind(Number(remind.dataset.remind)); return; }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "chat-search") {
      S.q = e.target.value;
      const box = $("#chat-items");
      if (box) box.innerHTML = chatListBlock();
    }
  });

  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeDrawer(); }
  });
  window.addEventListener("hashchange", () => {
    const page = location.hash.replace("#", "") || "pulse";
    if (PAGES[page] && page !== S.page) { S.page = page; render(); }
  });

  // ---------------------------------------------------------------- boot
  const initial = location.hash.replace("#", "");
  if (PAGES[initial]) S.page = initial;
  loadState();
})();

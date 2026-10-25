"use strict";

/* ---------- Analytics: CCU, revenue and new-user sources entered by the team ---------- */
// Entries live in projects/{pid}/analytics: { kind: "ccu" | "revenue" | "sources", at (CCU sample time),
// from/to (period start/end day, revenue & sources), value, others, search, friends, note, createdBy, createdAt, updatedAt }.
let analyticsEntries = [];
let analyticsLoaded = false;
const anState = { period: "30d", from: "", to: "", tab: "ccu", sort: "desc", editing: null, error: null };
let revDraft = null; // unsaved choices in the Revenue settings card
const anWidths = {}; // chart -> width it was drawn at (px)

const AN_KINDS = {
  ccu: { label: "CCU", icon: "users", noun: "CCU entry" },
  revenue: { label: "Revenue", icon: "coins", noun: "revenue entry" },
  sources: { label: "Sources", icon: "pie", noun: "sources entry" },
};
// Categorical order is fixed (validated for dark surfaces: CVD ΔE ≥ 10, normal-vision ΔE ≥ 24).
const AN_SOURCES = [
  { key: "others", label: "Others", color: "#8b5cf6" },
  { key: "search", label: "Search", color: "#0d9488" },
  { key: "friends", label: "Friends", color: "#d97706" },
];
const AN_PERIODS = { "7d": ["7 days", 7], "30d": ["30 days", 30], "90d": ["90 days", 90], "12m": ["12 months", 365], all: ["All", 0], custom: ["Custom", 0] };
const CURRENCY_PRESETS = [
  { code: "USD", symbol: "$" }, { code: "EUR", symbol: "€" }, { code: "GBP", symbol: "£" },
  { code: "JPY", symbol: "¥" }, { code: "CAD", symbol: "$" }, { code: "BRL", symbol: "R$" },
];

ACT_TYPES["analytics.add"] = ["chart", "green", "analytics"];
ACT_TYPES["analytics.update"] = ["chart", "blue", "analytics"];
ACT_TYPES["analytics.delete"] = ["chart", "red", "analytics"];
ACT_GROUPS.analytics = ["Analytics", "chart"];
PROJECT_SUBCOLLECTIONS.push("analytics");

onProject(() => {
  analyticsLoaded = false;
  return listen(() => sub("analytics"), (snap) => {
    analyticsEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    analyticsLoaded = true;
    scheduleRender();
  });
});
onProjectReset(() => {
  analyticsEntries = [];
  analyticsLoaded = false;
  revDraft = null;
  Object.assign(anState, { editing: null, error: null });
});

/* ---------- Formatting ---------- */
const anNum = (n, d = 0) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
function anCompact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+n.toFixed(a < 10 && n % 1 ? 1 : 0)}`;
}
function revenueSettings(p = project()) {
  const r = p?.revenue || {};
  if (r.mode === "money") return { mode: "money", currency: String(r.currency || "USD").slice(0, 8), symbol: String(r.symbol ?? "$").slice(0, 6) };
  return { mode: "robux", currency: "", symbol: "R$" };
}
// Plain text (safe to put through esc()): Robux "R$ 12,345", money "€1,234.50" in the viewer's locale.
function revenueFormat(n, p = project()) {
  const r = p && p.mode ? p : revenueSettings(p);
  if (r.mode === "money") return `${r.symbol}${anNum(n, 2)}`;
  return `R$ ${anNum(Math.round(n || 0))}`;
}
// Same with the Robux icon in the app's own UI.
function revenueHtml(n, p = project()) {
  const r = revenueSettings(p);
  if (r.mode === "money") return esc(revenueFormat(n, p));
  return `<span class="an-robux">${icon("robux", 15)}${esc(anNum(Math.round(n || 0)))}</span>`;
}
const revenueAxis = (n) => { const r = revenueSettings(); return r.mode === "money" ? `${r.symbol}${anCompact(n)}` : anCompact(n); };

const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const dayMs = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(`${s}T00:00`).getTime() : NaN);
const anDate = (t, year) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: year || new Date(t).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
const anDateTime = (t) => `${anDate(t)}, ${clockTime(t)}`;
const anPeriodText = (e) => (ymd(e.from) === ymd(e.to) ? anDate(e.from) : `${anDate(e.from)} – ${anDate(e.to)}`);
const srcTotal = (e) => (+e.others || 0) + (+e.search || 0) + (+e.friends || 0);
const entryTime = (e) => (e.kind === "ccu" ? e.at : e.from) || 0;

/* ---------- Period ---------- */
function anRange() {
  const p = anState.period;
  if (p === "all") return { start: -Infinity, end: Infinity, prev: null };
  if (p === "custom") {
    const s = dayMs(anState.from);
    const e = dayMs(anState.to);
    const start = isNaN(s) ? -Infinity : s;
    const end = isNaN(e) ? Infinity : new Date(e).setDate(new Date(e).getDate() + 1) - 1;
    const len = end - start + 1;
    return { start, end, prev: isFinite(len) && len > 0 ? { start: start - len, end: start - 1 } : null };
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(today).setDate(today.getDate() + 1) - 1;
  const start = new Date(today).setDate(today.getDate() - (AN_PERIODS[p][1] - 1));
  const len = end - start + 1;
  return { start, end, prev: { start: start - len, end: start - 1 } };
}
// CCU samples count by their time; revenue and sources count in the period where they start.
const inRange = (e, r) => { const t = entryTime(e); return t >= r.start && t <= r.end; };
const entriesOf = (kind, r) => analyticsEntries.filter((e) => e.kind === kind && (!r || inRange(e, r))).sort((a, b) => entryTime(a) - entryTime(b));

/* ---------- Page ---------- */
registerView("analytics", () => {
  requestAnimationFrame(anCheckWidths);
  const r = anRange();
  return `${header("Analytics", "Analytics", { actions: false })}
    ${anToolbar()}
    ${analyticsLoaded ? `${anCards(r)}
    <div class="an-charts">
      <section class="card an-chart-card an-wide"><div class="card-head"><h2>Concurrent players</h2><span class="muted small">CCU over time</span></div><div class="card-body">${anCcuChart(r)}</div></section>
      <section class="card an-chart-card"><div class="card-head"><h2>Revenue</h2><span class="muted small">${esc(revenueSettings().mode === "money" ? revenueSettings().currency : "Robux")}</span></div><div class="card-body">${anRevenueChart(r)}</div></section>
      <section class="card an-chart-card"><div class="card-head"><h2>Top sources</h2><span class="muted small">New users with plays</span></div><div class="card-body">${anSourcesChart(r)}</div></section>
    </div>
    ${anDataCard()}` : `<div class="card an-loading"><div class="empty">${icon("chart", 26)}<span>Loading analytics…</span></div></div>`}`;
});

function anToolbar() {
  const custom = anState.period === "custom";
  return `<div class="an-toolbar" role="group" aria-label="Period">
    <div class="an-periods">${Object.entries(AN_PERIODS).map(([k, [label]]) => `<button type="button" class="chip ${anState.period === k ? "on" : ""}" data-an-period="${k}" aria-pressed="${anState.period === k}">${k === "custom" ? icon("calendar", 14) : ""}${label}</button>`).join("")}</div>
    ${custom ? `<div class="an-custom"><label class="sr-only" for="an-from">From</label><input class="input" type="date" id="an-from" value="${esc(anState.from)}" aria-label="From">
      <span class="muted">–</span><label class="sr-only" for="an-to">To</label><input class="input" type="date" id="an-to" value="${esc(anState.to)}" aria-label="To"></div>` : ""}
    ${custom && anState.from && anState.to && anState.from > anState.to ? '<span class="an-err small">The start date is after the end date.</span>' : ""}
  </div>`;
}

function anStat(label, value, sub, ic, color, id) {
  return `<div class="an-stat" id="${id}"><div class="an-stat-top"><span class="an-stat-label">${label}</span><span class="an-stat-icon c-${color}">${icon(ic, 16)}</span></div>
    <div class="an-stat-value">${value}</div><div class="an-stat-sub">${sub}</div></div>`;
}
function anCards(r) {
  const allCcu = entriesOf("ccu");
  const ccu = entriesOf("ccu", r);
  const latest = allCcu.at(-1);
  const peak = ccu.reduce((m, e) => (!m || e.value > m.value ? e : m), null);
  const avg = ccu.length ? ccu.reduce((s, e) => s + (+e.value || 0), 0) / ccu.length : 0;
  const rev = entriesOf("revenue", r).reduce((s, e) => s + (+e.value || 0), 0);
  const prevEntries = r.prev ? entriesOf("revenue", r.prev) : [];
  const prev = prevEntries.reduce((s, e) => s + (+e.value || 0), 0);
  let change = '<span class="muted">All recorded revenue</span>';
  if (r.prev) {
    if (!prevEntries.length || prev === 0) change = '<span class="muted">No data for the previous period</span>';
    else {
      const pct = ((rev - prev) / prev) * 100;
      const up = pct >= 0;
      change = `<span class="an-delta ${up ? "up" : "down"}">${icon(up ? "trendUp" : "trendDown", 14)}${up ? "+" : "−"}${anNum(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}%</span><span class="muted"> vs previous period</span>`;
    }
  }
  const src = entriesOf("sources", r);
  const sums = AN_SOURCES.map((s) => ({ ...s, n: src.reduce((t, e) => t + (+e[s.key] || 0), 0) }));
  const total = sums.reduce((t, s) => t + s.n, 0);
  const top = total ? sums.reduce((m, s) => (s.n > m.n ? s : m)) : null;
  return `<div class="an-cards">
    ${anStat("Latest CCU", latest ? anNum(latest.value) : "—", latest ? esc(anDateTime(latest.at)) : "No CCU entries yet", "users", "purple", "an-stat-latest")}
    ${anStat("Peak CCU", peak ? anNum(peak.value) : "—", peak ? esc(anDateTime(peak.at)) : "No entries in this period", "trendUp", "green", "an-stat-peak")}
    ${anStat("Average CCU", ccu.length ? anNum(Math.round(avg)) : "—", ccu.length ? `${ccu.length} ${ccu.length === 1 ? "sample" : "samples"}` : "No entries in this period", "gauge", "blue", "an-stat-avg")}
    ${anStat("Revenue", revenueHtml(rev), change, revenueSettings().mode === "money" ? "coins" : "robux", "orange", "an-stat-revenue")}
    ${anStat("New users", total ? anNum(total) : "—", top ? `Top source: <b>${esc(top.label)}</b> · ${anNum((top.n / total) * 100, 0)}%` : "No sources in this period", "userPlus", "gray", "an-stat-users")}
  </div>`;
}

/* ---------- Charts (inline SVG) ---------- */
function niceMax(v) {
  if (v <= 0) return 1;
  const raw = v * 1.1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}
function anWidth(key, fallback) {
  const el = document.querySelector(`[data-an-plot="${key}"]`);
  const w = el?.clientWidth || fallback();
  anWidths[key] = Math.max(260, Math.round(w));
  return anWidths[key];
}
const viewInner = () => Math.max(300, ($("#view")?.clientWidth || 900) - 90);
const halfWidth = () => (innerWidth > 1100 ? (viewInner() - 20) / 2 : viewInner());
function anCheckWidths() {
  if (route().name !== "analytics") return;
  for (const [k, w] of Object.entries(anWidths)) {
    const el = document.querySelector(`[data-an-plot="${k}"]`);
    if (el && el.clientWidth && Math.abs(Math.max(260, el.clientWidth) - w) > 6) return scheduleRender();
  }
}
let anResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(anResizeTimer);
  anResizeTimer = setTimeout(() => { if (route().name === "analytics") scheduleRender(); }, 120);
});

function anEmpty(kind, inPeriod) {
  const k = AN_KINDS[kind];
  const first = { ccu: "Add your first CCU entry", revenue: "Add your first revenue entry", sources: "Add your first sources entry" }[kind];
  return `<div class="an-empty">${icon(kind === "ccu" ? "chart" : kind === "revenue" ? "barChart" : "pie", 28)}
    <b>${inPeriod ? `No ${k.label === "CCU" ? "CCU" : k.label.toLowerCase()} entries in this period` : first}</b>
    <span class="muted small">${inPeriod ? "Pick a longer period or add an entry." : kind === "ccu" ? "Record how many players were online at a given date and time." : kind === "revenue" ? "Record how much the game earned over a period." : "Record how many new users played, by where they came from."}</span>
    ${can("edit") ? `<button type="button" class="btn small" data-an-add="${kind}">${icon("plus", 15)}Add entry</button>` : ""}</div>`;
}
function yGrid(w, h, pad, max, fmt) {
  const ticks = 4;
  let out = "";
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = pad.t + (h - pad.t - pad.b) * (1 - i / ticks);
    out += `<line class="an-grid${i === 0 ? " base" : ""}" x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}"/><text class="an-axis" x="${pad.l - 8}" y="${y + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  return out;
}

function anCcuChart(r) {
  const pts = entriesOf("ccu", r);
  const w = anWidth("ccu", viewInner);
  if (!pts.length) return `<div class="an-plot" data-an-plot="ccu">${anEmpty("ccu", entriesOf("ccu").length > 0)}</div>`;
  const h = w < 500 ? 220 : 260;
  const pad = { t: 14, r: 18, b: 30, l: 52 };
  const max = niceMax(Math.max(...pts.map((e) => +e.value || 0)));
  const t0 = pts[0].at;
  const t1 = pts.at(-1).at;
  const span = t1 - t0;
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const x = (t) => (span ? pad.l + ((t - t0) / span) * pw : pad.l + pw / 2);
  const y = (v) => pad.t + ph * (1 - (+v || 0) / max);
  const xy = pts.map((e) => [x(e.at), y(e.value)]);
  const line = xy.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("");
  const area = `${line}L${xy.at(-1)[0].toFixed(1)},${pad.t + ph}L${xy[0][0].toFixed(1)},${pad.t + ph}Z`;
  // X ticks: evenly spaced times, labelled by day (and hour for short spans).
  const nTicks = span ? Math.max(2, Math.min(6, Math.floor(pw / 110))) : 1;
  const short = span < 2 * 864e5;
  let xt = "";
  for (let i = 0; i < nTicks; i++) {
    const t = span ? t0 + (span * i) / (nTicks - 1) : t0;
    const label = short ? (span < 864e5 && ymd(t0) === ymd(t1) ? clockTime(t) : `${anDate(t)} ${clockTime(t)}`) : anDate(t);
    const anchor = !span ? "middle" : i === 0 ? "start" : i === nTicks - 1 ? "end" : "middle";
    xt += `<text class="an-axis" x="${x(t)}" y="${h - 8}" text-anchor="${anchor}">${esc(label)}</text>`;
  }
  const hits = xy.map(([px, py], i) => {
    const left = i ? (xy[i - 1][0] + px) / 2 : pad.l;
    const right = i < xy.length - 1 ? (xy[i + 1][0] + px) / 2 : w - pad.r;
    const e = pts[i];
    return `<g class="an-pt" data-tip="${esc(`${anNum(e.value)} players\n${anDateTime(e.at)}`)}">
      <rect class="an-hit" x="${left.toFixed(1)}" y="${pad.t}" width="${Math.max(1, right - left).toFixed(1)}" height="${ph}"/>
      <line class="an-cross" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${pad.t}" y2="${pad.t + ph}"/>
      <circle class="an-dot${pts.length > 60 ? " hover-only" : ""}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4"/></g>`;
  }).join("");
  const peak = pts.reduce((m, e) => (e.value > m.value ? e : m));
  return `<div class="an-plot" data-an-plot="ccu"><svg class="an-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`Concurrent players over time: ${pts.length} samples from ${anDateTime(t0)} to ${anDateTime(t1)}, peak ${anNum(peak.value)} on ${anDateTime(peak.at)}`)}">
    <defs><linearGradient id="an-ccu-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa" stop-opacity="0.32"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></linearGradient></defs>
    ${yGrid(w, h, pad, max, anCompact)}${xt}
    <path class="an-area" d="${area}" fill="url(#an-ccu-fill)"/>
    <path class="an-line" d="${line}"/>
    ${hits}</svg></div>`;
}

function anRevenueChart(r) {
  let list = entriesOf("revenue", r);
  const w = anWidth("revenue", halfWidth);
  if (!list.length) return `<div class="an-plot" data-an-plot="revenue">${anEmpty("revenue", entriesOf("revenue").length > 0)}</div>`;
  // One bar per entry; long histories are grouped by month so bars stay readable.
  let bars = list.map((e) => ({ v: +e.value || 0, label: anDate(e.from), tip: `${revenueFormat(e.value)}\n${anPeriodText(e)}` }));
  if (list.length > 24) {
    const months = new Map();
    for (const e of list) {
      const d = new Date(e.from);
      const k = `${d.getFullYear()}-${d.getMonth()}`;
      const m = months.get(k) || { v: 0, n: 0, t: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
      m.v += +e.value || 0; m.n++;
      months.set(k, m);
    }
    bars = [...months.values()].map((m) => {
      const name = new Date(m.t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
      return { v: m.v, label: name, tip: `${revenueFormat(m.v)}\n${name} · ${m.n} entries` };
    });
  }
  const h = 240;
  const pad = { t: 14, r: 12, b: 30, l: 56 };
  const max = niceMax(Math.max(...bars.map((b) => b.v)));
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const band = pw / bars.length;
  const bw = Math.max(2, Math.min(44, band - 2, band * 0.72));
  const every = Math.max(1, Math.ceil(70 / band));
  const rects = bars.map((b, i) => {
    const bh = Math.max(b.v > 0 ? 2 : 0, (b.v / max) * ph);
    const bx = pad.l + band * i + (band - bw) / 2;
    const by = pad.t + ph - bh;
    const rr = Math.min(4, bw / 2, bh);
    const d = `M${bx},${by + bh}V${by + rr}Q${bx},${by} ${bx + rr},${by}H${bx + bw - rr}Q${bx + bw},${by} ${bx + bw},${by + rr}V${by + bh}Z`;
    const label = i % every === 0 ? `<text class="an-axis" x="${bx + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(b.label)}</text>` : "";
    return `<g class="an-bar" data-tip="${esc(b.tip)}"><rect class="an-hit" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ph}"/><path class="an-bar-fill" d="${d}"/></g>${label}`;
  }).join("");
  const total = bars.reduce((s, b) => s + b.v, 0);
  return `<div class="an-plot" data-an-plot="revenue"><svg class="an-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`Revenue: ${bars.length} bars, total ${revenueFormat(total)}`)}">
    ${yGrid(w, h, pad, max, revenueAxis)}${rects}</svg></div>`;
}

function anSourcesChart(r) {
  const list = entriesOf("sources", r);
  const w = anWidth("sources", halfWidth);
  const sums = AN_SOURCES.map((s) => ({ ...s, n: list.reduce((t, e) => t + (+e[s.key] || 0), 0) }));
  const total = sums.reduce((t, s) => t + s.n, 0);
  if (!list.length || !total) return `<div class="an-plot" data-an-plot="sources">${list.length ? `<div class="an-empty">${icon("pie", 28)}<b>No new users in this period</b><span class="muted small">The entries in this period all have zero users.</span></div>` : anEmpty("sources", entriesOf("sources").length > 0)}</div>`;
  const R = 74;
  const sw = 24;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const shown = sums.filter((s) => s.n > 0);
  const arcs = shown.map((s) => {
    const len = (s.n / total) * C;
    const gap = shown.length > 1 ? Math.min(3, len / 2) : 0;
    const out = `<circle class="an-arc" data-tip="${esc(`${s.label}: ${anNum(s.n)} (${anNum((s.n / total) * 100, 1)}%)\n${list.length} ${list.length === 1 ? "entry" : "entries"} in this period`)}" cx="100" cy="100" r="${R}" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${(len - gap).toFixed(2)} ${(C - len + gap).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 100 100)"/>`;
    acc += len;
    return out;
  }).join("");
  return `<div class="an-plot an-donut-wrap" data-an-plot="sources" style="--w:${w}px">
    <svg class="an-donut" viewBox="0 0 200 200" role="img" aria-label="${esc(`New users by source: ${sums.map((s) => `${s.label} ${anNum(s.n)} (${anNum((s.n / total) * 100, 1)}%)`).join(", ")}`)}">
      <circle cx="100" cy="100" r="${R}" class="an-track" stroke-width="${sw}"/>${arcs}
      <text x="100" y="98" text-anchor="middle" class="an-donut-total">${esc(anCompact(total))}</text>
      <text x="100" y="118" text-anchor="middle" class="an-axis">new users</text></svg>
    <ul class="an-legend">${sums.map((s) => `<li data-tip="${esc(`${s.label}: ${anNum(s.n)} new users`)}"><span class="an-swatch" style="background:${s.color}"></span><span class="an-leg-name">${s.label}</span><span class="an-leg-val">${anNum(s.n)}</span><span class="an-leg-pct">${anNum((s.n / total) * 100, 1)}%</span></li>`).join("")}</ul>
  </div>`;
}

/* ---------- Data table ---------- */
function anFields(kind, prefix, e = {}) {
  const now = Date.now();
  const num = (name, label, val, step = "1") => `<label class="an-f an-f-num">${label}<input class="input" type="number" inputmode="${step === "1" ? "numeric" : "decimal"}" min="0" step="${step}" id="${prefix}-${name}" name="${name}" value="${esc(val ?? "")}" placeholder="0"></label>`;
  const date = (name, label, val) => `<label class="an-f">${label}<input class="input" type="date" id="${prefix}-${name}" name="${name}" value="${esc(val)}"></label>`;
  const note = `<label class="an-f an-f-note">Note<input class="input" id="${prefix}-note" name="note" maxlength="120" value="${esc(e.note || "")}" placeholder="Optional, e.g. weekend event"></label>`;
  if (kind === "ccu") {
    return `${date("date", "Date", e.at ? ymd(e.at) : ymd(now))}
      <label class="an-f">Time<input class="input" type="time" id="${prefix}-time" name="time" value="${esc(e.at ? hm(e.at) : `${String(new Date(now).getHours()).padStart(2, "0")}:00`)}"></label>
      ${num("value", "Players", e.value)}${note}`;
  }
  const period = `${date("from", "From", e.from ? ymd(e.from) : "")}${date("to", "To", e.to ? ymd(e.to) : "")}`;
  if (kind === "revenue") return `${period}${num("value", `Amount ${revenueSettings().mode === "money" ? `(${esc(revenueSettings().symbol)})` : "(R$)"}`, e.value, "0.01")}${note}`;
  return `${period}${num("others", "Others", e.others)}${num("search", "Search", e.search)}${num("friends", "Friends", e.friends)}${note}`;
}
const anErrorHtml = (form) => (anState.error?.form === form ? `<div class="an-err" role="alert" id="an-error-${form}">${icon("alert", 15)}${esc(anState.error.msg)}</div>` : "");

function anDataCard() {
  const kind = anState.tab;
  const k = AN_KINDS[kind];
  const editable = can("edit");
  const list = entriesOf(kind).sort((a, b) => (anState.sort === "asc" ? 1 : -1) * (entryTime(a) - entryTime(b)));
  const cols = kind === "ccu" ? ["Date & time", "Players"] : kind === "revenue" ? ["Period", "Amount"] : ["Period", "Others", "Search", "Friends", "Total"];
  const span = cols.length + 3;
  const row = (e) => {
    if (anState.editing === e.id && editable) {
      return `<tr class="an-edit-row"><td colspan="${span}"><form class="an-form" data-an-form="edit" data-id="${esc(e.id)}" data-drafts novalidate>
        <div class="an-fields">${anFields(kind, "an-edit", e)}</div>${anErrorHtml("edit")}
        <div class="row-gap"><button class="btn primary small">${icon("save", 15)}Save</button><button type="button" class="btn ghost small" data-an-cancel>Cancel</button></div></form></td></tr>`;
    }
    const cells = kind === "ccu" ? [esc(anDateTime(e.at)), `<b>${anNum(e.value)}</b>`]
      : kind === "revenue" ? [esc(anPeriodText(e)), `<b>${revenueHtml(e.value)}</b>`]
        : [esc(anPeriodText(e)), anNum(e.others), anNum(e.search), anNum(e.friends), `<b>${anNum(srcTotal(e))}</b>`];
    return `<tr data-an-row="${esc(e.id)}">${cells.map((c, i) => `<td class="${i ? "num" : "nowrap"}">${c}</td>`).join("")}
      <td class="an-note">${e.note ? esc(e.note) : '<span class="muted">—</span>'}</td>
      <td class="an-by"><span class="an-who">${avatar(e.createdBy, 22)}<span class="ellipsis">${esc(memberName(e.createdBy))}</span></span></td>
      <td class="an-acts">${editable ? `<button type="button" class="icon-btn bare" data-an-edit="${esc(e.id)}" title="Edit" aria-label="Edit entry">${icon("edit", 16)}</button>` : ""}${canDelete(e.createdBy) ? `<button type="button" class="icon-btn bare" data-an-delete="${esc(e.id)}" title="Delete" aria-label="Delete entry">${icon("trash", 16)}</button>` : ""}</td></tr>`;
  };
  return `<section class="card an-data">
    <div class="card-head wrap"><h2>Data</h2>
      <div class="an-tabs" role="tablist">${Object.entries(AN_KINDS).map(([key, v]) => `<button type="button" role="tab" class="chip ${kind === key ? "on" : ""}" aria-selected="${kind === key}" data-an-tab="${key}">${icon(v.icon, 14)}${v.label}<span class="an-count">${analyticsEntries.filter((e) => e.kind === key).length}</span></button>`).join("")}</div></div>
    <div class="card-body">
      ${editable ? `<form class="an-form an-add" data-an-form="add" data-kind="${kind}" data-drafts novalidate>
        <div class="an-fields">${anFields(kind, `an-add-${kind}`)}</div>
        <button class="btn primary">${icon("plus", 16, 2.2)}Add ${k.label === "CCU" ? "CCU" : k.label.toLowerCase()}</button>
      </form>${anErrorHtml("add")}` : `<div class="notice">${icon("eye", 18)}<span>You can read the analytics. Members and admins add and correct entries.</span></div>`}
      ${kind !== "ccu" ? '<p class="muted small an-hint">Entries count in the period filter by their start date.</p>' : ""}
    </div>
    ${list.length ? `<div class="an-table-wrap"><table class="an-table">
      <thead><tr>${cols.map((c, i) => i === 0 ? `<th><button type="button" class="an-sort" data-an-sort aria-label="Sort by date">${c}${icon(anState.sort === "asc" ? "arrowUp" : "arrowDown", 13)}</button></th>` : `<th class="num">${c}</th>`).join("")}<th>Note</th><th>Added by</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${list.map(row).join("")}</tbody></table></div>`
      : `<div class="empty">No ${k.label === "CCU" ? "CCU" : k.label.toLowerCase()} entries yet.${editable ? " Use the form above to add the first one." : ""}</div>`}
  </section>`;
}

/* ---------- Reading and saving entries ---------- */
function anRead(kind, f) {
  const v = (n) => (f.elements[n]?.value || "").trim();
  const number = (n, label, int) => {
    const raw = v(n);
    if (raw === "") throw new Error(`Enter ${label}.`);
    const x = Number(raw);
    if (!isFinite(x)) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} must be a number.`);
    if (x < 0) throw new Error("Numbers can't be negative.");
    if (int && !Number.isInteger(x)) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} must be a whole number.`);
    if (x > 1e12) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} is too large.`);
    return int ? x : Math.round(x * 100) / 100;
  };
  const out = { note: v("note").slice(0, 120) };
  if (kind === "ccu") {
    const d = v("date");
    const t = v("time") || "00:00";
    const at = /^\d{2}:\d{2}$/.test(t) ? new Date(`${d}T${t}`).getTime() : NaN;
    if (isNaN(dayMs(d)) || isNaN(at)) throw new Error("Enter a valid date and time.");
    out.at = at;
    out.value = number("value", "the number of players", true);
    return out;
  }
  const from = dayMs(v("from"));
  const to = dayMs(v("to"));
  if (isNaN(from) || isNaN(to)) throw new Error("Enter a valid start and end date.");
  if (from > to) throw new Error("The start date must be on or before the end date.");
  Object.assign(out, { from, to });
  if (kind === "revenue") out.value = number("value", "an amount", false);
  else {
    for (const s of AN_SOURCES) out[s.key] = number(s.key, `the ${s.label} count`, true);
  }
  return out;
}
function anLabel(e) {
  if (e.kind === "ccu") return `CCU ${anNum(e.value)} · ${anDateTime(e.at)}`;
  if (e.kind === "revenue") return `Revenue ${revenueFormat(e.value)} · ${anPeriodText(e)}`;
  return `Sources ${anNum(srcTotal(e))} new users · ${anPeriodText(e)}`;
}
function anChanges(before, after) {
  const fields = before.kind === "ccu" ? [["When", (e) => anDateTime(e.at)], ["Players", (e) => anNum(e.value)]]
    : before.kind === "revenue" ? [["Period", anPeriodText], ["Amount", (e) => revenueFormat(e.value)]]
      : [["Period", anPeriodText], ...AN_SOURCES.map((s) => [s.label, (e) => anNum(e[s.key])])];
  fields.push(["Note", (e) => e.note || ""]);
  return fields.map(([field, fmt]) => ({ field, from: fmt(before), to: fmt(after) })).filter((c) => c.from !== c.to);
}
function anFail(form, msg) {
  anState.error = { form, msg };
  render();
  toast(msg, true);
}

document.addEventListener("submit", async (e) => {
  const f = e.target;
  const type = f.dataset?.anForm;
  if (!type || !user) return;
  e.preventDefault();
  if (type === "revenue") return saveRevenueSettings(f);
  if (!can("edit")) return toast("Your role in this project can't do that.", true);
  if (type === "add") {
    const kind = f.dataset.kind;
    let data;
    try { data = anRead(kind, f); } catch (err) { return anFail("add", err.message); }
    anState.error = null;
    const now = Date.now();
    const doc = { kind, ...data, createdBy: user.uid, createdAt: now, updatedAt: now };
    const ref = await act(() => sub("analytics").add(doc), `${AN_KINDS[kind].label} entry added`);
    if (ref) {
      clearDrafts(f);
      f.reset();
      log("analytics.add", `added a ${AN_KINDS[kind].noun}`, anLabel(doc), "Analytics", { ref: `analytics:${ref.id}` });
      render();
    }
  }
  if (type === "edit") {
    const before = analyticsEntries.find((x) => x.id === f.dataset.id);
    if (!before) { anState.editing = null; return render(); }
    let data;
    try { data = anRead(before.kind, f); } catch (err) { return anFail("edit", err.message); }
    const after = { ...before, ...data };
    const changes = anChanges(before, after);
    anState.error = null;
    if (!changes.length) { anState.editing = null; clearDrafts(f); toast("Nothing to save."); return render(); }
    if (await act(() => sub("analytics").doc(before.id).update({ ...data, updatedAt: Date.now() }), "Entry updated")) {
      clearDrafts(f);
      anState.editing = null;
      log("analytics.update", `updated a ${AN_KINDS[before.kind].noun}`, anLabel(after), "Analytics", { ref: `analytics:${before.id}`, changes });
      render();
    }
  }
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-an-period],[data-an-tab],[data-an-sort],[data-an-edit],[data-an-delete],[data-an-cancel],[data-an-add]");
  if (!el || !user) return;
  const d = el.dataset;
  if (d.anPeriod) {
    anState.period = d.anPeriod;
    if (d.anPeriod === "custom" && !anState.from) {
      const r = new Date(); r.setDate(r.getDate() - 29);
      anState.from = ymd(r); anState.to = ymd(Date.now());
    }
    return render();
  }
  if (d.anTab) { anState.tab = d.anTab; anState.editing = null; anState.error = null; return render(); }
  if (d.anSort !== undefined) { anState.sort = anState.sort === "asc" ? "desc" : "asc"; return render(); }
  if (d.anAdd) {
    anState.tab = d.anAdd; anState.editing = null; anState.error = null;
    render();
    const first = $(".an-add input");
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
    first?.focus({ preventScroll: true });
    return;
  }
  if (d.anCancel !== undefined) {
    const f = el.closest("form");
    if (f) clearDrafts(f);
    anState.editing = null; anState.error = null;
    return render();
  }
  if (d.anEdit) {
    if (!can("edit")) return toast("Your role in this project can't do that.", true);
    for (const k of Object.keys(drafts)) if (k.startsWith("an-edit-")) delete drafts[k];
    anState.editing = d.anEdit; anState.error = null;
    render();
    $("#an-edit-value, #an-edit-others")?.focus();
    return;
  }
  if (d.anDelete) {
    const entry = analyticsEntries.find((x) => x.id === d.anDelete);
    if (!entry) return;
    if (!canDelete(entry.createdBy)) return toast("Only the person who added this entry or an admin can delete it.", true);
    const ok = await ask({ title: "Delete this entry?", text: `${anLabel(entry)}. This can't be undone.`, ok: "Delete", danger: true });
    if (!ok) return;
    if (await act(() => sub("analytics").doc(entry.id).delete(), "Entry deleted")) {
      if (anState.editing === entry.id) anState.editing = null;
      log("analytics.delete", `deleted a ${AN_KINDS[entry.kind].noun}`, anLabel(entry), "Analytics", { ref: `analytics:${entry.id}` });
    }
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "an-from" || t.id === "an-to") {
    anState[t.id === "an-from" ? "from" : "to"] = t.value;
    return render();
  }
  if (t.closest?.("[data-an-form=revenue]")) {
    const cur = revDraft || revenueDraftFrom(project());
    if (t.name === "mode") revDraft = { ...cur, mode: t.value };
    if (t.name === "preset") {
      const p = CURRENCY_PRESETS.find((x) => x.code === t.value);
      revDraft = p ? { ...cur, preset: p.code, currency: p.code, symbol: p.symbol } : { ...cur, preset: "custom" };
    }
    render();
  }
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "an-rev-code" || t.id === "an-rev-symbol") {
    const cur = revDraft || revenueDraftFrom(project());
    revDraft = { ...cur, preset: "custom", [t.id === "an-rev-code" ? "currency" : "symbol"]: t.value };
    scheduleRender();
  }
});

/* ---------- Tooltips ---------- */
let anTipEl = null;
function anTip(target, ev) {
  if (!anTipEl) {
    anTipEl = document.createElement("div");
    anTipEl.className = "an-tip";
    anTipEl.setAttribute("role", "tooltip");
    document.body.appendChild(anTipEl);
  }
  const [first, ...rest] = target.dataset.tip.split("\n");
  anTipEl.innerHTML = `<b>${esc(first)}</b>${rest.map((l) => `<span>${esc(l)}</span>`).join("")}`;
  anTipEl.hidden = false;
  const r = anTipEl.getBoundingClientRect();
  let x = ev.clientX + 14;
  let y = ev.clientY - r.height - 12;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y < 8) y = ev.clientY + 16;
  anTipEl.style.left = `${Math.max(8, x)}px`;
  anTipEl.style.top = `${y}px`;
}
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("#view [data-tip]");
  if (t) anTip(t, e);
  else if (anTipEl && !anTipEl.hidden) anTipEl.hidden = true;
});
document.addEventListener("scroll", () => { if (anTipEl) anTipEl.hidden = true; }, true);

/* ---------- Revenue settings card (Project settings) ---------- */
function revenueDraftFrom(p) {
  const r = revenueSettings(p);
  const preset = CURRENCY_PRESETS.find((x) => x.code === r.currency && x.symbol === r.symbol);
  return { mode: r.mode, currency: r.currency || "USD", symbol: r.mode === "money" ? r.symbol : "$", preset: r.mode === "money" ? (preset ? preset.code : "custom") : "USD" };
}
function revenueSettingsCard() {
  const p = project();
  if (!p) return "";
  const ro = !can("manage");
  const d = ro ? revenueDraftFrom(p) : revDraft || revenueDraftFrom(p);
  const preview = d.mode === "money" ? { mode: "money", currency: d.currency, symbol: d.symbol } : { mode: "robux" };
  const opt = (mode, ic, label, sub) => `<label class="an-mode-opt"><input type="radio" name="mode" value="${mode}" id="an-rev-${mode}" ${d.mode === mode ? "checked" : ""}>
    <span>${icon(ic, 20)}<b>${label}</b><small>${sub}</small></span></label>`;
  return `<form class="card an-rev-card" data-an-form="revenue" ${ro ? "inert" : ""}>
    <div class="card-head"><h2>Revenue</h2>${ro ? '<span class="muted small">Read-only</span>' : ""}</div>
    <div class="card-body settings">
      <p class="muted small">How amounts are shown in Analytics.</p>
      <div class="an-modes" role="radiogroup" aria-label="Revenue display">${opt("robux", "robux", "Robux", "R$ with thousands separators")}${opt("money", "coins", "Money", "A currency, 2 decimals")}</div>
      ${d.mode === "money" ? `<label>Currency<select id="an-rev-preset" name="preset" aria-label="Currency">
          ${CURRENCY_PRESETS.map((c) => `<option value="${c.code}" ${d.preset === c.code ? "selected" : ""}>${c.code} · ${esc(c.symbol)}</option>`).join("")}
          <option value="custom" ${d.preset === "custom" ? "selected" : ""}>Custom…</option></select></label>
        ${d.preset === "custom" ? `<div class="form-grid"><label>Code<input class="input" id="an-rev-code" name="currency" maxlength="8" value="${esc(d.currency)}" placeholder="e.g. CHF" autocomplete="off"></label>
          <label>Symbol<input class="input" id="an-rev-symbol" name="symbol" maxlength="6" value="${esc(d.symbol)}" placeholder="e.g. Fr" autocomplete="off"></label></div>` : ""}` : ""}
      <div class="an-preview"><span class="muted small">Preview</span><b id="an-rev-preview">${esc(revenueFormat(1234567.5, preview))}</b></div>
      ${ro ? "" : `<div><button class="btn primary">${icon("save", 17)}Save revenue display</button></div>`}
    </div></form>`;
}
async function saveRevenueSettings(f) {
  if (!can("manage")) return toast("Only admins and the owner can change this.", true);
  const d = revDraft || revenueDraftFrom(project());
  let next;
  if (d.mode === "money") {
    const currency = String(d.currency || "").trim().toUpperCase().slice(0, 8);
    const symbol = String(d.symbol || "").trim().slice(0, 6);
    if (!currency || !symbol) return toast("Enter a currency code and a symbol.", true);
    next = { mode: "money", currency, symbol };
  } else next = { mode: "robux", currency: "", symbol: "R$" };
  const before = revenueSettings();
  const label = (r) => (r.mode === "money" ? `${r.currency} (${r.symbol})` : "Robux");
  if (label(before) === label(next) && project().revenue) { revDraft = null; return toast("Nothing to save."); }
  if (await act(() => updateProject({ revenue: next }), "Revenue display saved")) {
    revDraft = null;
    clearDrafts(f);
    log("project.settings", "changed the revenue display", label(next), "Settings", { changes: [{ field: "Revenue", from: label(before), to: label(next) }] });
    render();
  }
}

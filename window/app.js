// Draws the companion window from the state the companion sends (SPEC §24).
// Every bit of text is set as text, never as HTML: chat and names come from
// other PCs. Actions go back as plain objects through rc.send (preload.cjs).
"use strict";

const $ = (id) => document.getElementById(id);

// h("button", { class: "pill", onclick }, "Label", child...)
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const svg = (markup) => { const t = document.createElement("template"); t.innerHTML = markup; return t.content.firstChild; }; // our own fixed icons only

let state = { view: "start", people: [], lines: [], urgent: [], missing: [], members: [] };
let layout = { dir: "up", expanded: false };
let prefs = { closeChoice: "", sound: false, showCursors: true, shareCursor: true };
let tab = "chat";
let filter = "all";
let reviewAnswers = {};
let lastSeenAt = Date.now();
let startTab = "host";
let startName = null; // null: not edited yet, so it follows the saved name
let startCode = "";
let startSettings = false;

const me = () => state.people.find((p) => p.you);
const colorOf = (id) => state.people.find((p) => p.id === id)?.color ?? "#C7C7CC";
const time = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const TC = /(\d\d:\d\d:\d\d[:;]\d\d)/;
const MOON = '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M7.8 6.6A3.6 3.6 0 0 1 3.4 2.2 3.6 3.6 0 1 0 7.8 6.6z" fill="#FFD60A"></path></svg>';

// Chat text with timecodes as buttons that take your playhead there.
function withTimecodes(text) {
  return text.split(TC).map((part, i) => (i % 2 ? h("button", { class: "tc", title: "Take my playhead there", onclick: (e) => { e.stopPropagation(); rc.send({ type: "jump-tc", timecode: part }); } }, part) : part));
}
const eventClass = (l) => (l.tone === "good" ? "event-good" : l.tone === "bad" ? "event-bad" : "event-plain");

// --- the outer shape: bar, strip, review, start ---------------------------------

function expanded() {
  return state.view === "review" || (state.view === "session" && layout.expanded);
}
function setExpanded(on) {
  layout.expanded = on;
  rc.send({ type: "expand", on });
  render();
}

function render() {
  const root = $("root");
  const big = expanded();
  root.classList.toggle("expanded", big);
  root.classList.toggle("collapsed", !big);
  root.classList.toggle("dir-down", layout.dir === "down");
  $("bar").hidden = state.view !== "session" || big;
  $("strip").hidden = state.view !== "session" || !big;
  $("review").hidden = state.view !== "review";
  $("start").hidden = state.view !== "start";
  const urgent = $("urgent");
  if (state.view === "session" && big) $("list").prepend(urgent);
  else if (urgent.parentElement !== root) root.prepend(urgent);
  urgent.hidden = state.view === "start";
  $("expand").querySelector(".chev").setAttribute("d", layout.dir === "down" ? "M3 5l4 4 4-4" : "M3 9l4-4 4 4");
  $("collapse").querySelector(".chev").setAttribute("d", layout.dir === "down" ? "M3 9l4-4 4 4" : "M3 5l4 4 4-4");
  if (state.view === "session" && big) lastSeenAt = Math.max(lastSeenAt, ...barLines().map((l) => l.at));
  renderUrgent();
  if (state.view === "session") { renderBar(); renderStrip(); }
  if (state.view === "review") renderReview();
  if (state.view === "start") renderStart();
}

// --- urgent cards (SPEC §24.2): kept, not rebuilt, so their pulse runs ----------------

let shownIds = "";
function renderUrgent() {
  const box = $("urgent");
  const items = state.urgent || [];
  const shown = expanded() ? items : items.slice(0, 3);
  const prog = state.view === "session" && state.media ? state.media.progress : null;
  const ids = `${items.length}|${shown.map((u) => `${u.id}:${u.text}`).join(",")}|${JSON.stringify(prog)}`;
  if (ids === shownIds) return;
  const before = new Map([...box.querySelectorAll(".card-urgent")].map((el) => [el.dataset.id, el]));
  const fresh = shown.filter((u) => !before.has(u.id));
  if (fresh.length && prefs.sound) beep();
  shownIds = ids;
  box.replaceChildren(
    ...(items.length > shown.length ? [h("div", { class: "more-waiting" }, `+${items.length - shown.length} more waiting · open to see all`)] : []),
    ...shown.map((u) => before.get(u.id) && before.get(u.id).dataset.text === u.text ? before.get(u.id) : card(u, fresh.includes(u))),
    ...(prog ? [progressCard(prog)] : []),
  );
}
// Media on its way (SPEC §25.1): plain glass, since nothing waits on the person.
function progressCard(p) {
  const pct = p.pct >= 0 ? Math.round(p.pct * 100) : -1;
  return h("section", { class: "card-progress", "aria-label": p.title },
    h("div", { class: "head" }, h("strong", {}, p.title), pct >= 0 ? h("span", { class: "small muted" }, p.paused ? "Paused" : `${pct}%`) : null),
    h("p", { class: "small muted" }, p.detail),
    pct >= 0 ? meter(p.title, pct, p.paused) : null,
    h("div", { class: "actions" },
      h("button", { class: "pill", onclick: () => { setExpanded(true); openPanel("media"); } }, "Show"),
      p.sending ? null : h("button", { class: "pill", onclick: () => rc.send({ type: p.paused ? "media-resume-all" : "media-pause-all" }) }, p.paused ? "Resume" : "Pause")));
}
function meter(label, pct, paused) {
  return h("div", { class: "meter", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
    h("div", { class: `fill${paused ? " paused" : ""}`, style: { width: `${pct}%` } }));
}
function card(u, pulse) {
  return h("section", { class: `card-urgent${pulse ? " pulse" : ""}`, "aria-label": `${u.who} ${u.text}`, "data-id": u.id, "data-text": u.text },
    h("div", { class: "head" }, h("span", { class: "dot", "aria-hidden": "true" }), h("p", {}, u.who ? h("strong", { class: "who" }, u.who) : null, u.who ? " " : "", u.text)),
    (u.actions || []).length ? h("div", { class: "actions" }, ...u.actions.map((a, i) => h("button", { class: `pill${i === 0 ? " urgent" : ""}`, onclick: () => rc.send(a.type ? { type: a.type } : { type: "answer", id: u.id, value: a.value }) }, a.label))) : null);
}
// Pulse again every 30 s while something waits (SPEC §24.2).
setInterval(() => {
  for (const c of document.querySelectorAll(".card-urgent")) {
    c.classList.remove("pulse");
    void c.offsetWidth;
    c.classList.add("pulse");
  }
}, 30_000);

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch { /* no audio: fine */ }
}

// --- the bar --------------------------------------------------------------------------

const followed = () => state.people.find((p) => p.id === state.following);
// The bar shows chat and session events, not the change lines (SPEC §24.5).
const barLines = () => state.lines.filter((l) => l.kind !== "change");

function lineItem(l) {
  if (l.kind === "chat") return h("li", {}, h("strong", { style: { color: colorOf(l.author) } }, l.name), " ", ...withTimecodes(l.text));
  return h("li", { class: eventClass(l) }, l.text);
}

function renderBar() {
  const online = state.people.filter((p) => p.online).length;
  $("barTitle").replaceChildren(state.project || "ResolveCollab", " · ", h("span", { style: { color: state.live ? "var(--good)" : "var(--orange-text)" } }, state.live ? "●" : "○"), state.live ? " Live" : " Offline", ` · ${online} ${online === 1 ? "person" : "people"}`);
  const f = followed();
  $("barFollow").hidden = !f;
  if (f) $("barFollow").replaceChildren(h("span", {}, "Following ", h("strong", { class: "who", style: { color: f.color } }, f.name), f.page ? ` · ${f.page}` : ""), h("button", { class: "pill", onclick: () => rc.send({ type: "follow", id: null }) }, "Stop"));
  const lines = barLines().slice(-3);
  $("barLines").replaceChildren(...(lines.length ? lines.map(lineItem) : [h("li", { class: "muted" }, "No messages yet · say hi below")]));
  const myId = me()?.id;
  const unread = barLines().filter((l) => l.at > lastSeenAt && l.author !== myId && l.author !== "").length;
  $("unread").hidden = !unread;
  $("unread").textContent = unread > 99 ? "99+" : String(unread);
  $("expand").setAttribute("aria-label", unread ? `Expand, ${unread} new` : "Expand");
}

// --- the strip ------------------------------------------------------------------------

function renderStrip() {
  $("stripTitle").textContent = state.project || "ResolveCollab";
  $("stripRole").replaceChildren(state.role === "host" ? "Hosting · " : "", h("span", { style: { color: state.live ? "var(--good)" : "var(--orange-text)" } }, state.live ? "●" : "○"), state.live ? " Live" : " Offline");
  $("people").replaceChildren(...state.people.map((p) => {
    const tip = p.you ? "You" : !p.online ? `${p.name} · offline` : `${p.name}${p.page ? ` · ${p.page}` : ""}${p.idle ? " · Idle" : ""} · ${state.following === p.id ? "Click to stop following" : "Click to follow"}`;
    return h("button", {
      class: `person${p.online ? "" : " offline"}`, title: tip, "aria-label": tip, "aria-pressed": state.following === p.id ? "true" : "false",
      style: { borderColor: state.following === p.id ? p.color : "transparent" }, disabled: p.you || !p.online,
      onclick: () => rc.send({ type: "follow", id: state.following === p.id ? null : p.id }),
    }, h("span", { style: { background: p.color }, "aria-hidden": "true" }, (p.name[0] || "?").toUpperCase()), p.idle && p.online ? h("span", { class: "moon" }, svg(MOON)) : null);
  }));
  const f = followed();
  $("stripFollow").hidden = !f;
  if (f) $("stripFollow").replaceChildren(h("span", {}, "Following ", h("strong", { class: "who", style: { color: f.color } }, f.name), f.page ? ` · ${f.page}` : ""), h("button", { class: "pill", onclick: () => rc.send({ type: "follow", id: null }) }, "Stop"));
  $("tabChat").setAttribute("aria-selected", tab === "chat" ? "true" : "false");
  $("tabChanges").setAttribute("aria-selected", tab === "changes" ? "true" : "false");
  const needs = state.media ? state.media.items.filter((i) => i.state === "noproxy" || i.state === "failed").length : 0;
  $("mediaCount").hidden = !(needs || state.missing.length);
  $("mediaCount").textContent = String(needs || state.missing.length);
  renderList();
  if (!$("panel").hidden) renderPanel($("panel").dataset.kind);
}

function renderList() {
  const list = $("list");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const items = tab === "chat" ? chatItems() : changeItems();
  list.replaceChildren(...(expanded() ? [$("urgent")] : []), ...items);
  if (tab === "chat" && nearBottom) list.scrollTop = list.scrollHeight;
}

function chatItems() {
  if (!state.lines.length) return [h("p", { class: "empty" }, "No messages yet · say hi below")];
  return state.lines.map((l) => {
    if (l.kind === "chat") return h("div", { class: "msg" }, h("div", { class: "meta" }, h("strong", { class: "who", style: { color: colorOf(l.author) } }, l.name), h("span", { class: "time" }, time(l.at))), h("p", {}, ...withTimecodes(l.text)));
    if (l.kind === "event") return h("div", { class: `event-line ${eventClass(l)}` }, l.text, " ", h("span", { class: "time" }, `· ${time(l.at)}`));
    return h("button", { class: "change-line", title: l.timeline ? "Take me there" : undefined, disabled: !l.timeline, onclick: () => rc.send({ type: "jump", line: l.id }) },
      h("span", { style: { color: colorOf(l.author) } }, l.name), ` · ${time(l.at)} · ${l.text}`);
  });
}

function changeItems() {
  const people = [{ id: "all", name: "Everyone", color: "#F5F5F7" }, ...state.people];
  const chips = h("div", { class: "filters", "aria-label": "Show changes by" }, ...people.map((p) => h("button", { class: "chip", "aria-pressed": filter === p.id ? "true" : "false", style: { color: p.color }, onclick: () => { filter = p.id; renderList(); } }, p.name)));
  const changes = state.lines.filter((l) => l.kind === "change" && (filter === "all" || l.author === filter)).slice().reverse();
  if (!changes.length) return [chips, h("p", { class: "empty" }, filter === "all" ? "No changes yet in this session" : "No changes by them yet in this session")];
  return [chips, h("div", { class: "group" }, ...changes.map((l) => h("button", { class: "change", disabled: !l.timeline, title: l.timeline ? "Take me there" : undefined, onclick: () => rc.send({ type: "jump", line: l.id }) },
    h("span", { class: "small muted" }, h("strong", { class: "who", style: { color: colorOf(l.author) } }, l.name), ` · ${time(l.at)}`),
    h("span", { class: "what" }, l.text[0].toUpperCase() + l.text.slice(1)),
    ...l.changes.map((c) => h("span", { class: "prop" }, `${c.name} `, h("span", { class: "mono" }, `${c.from} → ${c.to}`))))))];
}

// --- the ⋯ panels: session, media, settings ----------------------------------------

function openPanel(kind) {
  $("menu").hidden = true;
  $("more").setAttribute("aria-expanded", "false");
  $("panel").hidden = false;
  $("panel").dataset.kind = kind;
  renderPanel(kind);
}

function settingsBody(rerender) {
  const choice = (value, label) => h("button", { role: "tab", "aria-selected": prefs.closeChoice === value ? "true" : "false", onclick: () => { prefs.closeChoice = value; rc.send({ type: "prefs", closeChoice: value }); rerender(); } }, label);
  const tick = (key, label) => h("label", { class: "check", style: { justifyContent: "flex-start" } }, h("input", { type: "checkbox", checked: prefs[key], onchange: (e) => { prefs[key] = e.target.checked; rc.send({ type: "prefs", [key]: prefs[key] }); } }), label);
  return [
    h("div", { class: "label" }, "When I press ×"),
    h("div", { class: "segmented", style: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } }, choice("", "Ask"), choice("minimize", "Minimize"), choice("close", "Close")),
    tick("sound", "Play a sound for items that need me"),
    tick("showCursors", "Show others' cursors"),
    tick("shareCursor", "Share my cursor"),
  ];
}

// Copy, showing it worked (SPEC §24.5): "✓ Copied" for 2 s.
let copiedUntil = 0;
function copyButton() {
  const done = Date.now() < copiedUntil;
  return h("button", { class: `pill ${done ? "done" : "primary"}`, "aria-live": "polite", onclick: () => {
    rc.send({ type: "copy", text: state.code });
    rc.send({ type: "note", text: "Invite code copied" });
    copiedUntil = Date.now() + 2000;
    renderPanel("session");
    setTimeout(() => { if (!$("panel").hidden && $("panel").dataset.kind === "session") renderPanel("session"); }, 2050);
  } }, done ? "✓ Copied" : "Copy");
}

function renderPanel(kind) {
  const head = (title) => h("div", { class: "sheet-head" }, h("h2", {}, title), h("button", { class: "pill", onclick: () => { $("panel").hidden = true; } }, "Done"));
  let body = [];
  if (kind === "session") {
    body = [
      state.code ? [h("div", { class: "label" }, "Invite code, for this opening only"), h("div", { class: "group" }, h("div", { class: "row" }, h("span", { class: "mono" }, state.code.match(/.{1,4}/g).join(" ")), copyButton()))] : [],
      h("div", { class: "label" }, "People"),
      state.members.length ? null : h("p", { class: "small muted", style: { margin: "0 4px" } }, "Nobody has joined yet. Send them the invite code."),
      h("div", { class: "group" }, ...state.members.map((m) => h("div", { class: "row" },
        h("span", {}, h("strong", { class: "who" }, m.name), " ", h("span", { class: "small muted" }, m.blocked ? "blocked" : m.online ? "online" : "offline")),
        state.role === "host" ? h("button", { class: `pill${m.blocked ? "" : " danger"}`, onclick: () => rc.send({ type: m.blocked ? "unblock" : "remove", name: m.id }) }, m.blocked ? "Unblock" : "Remove") : null))),
      state.role === "host" ? h("button", { class: "big", style: { color: "var(--bad)", background: "var(--fill)" }, onclick: () => confirmEnd() }, "End this session for good") : null,
    ];
  } else if (kind === "media") {
    body = mediaBody();
  } else {
    body = settingsBody(() => renderPanel("settings"));
  }
  $("panel").replaceChildren(head(kind === "session" ? "Session" : kind === "media" ? "Media" : "Settings"), h("div", { class: "sheet-body" }, ...body.flat()));
}

// The Media panel (SPEC §25.1, the approved mockup): the folder, then each clip by what it needs.
const size = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
function mediaBody() {
  const m = state.media;
  if (!m) return [h("p", { class: "empty" }, "Media shows here once you're in a session.")];
  const locate = (i) => h("button", { class: "pill", onclick: () => rc.send({ type: "pick-file", clip: i.id, name: i.name }) }, "Locate file\u2026");
  const original = (i, cls) => h("button", { class: `pill ${cls}`, onclick: () => rc.send({ type: "media-original", clip: i.id }) }, `Download original \u00b7 ${size(i.size)}`);
  const row = (i) => {
    let status = "Original, here";
    let buttons = [];
    let bar = null;
    let cls = "media-row";
    if (i.state === "noproxy" || i.state === "failed") {
      cls += " needs";
      status = i.state === "noproxy" ? `No proxy possible: this format can't be converted. The original is ${size(i.size)}.` : i.note || "The download didn't work.";
      buttons = [original(i, "urgent"), locate(i)];
    } else if (i.state === "downloading" || i.state === "paused") {
      const pct = Math.round(i.progress * 100);
      const what = i.kind === "proxy" ? "Proxy" : "Original";
      status = i.making ? `${i.from || "Someone"} is making the proxy \u00b7 ${pct}%` : `${i.state === "paused" ? "Paused \u00b7 " : ""}${what}${i.from ? ` from ${i.from}` : ""} \u00b7 ${pct}%`;
      bar = meter(i.name, pct, i.state === "paused");
      buttons = [h("button", { class: "pill", onclick: () => rc.send({ type: i.state === "paused" ? "media-resume" : "media-pause", clip: i.id }) }, i.state === "paused" ? "Resume" : "Pause")];
    } else if (i.state === "queued") {
      status = `${i.kind === "proxy" ? "Proxy" : "Original"} next in line`;
      buttons = [locate(i)];
    } else if (i.state === "proxy") {
      status = "Proxy. Renders use it until the original is here.";
      buttons = [original(i, "primary-soft"), locate(i)];
    } else if (i.state === "waiting") {
      status = i.note || "Waiting for someone who has it";
      buttons = [locate(i)];
    }
    return h("li", { class: cls },
      h("div", { class: "head" }, h("span", { class: "name" }, i.name), h("span", { class: "small muted" }, i.bin)),
      h("p", { class: "small muted" }, status), bar,
      buttons.length ? h("div", { class: "actions" }, ...buttons) : null);
  };
  const groups = [
    ["Needs you", (i) => i.state === "noproxy" || i.state === "failed", "needs"],
    ["Downloading", (i) => ["downloading", "paused", "queued"].includes(i.state), ""],
    ["Proxies", (i) => i.state === "proxy", ""],
    ["Waiting", (i) => i.state === "waiting", ""],
    ["Here", (i) => i.state === "here", ""],
  ].map(([name, test, cls]) => [name, m.items.filter(test), cls]).filter(([, rows]) => rows.length);
  return [
    h("div", { class: "folder-box" },
      h("p", { class: "mono small path" }, m.folder),
      h("div", { class: "head" }, h("span", { class: "small muted" }, `${size(m.used)} used${m.free ? ` \u00b7 ${size(m.free)} free` : ""}`),
        h("button", { class: "pill", onclick: () => rc.send({ type: "open-folder", path: m.folder }) }, "Open folder"))),
    m.originalsBytes ? h("button", { class: "big soft", onclick: () => rc.send({ type: "media-all" }) }, `Download all originals \u00b7 ${size(m.originalsBytes)}`) : null,
    !groups.length && !m.sending.length ? h("p", { class: "empty" }, "Every clip in the session is on this PC.") : null,
    ...groups.map(([name, rows, cls]) => h("section", { class: "media-group", "aria-label": name }, h("h3", { class: `label ${cls}` }, name), h("ul", {}, ...rows.map(row)))),
    m.sending.length ? h("section", { class: "media-group", "aria-label": "Sending to others" }, h("h3", { class: "label" }, "Sending to others"),
      h("ul", {}, ...m.sending.map((x) => h("li", { class: "media-row" },
        h("div", { class: "head" }, h("span", { class: "name" }, x.clip), h("span", { class: "small muted" }, `to ${x.name}`)),
        h("p", { class: "small muted" }, x.making ? `Making a proxy for ${x.name}` : `${x.name} is getting it from you`))))) : null,
  ];
}

// --- dialogs: closing, leaving, ending ----------------------------------------------

function dialog(title, text, buttons, extra) {
  const box = $("dialog");
  const close = () => { box.hidden = true; box.replaceChildren(); };
  box.replaceChildren(h("div", { class: "box", role: "alertdialog", "aria-label": title },
    h("h2", {}, title), text ? h("p", {}, text) : null, extra || null,
    h("div", { class: "two" }, ...buttons.map((b) => h("button", { class: `pill ${b.cls || ""}`, style: { height: "32px", borderRadius: "16px" }, onclick: () => { close(); b.act(); } }, b.label))),
    h("button", { class: "pill", style: { background: "none", color: "var(--blue-text)" }, onclick: close }, "Cancel")));
  box.hidden = false;
}

function askClose() {
  const host = state.role === "host";
  const minimize = () => setExpanded(false);
  const quit = () => rc.send({ type: "close" });
  // The host is always warned: closing ends the session for everyone (SPEC §24.1).
  if (prefs.closeChoice === "minimize") return minimize();
  if (prefs.closeChoice === "close" && !host) return quit();
  let remember = false;
  const tick = h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { remember = e.target.checked; } }), "Remember my choice");
  const keep = (value) => { if (remember) { prefs.closeChoice = value; rc.send({ type: "prefs", closeChoice: value }); } };
  dialog("Minimize or close?", host ? "Closing ends the session for everyone, because you're the host. They can rejoin when you resume it." : "", [
    { label: "Close", cls: "danger", act: () => { keep("close"); quit(); } },
    { label: "Minimize", cls: "primary", act: () => { keep("minimize"); minimize(); } },
  ], prefs.closeChoice === "close" ? null : tick);
}

// Leave, keep the app (SPEC §24.5): the host is asked first.
function askLeave() {
  $("menu").hidden = true;
  if (state.role !== "host") return rc.send({ type: "leave" });
  if (!expanded()) setExpanded(true);
  dialog("Leave and close the session for everyone?", "You're the host, so the others are told and can rejoin when you resume it. You go back to the start screen.", [
    { label: "Stay", cls: "", act: () => {} },
    { label: "Leave", cls: "danger", act: () => rc.send({ type: "leave" }) },
  ]);
}

function confirmEnd() {
  dialog("End this session for good?", "Everyone is told, and it can't be resumed afterwards. The chat history is deleted.", [
    { label: "End it", cls: "danger", act: () => rc.send({ type: "end" }) },
    { label: "Keep it", cls: "primary", act: () => {} },
  ]);
}

// --- slash commands (SPEC §24.5) ------------------------------------------------------

const COMMANDS = [
  { name: "/timestamp", what: "your playhead time" },
  { name: "/follow", what: "follow someone" },
  { name: "/stop", what: "stop following" },
  { name: "/undo", what: "your last change" },
  { name: "/redo", what: "what you undid" },
  { name: "/invite", what: "copy the invite code" },
  { name: "/leave", what: "leave the session" },
];

// The suggestions for what's being typed: commands after "/", names after "/follow ".
function suggestions(value) {
  const follow = /^\/follow\s+(\S*)$/i.exec(value);
  if (follow) {
    const typed = follow[1].toLowerCase();
    return state.people.filter((p) => !p.you && p.online && p.name.toLowerCase().startsWith(typed)).map((p) => ({ name: p.name, what: p.page || "", value: `/follow ${p.name}` }));
  }
  const word = /(^|\s)(\/\w*)$/.exec(value);
  if (!word) return [];
  return COMMANDS.filter((c) => c.name.startsWith(word[2].toLowerCase()) && (c.name === "/timestamp" || word[1] === "")).map((c) => ({ ...c, value: value.slice(0, value.length - word[2].length) + c.name + (c.name === "/follow" ? " " : "") }));
}

function composer(input, box, form) {
  let pick = 0;
  let list = [];
  const show = () => {
    list = suggestions(input.value);
    if (pick >= list.length) pick = 0;
    box.hidden = !list.length;
    box.replaceChildren(...list.map((s, i) => h("button", { type: "button", role: "option", "aria-selected": i === pick ? "true" : "false", onmousedown: (e) => { e.preventDefault(); take(s); } }, h("span", { class: "mono" }, s.name), h("span", { class: "what" }, s.what))));
  };
  const take = (s) => { input.value = s.value; pick = 0; show(); input.focus(); };
  input.addEventListener("input", () => { pick = 0; show(); });
  input.addEventListener("blur", () => { box.hidden = true; });
  input.addEventListener("keydown", (e) => {
    if (box.hidden || !list.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick = (pick + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length; show(); }
    else if (e.key === "Tab" || (e.key === "Enter" && list[pick] && list[pick].value !== input.value)) { e.preventDefault(); take(list[pick]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); box.hidden = true; }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
    input.value = "";
    box.hidden = true;
  });
}

function send(raw) {
  const text = raw.trim();
  if (!text) return;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd.toLowerCase()) {
    case "/follow": return arg ? rc.send({ type: "follow-name", name: arg }) : rc.send({ type: "note", text: "Who? /follow and their name" });
    case "/stop": return state.following ? rc.send({ type: "follow", id: null }) : rc.send({ type: "note", text: "You aren't following anyone" });
    case "/undo": return rc.send({ type: "undo" });
    case "/redo": return rc.send({ type: "redo" });
    case "/invite":
      if (!state.code) return rc.send({ type: "note", text: "Only the host has the invite code" });
      rc.send({ type: "copy", text: state.code });
      return rc.send({ type: "note", text: "Invite code copied" });
    case "/leave": return askLeave();
  }
  if (cmd.startsWith("/") && cmd.toLowerCase() !== "/timestamp") return rc.send({ type: "note", text: `There's no ${cmd} command. Type / to see them` });
  // /timestamp becomes this person's playhead time as it's sent (left as typed without one).
  rc.send({ type: "chat", text: state.myTimecode ? text.replace(/\/timestamp\b/gi, state.myTimecode) : text });
}

// --- review: coming back (SPEC §9.3) --------------------------------------------------

function renderReview() {
  const r = state.review;
  if (!r) return $("review").replaceChildren();
  const items = r.items;
  const answered = items.filter((c) => reviewAnswers[c.key]).length;
  const set = (key, v) => { reviewAnswers[key] = v; renderReview(); };
  const rest = (v) => { for (const c of items) if (!reviewAnswers[c.key]) reviewAnswers[c.key] = v; renderReview(); };
  $("review").replaceChildren(
    h("div", { class: "pad drag" }, h("h1", {}, `Welcome back to ${state.project || "the session"}`), h("p", { style: { color: "var(--text-2)" } }, "While you were away, others changed some of the same things you did. Choose what to keep. Nothing is sent until you've answered all of them.")),
    h("div", { class: "rule" }),
    h("main", { class: "list" }, ...items.map((c) => h("article", { class: `conflict${reviewAnswers[c.key] ? " done" : ""}` },
      h("div", {}, h("div", { class: "small muted" }, c.kind), h("strong", {}, c.what)),
      h("div", { class: "choices" },
        h("button", { class: "choice", "aria-pressed": reviewAnswers[c.key] === "mine" ? "true" : "false", onclick: () => set(c.key, "mine") }, h("span", { class: "k" }, c.mineLabel), h("span", { class: c.mono ? "mono" : "" }, c.mine)),
        h("button", { class: "choice", "aria-pressed": reviewAnswers[c.key] === "theirs" ? "true" : "false", onclick: () => set(c.key, "theirs") }, h("span", { class: "k" }, c.theirsLabel), h("span", { class: c.mono ? "mono" : "" }, c.theirs)))))),
    h("div", { class: "foot" },
      h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("span", { class: "small muted", style: { marginRight: "auto" } }, `${answered} of ${items.length} answered`),
        h("button", { class: "pill", onclick: () => rest("mine") }, "Mine for the rest"), h("button", { class: "pill", onclick: () => rest("theirs") }, "Theirs for the rest")),
      h("button", { class: "big primary", disabled: answered < items.length, onclick: () => { rc.send({ type: "answer", id: r.id, value: reviewAnswers }); reviewAnswers = {}; } }, "Send my answers"),
      h("p", { class: "small muted" }, "The others keep working meanwhile.")),
  );
}

// --- start: a compact card (SPEC §24.5) -------------------------------------------------

function renderStart() {
  const s = state.start || {};
  if (startName === null && state.name) startName = state.name;
  const name = (startName ?? "").trim();
  const clean = startCode.replace(/\s+/g, "").toLowerCase();
  const valid = /^[0-9a-f]{32}$/.test(clean);
  const wrong = clean.length > 32 || /[^0-9a-f]/.test(clean);
  const can = !!s.bridge && name.length >= 1 && name.length <= 40 && !s.joining;
  const go = (mode) => rc.send({ type: "start", mode, code: clean, name });
  const keepFocus = (id) => { const el = $(id); if (el) { const at = el.value.length; el.focus(); el.setSelectionRange(at, at); } };
  const tabBtn = (id, label) => h("button", { role: "tab", "aria-selected": startTab === id ? "true" : "false", onclick: () => { startTab = id; renderStart(); } }, label);
  const gear = h("button", { class: "round", "aria-label": "Settings", "aria-expanded": String(startSettings), onclick: () => { startSettings = !startSettings; renderStart(); } },
    svg('<svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.2"></circle><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"></path></svg>'));
  $("start").replaceChildren(...[
    h("div", { class: "start-head drag" }, h("h1", {}, "ResolveCollab"),
      s.bridge ? h("span", { class: "pill-status ok" }, h("span", { "aria-hidden": "true" }, "●"), s.project ? `Resolve · ${s.project}` : "Resolve") : h("span", { class: "pill-status off" }, "Resolve not connected"),
      h("span", { class: "no-drag" }, gear),
      // Not in a session, × just quits: nobody else is affected.
      h("span", { class: "no-drag" }, h("button", { class: "round", "aria-label": "Close", onclick: () => rc.send({ type: "close" }) },
        svg('<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"></path></svg>')))),
    s.hint ? h("p", { class: "small", style: { margin: "-6px 0 0", color: "var(--text-2)" } }, s.hint) : null,
    startSettings ? h("div", { class: "settings-box" }, ...settingsBody(renderStart)) : null,
    s.message ? h("p", { class: "start-message", style: { margin: 0 } }, s.message) : null,
    h("div", { class: "field-block" }, h("label", { for: "name", class: "label", style: { margin: 0 } }, "Your name"),
      h("input", { id: "name", class: "field", maxlength: "40", value: startName ?? "", oninput: (e) => { startName = e.target.value; renderStart(); keepFocus("name"); } })),
    h("div", { class: "segmented", role: "tablist", "aria-label": "Host or join" }, tabBtn("host", "Host"), tabBtn("join", "Join")),
    startTab === "host"
      ? h("div", { class: "field-block" },
        s.canResume
          ? [h("button", { class: "primary-row", disabled: !can, onclick: () => go("resume") }, h("span", { style: { fontWeight: 600 } }, `Resume ${s.project}`), h("span", { class: "sub" }, "Everyone from last time gets back in")),
            h("button", { class: "link-btn", disabled: !can, onclick: () => go("host") }, "Start a new session instead")]
          : h("button", { class: "primary-row", disabled: !can, onclick: () => go("host") }, h("span", { style: { fontWeight: 600 } }, `Start a session from ${s.project || "the open project"}`)))
      : h("div", { class: "field-block" },
        h("label", { for: "code", class: "sr" }, "Invite code"),
        h("input", { id: "code", class: `field mono${wrong ? " bad" : ""}`, value: startCode, placeholder: "Paste the invite code", spellcheck: "false", oninput: (e) => { startCode = e.target.value; renderStart(); keepFocus("code"); } }),
        wrong ? h("span", { class: "small", style: { color: "var(--bad)" } }, "That isn't an invite code: it's 32 letters a–f and digits.") : null,
        h("button", { class: "big primary", disabled: !can || !valid, onclick: () => go("join") }, s.joining ? "Waiting for the host to let you in…" : "Join"),
        h("p", { class: "small muted", style: { margin: 0 } }, "Joining makes a new project for the session; yours stays as it is.")),
  ].filter(Boolean)); // replaceChildren would print a null as "null"
}

// --- wiring -------------------------------------------------------------------------

composer($("barInput"), $("barHints"), $("barForm"));
composer($("stripInput"), $("stripHints"), $("stripForm"));
$("expand").addEventListener("click", () => setExpanded(true));
$("collapse").addEventListener("click", () => setExpanded(false));
$("close").addEventListener("click", askClose);
$("leave").addEventListener("click", askLeave);
$("more").addEventListener("click", () => { const open = $("menu").hidden; $("menu").hidden = !open; $("more").setAttribute("aria-expanded", String(open)); });
for (const b of document.querySelectorAll("#menu [data-panel]")) b.addEventListener("click", () => openPanel(b.dataset.panel));
$("tabChat").addEventListener("click", () => { tab = "chat"; renderStrip(); });
$("tabChanges").addEventListener("click", () => { tab = "changes"; renderStrip(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("dialog").hidden) { $("dialog").hidden = true; return; }
  if (!$("panel").hidden) { $("panel").hidden = true; return; }
  if (!$("menu").hidden) { $("menu").hidden = true; return; }
  if (state.view === "session" && layout.expanded) setExpanded(false);
});

// The window's height follows what it shows when it isn't the tall strip.
new ResizeObserver(() => { if (!expanded()) rc.send({ type: "size", height: $("root").getBoundingClientRect().height }); }).observe($("root"));

let lastView = "";
rc.on("state", (s) => {
  state = { people: [], lines: [], urgent: [], missing: [], members: [], ...s };
  // The start card is compact, the review is tall; a session keeps what the person chose.
  if (state.view !== lastView) {
    if (state.view === "start") { layout.expanded = false; rc.send({ type: "expand", on: false }); startName = null; }
    if (state.view === "review") rc.send({ type: "expand", on: true });
    if (state.view === "session" && lastView === "review") rc.send({ type: "expand", on: layout.expanded });
    lastView = state.view;
  }
  render();
});
rc.on("layout", (l) => { layout = { ...layout, ...l }; render(); });
rc.on("prefs", (p) => { prefs = { ...prefs, ...p }; });
render();

// Draws the companion window from the state the companion sends (SPEC §24).
// Every bit of text is set as text, never as HTML: chat and names come from
// other PCs. Actions go back as plain objects through window.rc.send.
"use strict";

const $ = (id) => document.getElementById(id);
// `rc` (on, send) is put on the page by preload.cjs.

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

let state = { view: "start", people: [], lines: [], urgent: [], missing: [], members: [] };
let layout = { dir: "up", expanded: false };
let prefs = { closeChoice: "", sound: false };
let tab = "chat";
let filter = "all";
let reviewAnswers = {};
let seenUrgent = new Set();

const colorOf = (id) => state.people.find((p) => p.id === id)?.color ?? "#C7C7CC";
const time = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const TC = /(\d\d:\d\d:\d\d[:;]\d\d)/;

// Chat text with timecodes as buttons that take your playhead there.
function withTimecodes(text) {
  return text.split(TC).map((part, i) => (i % 2 ? h("button", { class: "tc", title: "Take my playhead there", onclick: () => rc.send({ type: "jump-tc", timecode: part }) }, part) : part));
}

// --- the outer shape: bar, strip, review, start ---------------------------------

function expanded() {
  return state.view !== "session" || layout.expanded;
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
  // Urgent cards sit above the bar, or at the top of the strip's list.
  const urgent = $("urgent");
  if (state.view === "session" && big) $("list").prepend(urgent);
  else if (urgent.parentElement !== root) root.prepend(urgent);
  urgent.hidden = state.view === "start";
  // The chevrons point the way the window will go.
  $("expand").querySelector(".chev").setAttribute("d", layout.dir === "down" ? "M3 5l4 4 4-4" : "M3 9l4-4 4 4");
  $("collapse").querySelector(".chev").setAttribute("d", layout.dir === "down" ? "M3 9l4-4 4 4" : "M3 5l4 4 4-4");
  renderUrgent();
  if (state.view === "session") { renderBar(); renderStrip(); }
  if (state.view === "review") renderReview();
  if (state.view === "start") renderStart();
}

// --- urgent cards (SPEC §24.2) ----------------------------------------------------

function renderUrgent() {
  const box = $("urgent");
  const items = state.urgent || [];
  const fresh = items.filter((u) => !seenUrgent.has(u.id));
  seenUrgent = new Set(items.map((u) => u.id));
  if (fresh.length && prefs.sound) beep();
  const shown = expanded() ? items : items.slice(0, 3);
  box.replaceChildren(
    ...(items.length > shown.length ? [h("div", { class: "more-waiting" }, `+${items.length - shown.length} more waiting · open to see all`)] : []),
    ...shown.map((u) => h("section", { class: `card-urgent${fresh.includes(u) ? " pulse" : ""}`, "aria-label": `${u.who} ${u.text}`, "data-id": u.id },
      h("div", { class: "head" }, h("span", { class: "dot", "aria-hidden": "true" }), h("p", {}, h("strong", { class: "who", style: { color: u.color || "#F5F5F7" } }, u.who), " ", u.text)),
      h("div", { class: "actions" }, ...(u.actions || []).map((a, i) => h("button", { class: `pill${i === 0 ? " urgent" : ""}`, onclick: () => rc.send({ type: "answer", id: u.id, value: a.value }) }, a.label))),
    )),
  );
}

// Pulse again every 30 s while something waits (SPEC §24.2).
setInterval(() => {
  for (const card of document.querySelectorAll(".card-urgent")) {
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
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

function followed() {
  return state.people.find((p) => p.id === state.following);
}

function renderBar() {
  const online = state.people.filter((p) => p.online).length;
  $("barTitle").replaceChildren(state.project || "ResolveCollab", " · ", h("span", { style: { color: state.live ? "var(--green)" : "var(--orange-text)" } }, state.live ? "●" : "○"), state.live ? " Live" : " Offline", ` · ${online} ${online === 1 ? "person" : "people"}`);
  const f = followed();
  $("barFollow").hidden = !f;
  if (f) $("barFollow").replaceChildren(h("span", {}, "Following ", h("strong", { class: "who", style: { color: f.color } }, f.name)), h("button", { class: "pill", onclick: () => rc.send({ type: "follow", id: null }) }, "Stop"));
  const chats = state.lines.filter((l) => l.kind === "chat").slice(-3);
  $("barLines").replaceChildren(...(chats.length
    ? chats.map((l) => h("li", {}, h("strong", { style: { color: colorOf(l.author) } }, l.name), " ", l.text))
    : [h("li", { class: "muted" }, "No messages yet · say hi below")]));
}

// --- the strip ------------------------------------------------------------------------

function renderStrip() {
  $("stripTitle").textContent = state.project || "ResolveCollab";
  $("stripRole").replaceChildren(state.role === "host" ? "Hosting · " : "", h("span", { style: { color: state.live ? "var(--green)" : "var(--orange-text)" } }, state.live ? "●" : "○"), state.live ? " Live" : " Offline");
  $("people").replaceChildren(...state.people.map((p) => {
    const tip = p.you ? `You${p.where ? ` · ${p.where}` : ""}` : `${p.name}${p.online ? (p.where ? ` · ${p.where}` : "") : " · offline"}${p.online ? (state.following === p.id ? " · click to stop following" : " · click to follow") : ""}`;
    return h("button", {
      class: `person${p.online ? "" : " offline"}`, title: tip, "aria-label": tip, "aria-pressed": state.following === p.id ? "true" : "false",
      style: { borderColor: state.following === p.id ? p.color : "transparent" }, disabled: p.you || !p.online,
      onclick: () => rc.send({ type: "follow", id: state.following === p.id ? null : p.id }),
    }, h("span", { style: { background: p.color }, "aria-hidden": "true" }, (p.name[0] || "?").toUpperCase()));
  }));
  const f = followed();
  $("stripFollow").hidden = !f;
  if (f) $("stripFollow").replaceChildren(h("span", {}, "Following ", h("strong", { class: "who", style: { color: f.color } }, f.name), f.where ? ` · ${f.where}` : ""), h("button", { class: "pill", onclick: () => rc.send({ type: "follow", id: null }) }, "Stop"));
  $("tabChat").setAttribute("aria-selected", tab === "chat" ? "true" : "false");
  $("tabChanges").setAttribute("aria-selected", tab === "changes" ? "true" : "false");
  $("stripForm").hidden = tab !== "chat";
  $("status").textContent = state.status || "";
  $("mediaCount").hidden = !state.missing.length;
  $("mediaCount").textContent = String(state.missing.length);
  renderList();
  if (!$("panel").hidden) renderPanel($("panel").dataset.kind);
}

function renderList() {
  const list = $("list");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const urgent = $("urgent");
  const items = tab === "chat" ? chatItems() : changeItems();
  list.replaceChildren(urgent, ...items);
  if (tab === "chat" && nearBottom) list.scrollTop = list.scrollHeight;
}

function chatItems() {
  if (!state.lines.length) return [h("p", { class: "empty" }, "No messages yet · say hi below")];
  return state.lines.map((l) => (l.kind === "chat"
    ? h("div", { class: "msg" }, h("div", { class: "meta" }, h("strong", { class: "who", style: { color: colorOf(l.author) } }, l.name), h("span", { class: "time" }, time(l.at))), h("p", {}, ...withTimecodes(l.text)))
    : h("button", { class: "change-line", title: l.timeline ? "Take me there" : undefined, disabled: !l.timeline, onclick: () => rc.send({ type: "jump", line: l.id }) },
      h("span", { style: { color: colorOf(l.author) } }, l.name), ` · ${time(l.at)} · ${l.text}`)));
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

function renderPanel(kind) {
  const head = (title) => h("div", { class: "sheet-head" }, h("h2", {}, title), h("button", { class: "pill", onclick: () => { $("panel").hidden = true; } }, "Done"));
  let body = [];
  if (kind === "session") {
    body = [
      state.code ? [h("div", { class: "label" }, "Invite code, for this opening only"), h("div", { class: "group" }, h("div", { class: "row" }, h("span", { class: "mono" }, state.code.match(/.{1,4}/g).join(" ")), h("button", { class: "pill primary", onclick: () => rc.send({ type: "copy", text: state.code }) }, "Copy")))] : [],
      h("div", { class: "label" }, "People"),
      state.members.length ? null : h("p", { class: "small muted", style: { margin: "0 4px" } }, "Nobody has joined yet. Send them the invite code."),
      h("div", { class: "group" }, ...state.members.map((m) => h("div", { class: "row" },
        h("span", {}, h("strong", { class: "who" }, m.name), " ", h("span", { class: "small muted" }, m.blocked ? "blocked" : m.online ? "online" : "offline")),
        state.role === "host" ? h("button", { class: `pill${m.blocked ? "" : " danger"}`, onclick: () => rc.send({ type: m.blocked ? "unblock" : "remove", name: m.id }) }, m.blocked ? "Unblock" : "Remove") : null))),
      state.role === "host" ? h("button", { class: "big", style: { color: "var(--red-text)", background: "var(--fill)" }, onclick: () => confirmEnd() }, "End this session for good") : null,
    ];
  } else if (kind === "media") {
    body = state.missing.length
      ? [h("p", { class: "small muted" }, `${state.missing.length} clip${state.missing.length === 1 ? "" : "s"} used in the session ${state.missing.length === 1 ? "isn't" : "aren't"} on this PC.`),
        h("div", { class: "group" }, ...state.missing.map((m) => h("div", { class: "row" }, h("span", {}, m.name), h("button", { class: "pill primary", onclick: () => rc.send({ type: "pick-file", clip: m.id, name: m.name }) }, "Locate…"))))]
      : [h("p", { class: "empty" }, "Every clip in the session is on this PC.")];
  } else {
    const choice = (value, label) => h("button", { role: "tab", "aria-selected": prefs.closeChoice === value ? "true" : "false", onclick: () => { prefs.closeChoice = value; rc.send({ type: "prefs", closeChoice: value }); renderPanel("settings"); } }, label);
    body = [
      h("div", { class: "label" }, "When I press ×"),
      h("div", { class: "segmented", style: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } }, choice("", "Ask"), choice("minimize", "Minimize"), choice("close", "Close")),
      h("label", { class: "check", style: { justifyContent: "flex-start" } }, h("input", { type: "checkbox", checked: prefs.sound, onchange: (e) => { prefs.sound = e.target.checked; rc.send({ type: "prefs", sound: prefs.sound }); } }), "Play a sound for items that need me"),
      h("p", { class: "small muted" }, `You are ${state.name || "?"}. To change your name, start the companion with --name.`),
    ];
  }
  $("panel").replaceChildren(head(kind === "session" ? "Session" : kind === "media" ? "Media" : "Settings"), h("div", { class: "sheet-body" }, ...body.flat()));
}

// --- dialogs: closing, ending ------------------------------------------------------

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

function confirmEnd() {
  dialog("End this session for good?", "Everyone is told, and it can't be resumed afterwards. The chat history is deleted.", [
    { label: "End it", cls: "danger", act: () => rc.send({ type: "end" }) },
    { label: "Keep it", cls: "primary", act: () => {} },
  ]);
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
    h("div", { class: "pad drag" }, h("h1", {}, `Welcome back to ${state.project || "the session"}`), h("p", { style: { color: "var(--text-2)" } }, "While you were away, others changed some of the same things you did. Choose what to keep. Nothing is sent until you've answered all of them."), r.backup ? h("p", { class: "small muted" }, "Backup saved first: ", h("span", { class: "mono" }, r.backup)) : null),
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

// --- start: not in a session ----------------------------------------------------------

let startCode = "";
let startName = "";
function renderStart() {
  const s = state.start || {};
  const clean = startCode.replace(/\s+/g, "").toLowerCase();
  const valid = /^[0-9a-f]{32}$/.test(clean);
  const wrong = clean.length > 32 || /[^0-9a-f]/.test(clean);
  const needName = !state.name;
  const nameOk = !needName || (startName.trim().length >= 1 && startName.trim().length <= 40);
  const go = (mode) => rc.send({ type: "start", mode, code: clean, ...(needName ? { name: startName.trim() } : {}) });
  const input = h("input", { id: "code", class: `field mono${wrong ? " bad" : ""}`, value: startCode, placeholder: "32 letters and digits", spellcheck: "false", oninput: (e) => { startCode = e.target.value; renderStart(); $("code").focus(); $("code").setSelectionRange(startCode.length, startCode.length); } });
  $("start").replaceChildren(
    h("div", { class: "pad drag", style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } }, h("h1", {}, "ResolveCollab"), state.name ? h("span", { class: "small muted" }, "You are ", h("strong", { style: { color: "var(--blue-text)" } }, state.name)) : null),
    h("div", { class: "rule" }),
    h("main", { class: "list", style: { gap: "18px" } },
      needName ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, h("label", { for: "name", class: "label" }, "Your name, shown to the others"),
        h("input", { id: "name", class: "field", maxlength: "40", value: startName, oninput: (e) => { startName = e.target.value; } })) : null,
      s.bridge
        ? h("div", { style: { display: "flex", alignItems: "center", gap: "8px", color: "var(--text-2)" } }, h("span", { style: { color: "var(--green)" } }, "●"), "Resolve is connected. Open project: ", h("strong", { style: { color: "var(--text)" } }, s.project || "none"))
        : h("div", { class: "card-urgent" }, h("strong", { style: { color: "var(--orange-text)" } }, "Resolve isn't connected yet"), h("span", {}, "In Resolve, choose Workspace › Scripts › ResolveCollab. This notices by itself.")),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } }, h("div", { class: "label" }, "Host"),
        h("div", { class: "group" },
          s.canResume ? h("button", { class: "change", disabled: !s.bridge || !nameOk, onclick: () => go("resume") }, h("span", { class: "what", style: { color: "var(--blue-text)" } }, `Resume the session for ${s.project}`), h("span", { class: "small muted" }, "People who joined before get back in without asking. A new invite code is made.")) : null,
          h("button", { class: "change", disabled: !s.bridge || !nameOk, onclick: () => go("host") }, h("span", { class: "what" }, `Start a new session from ${s.project || "the open project"}`)))),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } }, h("label", { for: "code", class: "label" }, "Join with an invite code from the host"), input,
        wrong ? h("span", { class: "small", style: { color: "var(--red-text)" } }, "An invite code is 32 letters a–f and digits.") : null,
        h("button", { class: "big primary", disabled: !valid || !s.bridge || !nameOk, onclick: () => go("join") }, s.joining ? "Waiting for the host to let you in…" : "Join"),
        h("p", { class: "small muted" }, "The first time you join a session, a new project is made for it. The project open now is left as it is."))),
    h("footer", { class: "status" }, s.message || "Not in a session"),
  );
}

// --- wiring -------------------------------------------------------------------------

function sendChat(input) {
  const text = input.value.trim();
  if (!text) return;
  rc.send({ type: "chat", text });
  input.value = "";
}
$("barForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat($("barInput")); });
$("stripForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat($("stripInput")); });
$("expand").addEventListener("click", () => setExpanded(true));
$("collapse").addEventListener("click", () => setExpanded(false));
$("close").addEventListener("click", askClose);
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

// The bar's height follows what it shows; the window resizes to it.
new ResizeObserver(() => { if (!expanded()) rc.send({ type: "size", height: $("root").getBoundingClientRect().height }); }).observe($("root"));

rc.on("state", (s) => {
  state = { people: [], lines: [], urgent: [], missing: [], members: [], ...s };
  if (state.view !== "session" && layout.expanded === false) rc.send({ type: "expand", on: true });
  render();
});
rc.on("layout", (l) => { layout = { ...layout, ...l }; render(); });
rc.on("prefs", (p) => { prefs = { ...prefs, ...p }; });
render();

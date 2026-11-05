// Draws the others' cursors at their spot in Resolve's window (SPEC §24.6).
// Names are set as text; the only markup is our own fixed arrow.
"use strict";

const box = document.getElementById("cursors");
const ghosts = new Map(); // id → element

function ghost(c) {
  const el = document.createElement("div");
  el.className = "ghost";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 18 22");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M2 2 L2 18 L6.5 13.8 L9.6 20.5 L12.6 19.1 L9.6 12.6 L15.5 12.4 Z");
  path.setAttribute("stroke", "#1D1D1F");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  const tag = document.createElement("span");
  tag.className = "tag";
  el.append(svg, tag);
  box.append(el);
  return el;
}

rc.on("cursors", (list) => {
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    seen.add(c.id);
    const el = ghosts.get(c.id) ?? ghosts.set(c.id, ghost(c)).get(c.id);
    el.style.left = `${c.x * 100}%`;
    el.style.top = `${c.y * 100}%`;
    el.querySelector("path").setAttribute("fill", c.color);
    const tag = el.querySelector(".tag");
    tag.textContent = c.name;
    tag.style.background = c.color;
    tag.hidden = !c.near; // the name shows when your pointer comes near
  }
  for (const [id, el] of ghosts) if (!seen.has(id)) { el.remove(); ghosts.delete(id); }
});

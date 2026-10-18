// The resting island's editor (the Resting Island page of the settings window): the island's three sections drawn as places
// to drop a widget in, and the tray of widgets under them. One stage edits one island at a time: the user's own, or one that
// a plugin offers (see rest.rs); the list at its left says which, and holds each island's switch and its rank. Drag a widget from the tray into a section (one already there
// swaps with the one in hand, or leaves), drag one out to take it out, or press a tile to put it in the first free section.
// What the island shows comes of rest.js; this only keeps the choice (`rest_set_mine`, `rest_set_island`).

import { el, invoke, li } from "./kit.js";
import { picture } from "./sample.js";
import { makeTray, openGroup } from "./tray.js";

const SECTIONS = [
	["left", "Left"],
	["center", "Center"],
	["right", "Right"],
];
const DEFAULT = { left: "", center: "eyes:head", right: "" };
const EMPTY = { left: "", center: "", right: "" };

let root = null; // the editor's own box (#rest-edit)
let view = { mine: {}, edited: false, islands: [] };
let widgets = []; // [{ id: "plugin:widget", name, plugin }]
let target = "mine"; // "mine", or the key of an island of a plugin
let tray = null;
let drag = null;
let justDragged = false;
let reloadAfter = false;

/** the widgets that are on offer: the ones of the plugins that are on */
async function loadWidgets() {
	let listing = { plugins: [] };
	try {
		listing = (await invoke("plugin_list")) || listing;
	} catch (_) {}
	const out = [];
	for (const p of listing.plugins) {
		if (!p.enabled || p.error) continue;
		for (const w of p.widgets || []) out.push({ id: `${p.id}:${w.id}`, name: w.name || w.id, plugin: p.id });
		for (const f of p.faces || []) if (f.slot === "widget") out.push({ id: `${p.id}:${f.id}`, name: f.name || f.id, plugin: p.id });
	}
	return { out, names: new Map(listing.plugins.map((p) => [p.id, p.name])) };
}
let pluginNames = new Map();

const widgetOf = (id) => widgets.find((w) => w.id === id);
const island = () => view.islands.find((i) => i.key === target);

/** the island as it comes, with nothing chosen: the eyes in the center (for whoever has them) */
const defaultLayout = () => ({ ...DEFAULT, center: widgetOf(DEFAULT.center) ? DEFAULT.center : "" });

/** the three sections of what is edited now */
function current() {
	if (target === "mine") {
		if (view.edited) return { left: view.mine.left || "", center: view.mine.center || "", right: view.mine.right || "" };
		return defaultLayout();
	}
	const i = island();
	if (!i) return { ...EMPTY };
	const out = {};
	for (const [k] of SECTIONS) out[k] = i.custom[k] == null ? i.shipped[k] || "" : i.custom[k];
	return out;
}

function save(next) {
	if (target === "mine") {
		view.mine = { ...next };
		view.edited = true;
		invoke("rest_set_mine", { layout: next }).catch(() => {});
	} else {
		const i = island();
		if (!i) return;
		// (a section that is what the plugin shipped is kept as that: "as shipped" follows the plugin when it changes it)
		const custom = {};
		for (const [k] of SECTIONS) custom[k] = next[k] === (i.shipped[k] || "") ? null : next[k];
		i.custom = custom;
		invoke("rest_set_island", { key: i.key, custom }).catch(() => {});
	}
}

// ---------------------------------------------------------------------------------------------------- drawing

/** a widget as a chip: a picture of it (see sample.js); a widget whose plugin is off is its id and "Off" */
function chipBody(id) {
	const w = widgetOf(id);
	const body = el("span", "re-body");
	if (w) body.append(picture(w));
	else body.append(el("span", "re-name", id), el("span", "re-from", "Off"));
	return body;
}

function zoneNode(key, label, id, shipped) {
	const z = el("div", `re-zone${id ? "" : " empty"}`);
	z.dataset.sec = key;
	z.setAttribute("aria-label", label);
	if (id) {
		const chip = el("div", "re-chip");
		chip.dataset.id = id;
		chip.tabIndex = 0;
		chip.setAttribute("aria-label", `${widgetOf(id)?.name || id} in the ${label.toLowerCase()} section. Delete takes it out`);
		chip.title = widgetOf(id)?.name || id;
		chip.append(chipBody(id));
		const x = el("button", "re-x");
		x.type = "button";
		x.innerHTML = li("x");
		x.setAttribute("aria-label", "Take it out");
		x.addEventListener("click", () => put(key, ""));
		chip.append(x);
		chip.addEventListener("keydown", (e) => {
			if (e.key === "Delete" || e.key === "Backspace") {
				e.preventDefault();
				put(key, "");
			}
		});
		z.append(chip);
	} else {
		z.append(el("span", "re-drop", "Drop here"));
	}
	return z;
}

/** one section changed: this is what is edited from now on */
function put(key, id) {
	const next = current();
	next[key] = id;
	apply(next);
}

/** the sections are `next` now: the chips that are in a new place spring to it */
function apply(next, held = null) {
	const before = new Map([...root.querySelectorAll(".re-chip")].map((c) => [c.dataset.id, c.getBoundingClientRect()]));
	if (held) for (const [k, v] of held) before.set(k, v);
	save(next);
	draw();
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	for (const c of root.querySelectorAll(".re-chip")) {
		const f = before.get(c.dataset.id);
		if (!f) continue;
		const l = c.getBoundingClientRect();
		const dx = f.left - l.left;
		const dy = f.top - l.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 480, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
	}
}

/** a switch: the checkbox that every other page has */
function toggle(on, label, onChange) {
	const cb = document.createElement("input");
	cb.type = "checkbox";
	cb.className = "set-end re-tog";
	cb.checked = on;
	cb.setAttribute("aria-label", label);
	cb.addEventListener("change", () => onChange(cb.checked));
	return cb;
}

function setOn(i, on) {
	i.on = on;
	invoke("rest_set_island", { key: i.key, on }).catch(() => {});
	draw();
}

/** a row of the list at the left: the island, when it is used, and (for a plugin's) its grip and its switch */
function listRow(key, name, sub, i) {
	const row = el("div", `re-row${key === target ? " sel" : ""}${i && !i.on ? " offr" : ""}`);
	row.dataset.key = key;
	row.tabIndex = 0;
	row.setAttribute("role", "button");
	row.setAttribute("aria-pressed", String(key === target));
	const grip = el("span", "re-grip");
	if (i) {
		grip.innerHTML = li("grip");
		grip.setAttribute("aria-hidden", "true");
		grip.title = "Drag to rank";
	}
	const tx = el("div", "re-tx");
	tx.append(el("b", null, name), el("span", null, sub));
	row.append(grip, tx);
	if (i) row.append(toggle(i.on, `Use the ${name} island`, (on) => setOn(i, on)));
	else row.append(el("span", "re-tag", "Always"));
	const open = () => {
		target = key;
		draw();
	};
	row.addEventListener("click", (e) => {
		if (!e.target.closest(".re-tog") && !justRanked) open();
	});
	row.addEventListener("keydown", (e) => {
		if (e.target !== row) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			open();
		} else if (i && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			e.preventDefault();
			const at = view.islands.indexOf(i);
			rank(i, at + (e.key === "ArrowUp" ? -1 : 1));
		}
	});
	return row;
}

/** put an island at place `to` of the list (the host moves one place at a time) */
async function rank(i, to) {
	const from = view.islands.indexOf(i);
	to = Math.max(0, Math.min(view.islands.length - 1, to));
	if (from < 0 || from === to) return;
	view.islands.splice(to, 0, view.islands.splice(from, 1)[0]);
	draw();
	for (let n = 0; n < Math.abs(to - from); n++) await invoke("rest_move_island", { key: i.key, up: to < from }).catch(() => {});
}

function draw() {
	const i = target === "mine" ? null : island();
	const md = el("div", "re-md");

	// ---- the list: the user's own island, then the plugins' in the order they win
	const list = el("div", "re-list");
	const grp = (text, hint) => {
		const g = el("div", "re-grp", text);
		if (hint) g.append(el("em", null, hint));
		return g;
	};
	const mineCard = el("div", "re-card");
	mineCard.append(listRow("mine", "Your Island", "When no plugin island is on"));
	list.append(grp("Default"), mineCard);
	if (view.islands.length) {
		const card = el("div", "re-card re-ranks");
		for (const x of view.islands) card.append(listRow(x.key, x.name, x.when || x.plugin_name, x));
		list.append(grp("Plugin Islands", "Highest wins"), card);
	}
	md.append(list);

	// ---- the editor of the one that is chosen: what it is, whether it is on, its three sections, the tray
	const detail = el("div", "re-detail");
	const head = el("div", "re-head");
	const words = el("div", "re-words");
	if (i) {
		words.append(el("b", null, i.name), el("span", null, [i.description, i.plugin_name].filter(Boolean).join(" · ")));
		const sw = el("label", "re-switch");
		sw.append(el("span", null, i.on ? "On" : "Off"), toggle(i.on, `Use the ${i.name} island`, (on) => setOn(i, on)));
		head.append(words, sw);
	} else {
		words.append(el("b", null, "Your Island"), el("span", null, "Used when no plugin island is on."));
		head.append(words);
	}
	detail.append(head);

	const now = current();
	const stage = el("div", `re-stage${i && !i.on ? " off" : ""}`);
	const pill = el("div", "re-pill");
	for (const [key, label] of SECTIONS) pill.append(zoneNode(key, label, now[key], i?.shipped[key]));
	const names = el("div", "re-names");
	for (const [key, label] of SECTIONS) {
		const n = el("span", null, label);
		if (i && i.custom[key] == null) n.append(el("small", null, "As Shipped"));
		names.append(n);
	}
	stage.append(pill, names);
	if (i && !i.on) stage.append(el("div", "re-note", "This island is off. Nothing shows for it."));
	detail.append(stage);
	if (i && SECTIONS.some(([k]) => i.custom[k] != null)) {
		const reset = el("button", "re-link", "Back to What It Shipped");
		reset.type = "button";
		reset.addEventListener("click", () => {
			i.custom = {};
			invoke("rest_set_island", { key: i.key, reset: true }).catch(() => {});
			draw();
		});
		detail.append(reset);
	} else if (!i && view.edited && SECTIONS.some(([k]) => now[k] !== (defaultLayout()[k] || ""))) {
		const reset = el("button", "re-link", "Back to the Default");
		reset.type = "button";
		reset.addEventListener("click", () => apply(defaultLayout()));
		detail.append(reset);
	}

	if (!tray) {
		tray = makeTray({
			list: () => widgets.map((w) => ({ ...w, preview: () => picture(w) })),
			used: () => new Set(Object.values(current()).filter(Boolean)),
			plugins: () => pluginNames,
			onPress: (id) => {
				const next = current();
				const free = ["center", "left", "right"].find((k) => !next[k]);
				if (free) put(free, id);
			},
			wasJustDragged: () => justDragged,
		});
	}
	tray.fill();
	detail.append(tray);
	md.append(detail);
	root.replaceChildren(md);
}

// ---------------------------------------------------------------------------------------------------- ranking by the grip

let ranking = null;
let justRanked = false; // (the click that ends a drag of the grip does not open the row)

function beginRank(e) {
	const grip = e.target.closest(".re-grip");
	const row = grip?.closest(".re-row");
	if (!row || e.button !== 0 || !row.closest(".re-ranks")) return;
	const i = view.islands.find((x) => x.key === row.dataset.key);
	if (!i) return;
	ranking = { i, row, y0: e.clientY, started: false, pointer: e.pointerId, at: view.islands.indexOf(i), to: null };
	window.addEventListener("pointermove", moveRank);
	window.addEventListener("pointerup", endRank);
	window.addEventListener("pointercancel", endRank);
}

function moveRank(e) {
	const r = ranking;
	if (!r || e.pointerId !== r.pointer) return;
	if (!r.started) {
		if (Math.abs(e.clientY - r.y0) < 4) return;
		r.started = true;
		r.row.classList.add("re-lifted");
	}
	const rows = [...root.querySelectorAll(".re-ranks .re-row")];
	for (const x of rows) x.classList.remove("re-before", "re-after");
	// (the place it would take: before the first row whose middle is under the pointer)
	let to = rows.length - 1;
	for (let n = 0; n < rows.length; n++) {
		const b = rows[n].getBoundingClientRect();
		if (e.clientY < b.top + b.height / 2) {
			to = n;
			break;
		}
	}
	r.to = to;
	if (to !== r.at) rows[to].classList.add(to < r.at ? "re-before" : "re-after");
}

function endRank(e) {
	const r = ranking;
	if (!r || e.pointerId !== r.pointer) return;
	window.removeEventListener("pointermove", moveRank);
	window.removeEventListener("pointerup", endRank);
	window.removeEventListener("pointercancel", endRank);
	ranking = null;
	if (!r.started) return;
	justRanked = true;
	setTimeout(() => (justRanked = false), 0);
	r.row.classList.remove("re-lifted");
	for (const x of root.querySelectorAll(".re-row")) x.classList.remove("re-before", "re-after");
	if (e.type === "pointerup" && r.to != null) rank(r.i, r.to);
}

// ---------------------------------------------------------------------------------------------------- dragging

function ghostOf(id) {
	const g = el("div", "re-chip re-ghost");
	g.append(chipBody(id));
	return g;
}

function begin(e) {
	if (e.button !== 0 || e.target.closest(".re-x")) return;
	const chip = e.target.closest(".re-chip");
	const tile = chip ? null : e.target.closest(".hh-tile:not(.used)");
	const src = chip || tile;
	if (!src) return;
	const rect = src.getBoundingClientRect();
	drag = {
		id: src.dataset.id,
		from: chip ? chip.closest(".re-zone").dataset.sec : null,
		src,
		x0: e.clientX,
		y0: e.clientY,
		dx: Math.min(40, rect.width / 2),
		dy: Math.min(20, rect.height / 2),
		started: false,
		pointer: e.pointerId,
		ghost: null,
		to: null,
		out: false,
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", end);
	window.addEventListener("pointercancel", end);
}

function move(e) {
	const d = drag;
	if (!d || e.pointerId !== d.pointer) return;
	if (!d.started) {
		if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
		d.started = true;
		d.ghost = ghostOf(d.id);
		document.body.append(d.ghost);
		d.src.classList.add("re-lifted");
		const w = widgetOf(d.id);
		if (!d.from && w) openGroup(pluginNames.get(w.plugin) || w.plugin);
	}
	d.ghost.style.left = `${e.clientX - d.dx}px`;
	d.ghost.style.top = `${e.clientY - d.dy}px`;
	for (const z of root.querySelectorAll(".re-zone.re-ok")) z.classList.remove("re-ok");
	const under = document.elementsFromPoint(e.clientX, e.clientY);
	const zone = under.find((x) => x.classList?.contains("re-zone"));
	const stage = root.querySelector(".re-stage")?.getBoundingClientRect();
	const near = stage && e.clientX > stage.left - 16 && e.clientX < stage.right + 16 && e.clientY > stage.top - 16 && e.clientY < stage.bottom + 16;
	// (a widget out of a section, let go anywhere but on the stage, is taken out; one out of the tray just goes back)
	d.out = !!d.from && !zone && !near;
	d.ghost.classList.toggle("re-out", d.out);
	d.to = zone ? zone.dataset.sec : null;
	if (zone) zone.classList.add("re-ok");
}

function end(e) {
	const d = drag;
	if (!d || e.pointerId !== d.pointer) return;
	window.removeEventListener("pointermove", move);
	window.removeEventListener("pointerup", end);
	window.removeEventListener("pointercancel", end);
	drag = null;
	if (!d.started) return;
	justDragged = true;
	setTimeout(() => (justDragged = false), 0);
	const held = new Map([[d.id, d.ghost.getBoundingClientRect()]]);
	d.ghost.remove();
	d.src.classList.remove("re-lifted");
	for (const z of root.querySelectorAll(".re-zone.re-ok")) z.classList.remove("re-ok");
	if (e.type === "pointerup") {
		const next = current();
		if (d.to && d.to !== d.from) {
			const prev = next[d.to];
			for (const [k] of SECTIONS) if (next[k] === d.id) next[k] = "";
			next[d.to] = d.id;
			// (the widget that was there takes the place of the one in hand)
			if (d.from && prev && prev !== d.id) next[d.from] = prev;
			apply(next, held);
			return finish();
		}
		if (d.out) {
			next[d.from] = "";
			apply(next, held);
			return finish();
		}
	}
	finish();
}

function finish() {
	if (reloadAfter) {
		reloadAfter = false;
		render();
	}
}

// ---------------------------------------------------------------------------------------------------- the page

/** read what the host has, and draw it */
export async function render() {
	if (!root) return;
	// (a change that comes while a widget is in the hand waits for it to be put down)
	if (drag?.started) {
		reloadAfter = true;
		return;
	}
	try {
		view = (await invoke("rest_get")) || view;
	} catch (_) {}
	const w = await loadWidgets();
	widgets = w.out;
	pluginNames = w.names;
	if (target !== "mine" && !island()) target = "mine";
	draw();
}

/** `box`: where the page is drawn */
export function initRestEditor(box) {
	root = box;
	root.addEventListener("pointerdown", begin);
	root.addEventListener("pointerdown", beginRank);
	render();
}

// The head of the expanded island, and its foot: rows with a left, a center and a right place, which plugins fill with
// widgets (the eyes, the date, the rings...). A plugin registers its widgets (`register`); the island lays them out here.
//
// * Every widget is shown. When they do not fit in the row, the head gets another row, as many as it takes.
// * The center place is at the dead center of its row. A side place may grow only up to what is left of its half, so
//   the center never moves for it. A row with nothing in the center has no center: the two sides share the whole row.
// * The user arranges it in edit mode: drag a widget to the left, center or right of any row (refused when there is no
//   room), drag it off the island to take it out, press a chip to bring it back. Rows are at the top of the island, and
//   at the bottom, under the cards, where the user wants them.
// * What is arranged is kept by the host (`head_layout_get` / `head_layout_set`); a widget a plugin adds later takes its own
//   place. A plugin that is off has no widgets.

import { el, host, hooks, invoke, li, listen } from "./kit.js";

const GAP = 10; // between two widgets of a place
const SECT = 18; // between two places of a row
const SIDE = 16; // the row's padding at both ends
const CENTER_SLOT = 64; // the room an empty center asks for while the head is edited (only where the row has it to spare)
const PLACES = ["l", "c", "r"];
const PLACE_OF = { left: "l", center: "c", right: "r" };

// ---------------------------------------------------------------------------------------------------- the widgets

/** @type {Map<string, any>} */
const widgets = new Map();
let enabled = new Set(); // ids of the plugins that are switched on
let pluginNames = new Map(); // id -> name, for the tray's headings
let saved = { edited: false, rows: [], removed: [] };
let work = null; // the layout being arranged (edit mode)
let editing = false;
let root = null; // the rows at the top of the island
let foot = null; // the rows at the bottom of it
let seq = 0;
const listeners = new Set();

/**
 * Add a widget. `build()` makes its element (once). `plugin` is the plugin it belongs to: it shows only while that
 * plugin is on. `place`: where it goes ("left", "center", "right"); `rank`: its order among the others of its place.
 * A plugin may register as many widgets as it likes. `start`: false keeps one out of the head until the user drags it in
 * from the tray of edit mode. `preview()`: an element (a still picture of the widget) that the tray shows for it.
 */
export function register({ id, plugin = null, name, place = "right", rank = 50, width = 40, interactive = false, start = true, preview = null, build }) {
	const old = widgets.get(id);
	const w = old || { id, order: seq++, hidden: false, node: null, width };
	Object.assign(w, { plugin, place: PLACE_OF[place] || "r", rank, interactive, start, preview, build });
	if (!Object.getOwnPropertyDescriptor(w, "name")?.get) w.name = name || id;
	if (!old) w.width = width;
	widgets.set(id, w);
	schedule();
	return w;
}

/** a widget that has nothing to show yet (a ring with no number) takes no room */
export function setHidden(id, hidden) {
	const w = widgets.get(id);
	if (!w || w.hidden === hidden) return;
	w.hidden = hidden;
	schedule();
}

const isAvailable = (w) => !!w && !w.hidden && (w.plugin == null || enabled.has(w.plugin));
const wd = (id) => {
	const w = widgets.get(id);
	return w && isAvailable(w) ? w.width : 0;
};

export const isEnabled = (plugin) => enabled.has(plugin);
export const enabledCount = () => enabled.size;
/** called when the set of plugins that are on changes */
export function onEnabled(cb) {
	listeners.add(cb);
}

export async function refreshEnabled() {
	try {
		const listing = await invoke("plugin_list");
		const next = new Set((listing?.plugins || []).filter((p) => p.enabled).map((p) => p.id));
		const same = next.size === enabled.size && [...next].every((x) => enabled.has(x));
		enabled = next;
		pluginNames = new Map((listing?.plugins || []).map((p) => [p.id, p.name]));
		if (!same) for (const cb of listeners) cb(enabled);
		schedule();
	} catch (_) {}
}

// ---------------------------------------------------------------------------------------------------- laying out

const rowWidth = () => Math.max(120, (root?.clientWidth || 380) - 2 * SIDE);

function sum(ids) {
	let total = 0;
	let n = 0;
	for (const id of ids) {
		const w = wd(id);
		if (w > 0) {
			total += w;
			n++;
		}
	}
	return n ? total + GAP * (n - 1) : 0;
}

/** A row: `a` is where it is, "t" at the top of the island or "b" at the bottom; then what is at its left, center and right. */
const emptyRow = (a = "t") => ({ a, l: [], c: [], r: [] });
const mapRow = (r, keep = () => true) => ({ a: r.a === "b" ? "b" : "t", l: (r.l || []).filter(keep), c: (r.c || []).filter(keep), r: (r.r || []).filter(keep) });
const copyRows = (rows) => rows.map((r) => mapRow(r));
const isEmpty = (r) => !r.l.length && !r.c.length && !r.r.length;

/** the rows of the top first, then those of the bottom; there is always a row at the top */
function normalize(rows) {
	const top = rows.filter((r) => r.a !== "b");
	const bottom = rows.filter((r) => r.a === "b");
	return [...(top.length ? top : [emptyRow("t")]), ...bottom];
}

/** Does the row hold what it has, with the center where it is? */
function overflow(row, W) {
	const cW = sum(row.c);
	const lW = sum(row.l);
	const rW = sum(row.r);
	if (cW > 0) {
		const half = (W - cW) / 2 - SECT;
		if (cW > W - 2 * SECT) return "c";
		if (lW > half) return "l";
		if (rW > half) return "r";
		return null;
	}
	if (lW + rW + (lW > 0 && rW > 0 ? SECT : 0) <= W) return null;
	return lW >= rW ? "l" : "r";
}

/** Can a row with no center spare room for an empty center's drop target (in edit mode) without squeezing its sides? */
function hasSlot(row, W) {
	const half = (W - CENTER_SLOT) / 2 - SECT;
	return sum(row.l) <= half && sum(row.r) <= half;
}

/** Move what does not fit to the next row (a new one when there is none): the last of the left, the first of the right. */
function fit(rows) {
	const W = rowWidth();
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const spill = emptyRow(row.a);
		for (let guard = 0; guard < 200; guard++) {
			const z = overflow(row, W);
			if (!z) break;
			if (z === "r") spill.r.push(...row.r.splice(0, 1));
			else spill[z].unshift(...row[z].splice(row[z].length - 1, 1));
		}
		if (!isEmpty(spill)) {
			// (what does not fit goes to the next row of the same side of the island, or to a new one)
			if (rows[i + 1]?.a !== row.a) rows.splice(i + 1, 0, emptyRow(row.a));
			rows[i + 1].l.unshift(...spill.l);
			rows[i + 1].c.unshift(...spill.c);
			rows[i + 1].r.unshift(...spill.r);
		}
	}
	// (the rows that only the shuffling left empty go, the last of each side first; the first row of the top stays)
	if (!editing) {
		for (let i = rows.length - 1; i > 0; i--) if (isEmpty(rows[i]) && rows[i + 1]?.a !== rows[i].a) rows.splice(i, 1);
	}
	return rows;
}

/** What the plugins give: every widget at the place it asks for, in its rank. */
function defaults() {
	const row = emptyRow();
	const list = [...widgets.values()].filter((w) => isAvailable(w) && w.start).sort(byRank);
	for (const w of list) row[w.place].push(w.id);
	return [row];
}

/** The rows now: what the user arranged (with what is new at its own place), or what the plugins give; then made to fit. */
function resolve() {
	let rows;
	if (editing && work) {
		rows = work.rows.map((r) => mapRow(r, isHere));
	} else if (saved.edited) {
		rows = saved.rows.map((r) => mapRow(r, isAv));
	} else {
		rows = defaults();
	}
	rows = normalize(rows);
	// a widget that is new (it is in no row and was not taken out) comes in at its place of the first row
	if (saved.edited || editing) {
		const known = new Set(rows.flatMap((r) => [...r.l, ...r.c, ...r.r]));
		const gone = new Set(editing && work ? work.removed : saved.removed);
		const fresh = [...widgets.values()].filter((w) => isAvailable(w) && w.start && !known.has(w.id) && !gone.has(w.id) && w.id !== lifted()).sort(byRank);
		for (const w of fresh) rows[0][w.place].push(w.id);
	}
	fit(rows);
	// (edit mode always has a place at the bottom to drop a widget in)
	if (editing && !rows.some((r) => r.a === "b")) rows.push(emptyRow("b"));
	return rows;
}
const byRank = (a, b) => a.rank - b.rank || a.order - b.order;
const isAv = (id) => isAvailable(widgets.get(id));
/** the widget in the hand is at no place: the places it came from take back the room it had */
const lifted = () => (drag?.started ? drag.w.id : null);
const isHere = (id) => isAv(id) && id !== lifted();

// ---------------------------------------------------------------------------------------------------- the elements

function node(w) {
	if (!w.node) {
		const n = el("div", "hh-w");
		n.dataset.id = w.id;
		const body = w.build();
		n.append(body);
		if (w.interactive) n.addEventListener("mousedown", (e) => e.stopPropagation());
		w.node = n;
		measure.observe(n);
	}
	w.node.classList.remove("hh-lift", "hh-out");
	w.node.style.cssText = "";
	return w.node;
}

const measure = new ResizeObserver((entries) => {
	let changed = false;
	for (const e of entries) {
		const n = e.target;
		if (!n.isConnected) continue;
		const w = widgets.get(n.dataset.id);
		if (!w) continue;
		const width = Math.round(n.offsetWidth);
		// (a width of nothing is a place that is not drawn, or a ring with nothing to say: the last width stands)
		if (width > 0 && Math.abs(width - w.width) > 1 && !n.classList.contains("hh-lift")) {
			w.width = width;
			changed = true;
		}
	}
	if (changed) schedule();
});

/** A new row, at the end of the top of the island or of its bottom. */
function addButton(area) {
	const add = el("button", "hh-add");
	add.type = "button";
	add.innerHTML = `${li("plus")}Add a row`;
	add.addEventListener("mousedown", (e) => e.stopPropagation());
	add.addEventListener("click", () => {
		const at = area === "b" ? work.rows.length : work.rows.findLastIndex((r) => r.a !== "b") + 1;
		work.rows.splice(at, 0, emptyRow(area));
		schedule();
	});
	return add;
}

// the tray: what the plugins offer, by plugin. A group folds (the first two start open), a search cuts it down, and what is
// in a place already can be hidden. It keeps one height and scrolls inside itself, however many widgets there are.
const trayFolded = new Map(); // plugin id -> true/false, once the user has folded or opened it
let trayQuery = "";
let trayScroll = 0;
let trayHideUsed = false;
try {
	trayHideUsed = localStorage.getItem("nadi.trayHideUsed") === "1";
	for (const k of JSON.parse(localStorage.getItem("nadi.trayFolded") || "[]")) trayFolded.set(k[0], k[1]);
} catch (_) {}
const keepTray = () => {
	try {
		localStorage.setItem("nadi.trayHideUsed", trayHideUsed ? "1" : "0");
		localStorage.setItem("nadi.trayFolded", JSON.stringify([...trayFolded]));
	} catch (_) {}
};

/** `text` with the part that `q` matches in bold */
function marked(text, q) {
	const span = el("span");
	const at = q ? text.toLowerCase().indexOf(q) : -1;
	if (at < 0) {
		span.textContent = text;
		return span;
	}
	span.append(document.createTextNode(text.slice(0, at)), el("b", null, text.slice(at, at + q.length)), document.createTextNode(text.slice(at + q.length)));
	return span;
}

function tray() {
	const box = el("div", "hh-tray");
	const top = el("div", "hh-tray-h");
	top.append(el("span", "hh-tray-l", "Widgets"));
	const search = el("label", "hh-search");
	search.innerHTML = li("search");
	const input = el("input");
	input.type = "search";
	input.placeholder = "Search widgets";
	input.value = trayQuery;
	input.setAttribute("aria-label", "Search widgets");
	input.addEventListener("input", () => {
		trayQuery = input.value;
		fill();
	});
	// (typing is typing: nothing here picks up a widget, or closes the island)
	input.addEventListener("mousedown", (e) => e.stopPropagation());
	search.append(input);
	const hide = el("button", "hh-switch");
	hide.type = "button";
	hide.setAttribute("aria-pressed", String(trayHideUsed));
	hide.append(el("i"), document.createTextNode("Hide in use"));
	hide.addEventListener("click", () => {
		trayHideUsed = !trayHideUsed;
		hide.setAttribute("aria-pressed", String(trayHideUsed));
		keepTray();
		fill();
	});
	top.append(search, hide);
	const body = el("div", "hh-tray-body");
	const fade = () => box.classList.toggle("hh-more", body.scrollHeight - body.clientHeight - body.scrollTop > 4);
	body.addEventListener(
		"scroll",
		() => {
			trayScroll = body.scrollTop;
			fade();
		},
		{ passive: true },
	);
	box.append(top, body);

	function fill() {
		const used = new Set(work.rows.flatMap((r) => [...r.l, ...r.c, ...r.r]));
		const q = trayQuery.trim().toLowerCase();
		const groups = new Map(); // plugin id -> { name, all, shown }
		for (const w of [...widgets.values()].filter(isAvailable).sort(byRank)) {
			const key = w.plugin || "";
			if (!groups.has(key)) groups.set(key, { name: pluginNames.get(key) || "Other", all: 0, shown: [] });
			const g = groups.get(key);
			g.all++;
			if (q && !w.name.toLowerCase().includes(q) && !g.name.toLowerCase().includes(q)) continue;
			if (trayHideUsed && used.has(w.id)) continue;
			g.shown.push(w);
		}
		const out = [];
		let n = 0;
		for (const [key, g] of groups) {
			const index = n++;
			if (!g.shown.length) continue;
			// (a search shows what it found: every group that has something is open)
			const open = q ? true : !(trayFolded.has(key) ? trayFolded.get(key) : index >= 2);
			const head = el("button", `hh-tray-gh${open ? " open" : ""}`);
			head.type = "button";
			head.setAttribute("aria-expanded", String(open));
			head.innerHTML = li("chevron");
			head.append(el("span", "hh-tray-n", g.name), el("span", "hh-tray-c", g.shown.length === g.all ? String(g.all) : `${g.shown.length} of ${g.all}`));
			head.addEventListener("click", () => {
				trayFolded.set(key, open);
				keepTray();
				fill();
			});
			out.push(head);
			if (!open) continue;
			const tiles = el("div", "hh-tiles");
			for (const w of g.shown) tiles.append(tile(w, used.has(w.id), q));
			out.push(tiles);
		}
		if (!out.length) out.push(el("div", "hh-tray-none", groups.size ? "No widget has that name" : "No widgets yet: turn a plugin on"));
		body.replaceChildren(...out);
		fade();
	}
	fill();
	// (the head is laid out again at each move: the tray keeps where it was scrolled to)
	requestAnimationFrame(() => {
		body.scrollTop = trayScroll;
		fade();
	});
	return box;
}

function tile(w, inUse, q) {
	const t = el("button", `hh-tile${inUse ? " used" : ""}`);
	t.type = "button";
	t.dataset.id = w.id;
	t.dataset.plugin = w.plugin || "";
	t.setAttribute("aria-label", inUse ? `${w.name}, in use` : `Add ${w.name}`);
	let pic = null;
	try {
		pic = w.preview?.() || null;
	} catch (_) {}
	if (pic) {
		const pv = el("span", "hh-tile-pv");
		pv.append(pic);
		t.append(pv);
	}
	const nm = el("span", "hh-tile-nm");
	nm.append(marked(w.name, q));
	t.append(nm);
	if (inUse) t.append(el("span", "hh-tile-tag", "In use"));
	// (pressing it, with no mouse to drag: it goes to its own place of the first row, and the row spills if it must)
	t.addEventListener("click", () => {
		if (inUse || justDragged) return;
		place(w.id, 0, w.place);
		schedule();
	});
	return t;
}

// the tools of edit mode: add a row, the tray of widgets, and the buttons
let toolsNode = null;
function tools() {
	if (!toolsNode) {
		toolsNode = el("div", "hh-tools");
		toolsNode.addEventListener("mousedown", (e) => e.stopPropagation());
	}
	const add = addButton("t");
	const bar = el("div", "hh-bar");
	bar.append(el("p", null, "Drag a widget anywhere, or off the island to put it back in the tray"));
	const buttons = el("div");
	const reset = el("button", "hh-btn", "Reset");
	reset.type = "button";
	reset.addEventListener("click", () => {
		work = { rows: defaults(), removed: [] };
		work.rows = fit(work.rows);
		schedule();
	});
	const done = el("button", "hh-btn go", "Done");
	done.type = "button";
	done.addEventListener("click", () => stopEdit());
	buttons.append(reset, done);
	bar.append(buttons);
	toolsNode.replaceChildren(add, tray(), bar);
	return toolsNode;
}

// ---------------------------------------------------------------------------------------------------- drawing

let raf = 0;
function schedule() {
	if (!root || raf) return;
	raf = requestAnimationFrame(() => {
		raf = 0;
		render();
	});
}

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const FRAME = 7; // how far a place's outline stands out of it (edit mode)
const ZONE_KEY = (z) => `${z.dataset.row}:${z.dataset.place}`;
/** the places and the widgets drawn now */
const drawn = (sel) => [...(root?.querySelectorAll(sel) || []), ...(foot?.querySelectorAll(sel) || [])];

/** where the widgets and the places are now (taken before anything moves them) */
function snapshot() {
	const firstW = new Map();
	const firstZ = new Map();
	if (editing && !reduced.matches) {
		for (const n of drawn(".hh-w")) firstW.set(n.dataset.id, n.getBoundingClientRect());
		for (const z of drawn(".hh-zone")) firstZ.set(ZONE_KEY(z), z.getBoundingClientRect());
	}
	return { firstW, firstZ };
}

/**
 * In edit mode what moves springs to its new place (FLIP: from where it was drawn to where it is now), and so do the
 * outlines of the places that shrink or grow. `from`: the rects of what is not in the head any more (the widget just let go).
 */
function render(from, before = snapshot()) {
	if (!root) return;
	const spring = editing && !reduced.matches;
	const { firstW, firstZ } = before;
	if (from) for (const [k, v] of from) firstW.set(k, v);
	const rows = resolve();
	if (editing && !lifted()) work.rows = copyRows(rows);
	for (const e of [root, foot]) e?.classList.toggle("hh-edit", editing);
	document.getElementById("hub").classList.toggle("hh-editing", editing);
	const outTop = [];
	const outFoot = [];
	const W = rowWidth();
	rows.forEach((row, i) => {
		const first = i === 0;
		const r = el("div", `hh-row ${first ? "hh-first" : "hh-x"}${row.a === "b" ? " hh-b" : ""}`);
		r.dataset.row = String(i);
		// (the rows spring in once, as the island opens: not again each time the head lays itself out)
		if (!entering) r.style.animation = "none";
		const hasCenter = row.c.some((id) => wd(id) > 0);
		r.classList.toggle("hh-noc", !hasCenter);
		// (edit mode: an empty center is a place of its own where the row has room for it, else it is not offered)
		r.classList.toggle("hh-slot", editing && !hasCenter && hasSlot(row, W));
		for (const place of PLACES) {
			const z = el("div", `hh-zone ${place}`);
			z.dataset.place = place;
			z.dataset.row = String(i);
			if (editing) z.append(el("i", "hh-frame"));
			for (const id of row[place]) {
				const w = widgets.get(id);
				if (w && isAvailable(w)) z.append(node(w));
			}
			const filled = row[place].some((id) => wd(id) > 0);
			z.classList.toggle("hh-empty", !filled);
			r.append(z);
		}
		(row.a === "b" ? outFoot : outTop).push(r);
	});
	if (editing) {
		outTop.push(tools());
		outFoot.unshift(el("div", "hh-area-l", "Bottom of the island"));
		outFoot.push(addButton("b"));
	}
	root.replaceChildren(...outTop);
	foot?.replaceChildren(...outFoot);
	if (spring && !entering) {
		for (const n of drawn(".hh-w")) {
			const f = firstW.get(n.dataset.id);
			if (!f) continue;
			const l = n.getBoundingClientRect();
			const dx = f.left - l.left;
			const dy = f.top - l.top;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
			n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 520, easing: SPRING });
		}
		for (const z of drawn(".hh-zone")) {
			const f = firstZ.get(ZONE_KEY(z));
			const frame = z.firstElementChild;
			if (!f || !frame?.classList.contains("hh-frame")) continue;
			const l = z.getBoundingClientRect();
			const d = [f.left - l.left, f.top - l.top, l.right - f.right, l.bottom - f.bottom];
			if (d.every((v) => Math.abs(v) < 0.5)) continue;
			const at = (a, b, c, e) => ({ left: `${a - FRAME}px`, top: `${b - FRAME}px`, right: `${c - FRAME}px`, bottom: `${e - FRAME}px` });
			frame.animate([at(d[0], d[1], d[2], d[3]), at(0, 0, 0, 0)], { duration: 520, easing: SPRING });
		}
	}
	entering = false;
	host.scheduleHubHeight();
}

let entering = false;

export function mount(head, bottom) {
	root = head;
	foot = bottom;
	for (const area of [root, foot]) {
		if (!area) continue;
		// (a click on the head's own background collapses the island, as it did; in edit mode it does nothing)
		area.addEventListener("mousedown", (e) => {
			if (editing) e.stopPropagation();
		});
		area.addEventListener("pointerdown", beginDrag);
		// (in edit mode a widget is picked up, never pressed)
		area.addEventListener(
			"click",
			(e) => {
				if (editing && !e.target.closest(".hh-tools, .hh-add")) {
					e.stopPropagation();
					e.preventDefault();
				}
			},
			true,
		);
	}
	const size = new ResizeObserver(() => schedule());
	size.observe(root);
	schedule();
}

/** the island opened: lay it out with the width it has now */
export function shown() {
	entering = true;
	refreshEnabled();
	schedule();
}

// ---------------------------------------------------------------------------------------------------- edit mode

/** what is on screen becomes the arrangement (so that moving one widget does not move the others) */
function materialize() {
	work.rows = fit(normalize(work.rows.map((r) => mapRow(r, isAv))));
}

export function startEdit() {
	if (editing) return;
	const rows = resolve();
	work = { rows: copyRows(rows), removed: [...(saved.removed || [])] };
	editing = true;
	host.setPane("info");
	root.classList.add("hh-edit");
	schedule();
}

export function stopEdit() {
	if (!editing) return;
	const rows = normalize(copyRows(work.rows).filter((r) => !isEmpty(r)));
	saved = {
		edited: true,
		rows,
		removed: work.removed,
	};
	work = null;
	editing = false;
	invoke("head_layout_set", { layout: JSON.stringify(saved) }).catch(() => {});
	schedule();
}

export const isEditing = () => editing;

// ---------------------------------------------------------------------------------------------------- dragging a widget

let drag = null;
let justDragged = false; // (the click that follows a drag is not a press on the tile it ended on)

function beginDrag(e) {
	if (!editing || e.button !== 0) return;
	const tileEl = e.target.closest?.(".hh-tile:not(.used)");
	if (tileEl) {
		// a widget out of the tray: it is made now, and carried like one picked up from a place
		const w = widgets.get(tileEl.dataset.id);
		if (!w) return;
		const rect = tileEl.getBoundingClientRect();
		drag = { w, n: node(w), tray: true, x0: e.clientX, y0: e.clientY, dx: Math.min(24, rect.width / 2), dy: 16, started: false, pointer: e.pointerId, target: null, out: false };
		window.addEventListener("pointermove", moveDrag);
		window.addEventListener("pointerup", endDrag);
		window.addEventListener("pointercancel", endDrag);
		return;
	}
	const n = e.target.closest?.(".hh-w");
	if (!n || !(root.contains(n) || foot?.contains(n))) return;
	const w = widgets.get(n.dataset.id);
	if (!w) return;
	const rect = n.getBoundingClientRect();
	drag = { w, n, x0: e.clientX, y0: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, started: false, pointer: e.pointerId, target: null, out: false };
	window.addEventListener("pointermove", moveDrag);
	window.addEventListener("pointerup", endDrag);
	window.addEventListener("pointercancel", endDrag);
}

function hubRect() {
	return document.getElementById("hub").getBoundingClientRect();
}

function moveDrag(e) {
	if (!drag || e.pointerId !== drag.pointer) return;
	const d = drag;
	if (!d.started) {
		if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
		d.started = true;
		const row = d.n.closest(".hh-row");
		const rect = d.n.getBoundingClientRect();
		const rowh = row ? getComputedStyle(row).getPropertyValue("--rowh") : "52px";
		const hub = document.getElementById("hub");
		const before = snapshot();
		d.n.classList.add("hh-lift");
		// (a widget is as tall as its row, and in the hub it has no row: it keeps the size it was picked up with; one out of
		// the tray has not been drawn yet, and is as big as it is)
		if (!d.tray) {
			d.n.style.width = `${rect.width}px`;
			d.n.style.height = `${rect.height}px`;
		}
		d.n.style.setProperty("--rowh", rowh);
		// (the group it came from opens, so that its tile is still there to see)
		if (d.tray && d.w.plugin != null) {
			trayFolded.set(d.w.plugin, false);
			keepTray();
		}
		hub.append(d.n);
		// (what the widget had is given back at once: the others spring into the room)
		render(undefined, before);
		try {
			document.body.setPointerCapture?.(e.pointerId);
		} catch (_) {}
	}
	const hr = hubRect();
	d.n.style.left = `${e.clientX - hr.left - d.dx}px`;
	d.n.style.top = `${e.clientY - hr.top - d.dy}px`;
	// off the island: let go and it is taken out
	const M = 12;
	d.out = e.clientX < hr.left - M || e.clientX > hr.right + M || e.clientY < hr.top - M || e.clientY > hr.bottom + M;
	d.n.classList.toggle("hh-out", d.out);
	for (const z of drawn(".hh-zone.hh-ok, .hh-zone.hh-nope")) z.classList.remove("hh-ok", "hh-nope");
	d.target = null;
	if (d.out) return;
	const z = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains("hh-zone") && (root.contains(x) || foot?.contains(x)));
	if (!z) return;
	const row = Number(z.dataset.row);
	const place = z.dataset.place;
	const index = [...z.children].filter((c) => c.classList.contains("hh-w")).reduce((n, c) => {
		const r = c.getBoundingClientRect();
		return e.clientX > r.left + r.width / 2 ? n + 1 : n;
	}, 0);
	const ok = canDrop(d.w.id, row, place);
	z.classList.add(ok ? "hh-ok" : "hh-nope");
	d.target = ok ? { row, place, index } : null;
}

function endDrag(e) {
	if (!drag || e.pointerId !== drag.pointer) return;
	window.removeEventListener("pointermove", moveDrag);
	window.removeEventListener("pointerup", endDrag);
	window.removeEventListener("pointercancel", endDrag);
	const d = drag;
	if (d.started) {
		justDragged = true;
		setTimeout(() => (justDragged = false), 0);
	}
	// (where the widget was let go: it springs from there to its place)
	const held = d.started ? new Map([[d.w.id, d.n.getBoundingClientRect()]]) : null;
	drag = null;
	try {
		document.body.releasePointerCapture?.(e.pointerId);
	} catch (_) {}
	if (d.started && e.type === "pointerup") {
		if (d.out) {
			if (!d.tray) takeOut(d.w.id);
		} else if (d.target) place(d.w.id, d.target.row, d.target.place, d.target.index);
	}
	if (raf) cancelAnimationFrame(raf);
	raf = 0;
	render(held);
	// (a widget that was taken out is in no place: it is not in the hub's way any more either)
	if (d.n.parentElement?.id === "hub") d.n.remove();
}

/** the rows with the widget at a place (without it anywhere else), for asking whether they fit */
function withWidget(id, row, placeKey, index) {
	const rows = copyRows(work.rows);
	for (const r of rows) for (const p of PLACES) r[p] = r[p].filter((x) => x !== id);
	const at = Math.min(index ?? rows[row][placeKey].length, rows[row][placeKey].length);
	rows[row][placeKey].splice(at, 0, id);
	return rows;
}

/** would the row that takes the widget still hold everything it has? */
function canDrop(id, row, placeKey) {
	const rows = withWidget(id, row, placeKey, 0);
	return !overflow(rows[row], rowWidth());
}

function place(id, row, placeKey, index) {
	work.rows = withWidget(id, row, placeKey, index);
	work.removed = work.removed.filter((x) => x !== id);
	materialize();
}

function takeOut(id) {
	for (const r of work.rows) for (const p of PLACES) r[p] = r[p].filter((x) => x !== id);
	if (!work.removed.includes(id)) work.removed.push(id);
	materialize();
}

// ---------------------------------------------------------------------------------------------------- start

export async function init() {
	try {
		const text = await invoke("head_layout_get");
		if (text) {
			const s = JSON.parse(text);
			if (s && Array.isArray(s.rows)) saved = { edited: !!s.edited, rows: normalize(s.rows.map((r) => mapRow(r))), removed: s.removed || [] };
		}
	} catch (_) {}
	listen("plugins-changed", () => refreshEnabled());
	listen("view-tick", (e) => {
		if (e.payload === "hub") shown();
		else if (editing) stopEdit();
	});
	refreshEnabled();
}

// a ring a plugin adds (see kit.addRing) is a widget of the right side, shown while it has a number
hooks.ringAdded = (key, ring, plugin, rank, start = true) => {
	const w = register({
		id: `ring:${key}`,
		plugin,
		name: key,
		place: "right",
		rank,
		width: 18,
		start,
		preview: () => {
			// (a still copy of the ring as it is now)
			const c = ring.cloneNode(true);
			c.removeAttribute("id");
			c.classList.remove("hidden");
			return c;
		},
		build: () => ring,
	});
	// (the plugin names its ring just after it adds it)
	Object.defineProperty(w, "name", { get: () => ring.dataset.name || key, configurable: true });
	setHidden(`ring:${key}`, ring.classList.contains("hidden"));
	new MutationObserver(() => setHidden(`ring:${key}`, ring.classList.contains("hidden"))).observe(ring, { attributes: true, attributeFilter: ["class"] });
};

export const head = { register, setHidden, mount, init, shown, startEdit, stopEdit, isEditing, isEnabled, enabledCount, onEnabled, refreshEnabled };

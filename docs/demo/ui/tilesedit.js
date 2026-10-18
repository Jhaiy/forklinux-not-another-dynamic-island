// The Tiles view of the Expanded Island page (the settings window), and the one place where the tiles are arranged: the open
// island's grid as it is laid out there, at the island's real width, with every free place shown, and a row for each tile with
// its size and its switch. A tile is dragged to any place of the grid (a big one needs room for all of itself; the one that is in
// the way moves on); a size is one the plugin says it can be drawn in, listed small, wide, large. What is kept is where each
// tile is, the sizes and what was taken out (tiles.rs); the island follows at once, laying the grid out with the same rule
// (tilegrid.js).

import { el, invoke, li, listen } from "./kit.js";
import { rowsOf, solve } from "./tilegrid.js";

const GAP = 6; // (the standard gap between the tiles)
let gap = GAP;
const WANT = 44;

let root = null;
let grid = null;
let specs = [];
let layout = { positions: {}, sizes: {}, removed: [], center: false, gap: null };
let hubWidth = 420;
let cols = 4;
let placed = new Map();
let drag = null;

const sizeOf = (s) => (layout.sizes[s.id] && s.sizes.includes(layout.sizes[s.id]) ? layout.sizes[s.id] : s.start || s.sizes[0]);
const isWide = (id) => {
	const s = specs.find((x) => x.id === id);
	return !!s && sizeOf(s) === "wide";
};
const label = (z) => `${z[0].toUpperCase()}${z.slice(1)}`;
const shown = () => specs.filter((s) => !layout.removed.includes(s.id));

function save() {
	invoke("tiles_set", { layout }).catch(() => {});
}

function items(pos = layout.positions) {
	return shown().map((s) => ({ id: s.id, size: sizeOf(s), pos: pos[s.id] }));
}

/** the places of the tiles as they are now become what the user chose (`first`: the one just moved, which gets its place first) */
function keep(first, at) {
	const list = items();
	if (first && at) {
		const one = list.find((i) => i.id === first);
		if (one) one.pos = at;
	}
	const next = solve(list, cols, first);
	// (a wide tile keeps the cell it was put in, not the stretch of it)
	layout.positions = Object.fromEntries([...next].map(([id, p]) => [id, { col: p.ac ?? p.col, row: p.row }]));
	save();
	draw();
}

function measure() {
	// (the same rule as the island's: as many columns as fit squares of about 44 px)
	const w = Math.max(200, hubWidth - 40);
	cols = Math.max(2, Math.floor((w + gap) / (WANT + gap)));
	if (grid) {
		grid.style.width = `${w}px`;
		grid.style.setProperty("--cols", String(cols));
		grid.style.setProperty("--gap", `${gap}px`);
		grid.style.setProperty("--tile", `${Math.floor((w - gap * (cols - 1)) / cols)}px`);
	}
}

function miniTile(s) {
	const t = el("div", `tl te-tile tl-${sizeOf(s)}`);
	t.dataset.id = s.id;
	t.style.setProperty("--c", s.tint || "#8e8e96");
	const ic = el("span", "tl-ic");
	ic.innerHTML = li(s.icon);
	const grip = el("span", "te-grip");
	grip.innerHTML = li("grip");
	grip.setAttribute("aria-hidden", "true");
	const bot = el("div", "tl-bot");
	bot.append(el("div", "tl-nm", s.name), el("div", "tl-cap", label(sizeOf(s))));
	t.dataset.tip = `${s.name}
${label(sizeOf(s))}`;
	t.append(ic, grip, bot);
	t.addEventListener("pointerdown", (e) => begin(e, t));
	return t;
}

function row(s) {
	const gone = layout.removed.includes(s.id);
	const r = el("div", `te-row${gone ? " te-off" : ""}`);
	r.append(el("span", "te-nm", s.name));
	if (s.sizes.length > 1) {
		const seg = el("span", "te-seg");
		for (const z of s.sizes) {
			const b = el("button", z === sizeOf(s) ? "on" : "", label(z));
			b.type = "button";
			b.addEventListener("click", () => {
				layout.sizes = { ...layout.sizes, [s.id]: z };
				// (the tile keeps its place if it fits there; the others move out of its way)
				const at = placed.get(s.id);
				keep(s.id, at ? { col: at.col, row: at.row } : undefined);
			});
			seg.append(b);
		}
		r.append(seg);
	} else r.append(el("span", "te-only", label(s.sizes[0])));
	const cb = document.createElement("input");
	cb.type = "checkbox";
	cb.className = "set-end";
	cb.checked = !gone;
	cb.setAttribute("aria-label", `Show the ${s.name} tile`);
	cb.addEventListener("change", () => {
		layout.removed = cb.checked ? layout.removed.filter((x) => x !== s.id) : [...layout.removed.filter((x) => x !== s.id), s.id];
		if (!cb.checked) delete layout.positions[s.id];
		save();
		draw();
	});
	r.append(cb);
	return r;
}

function draw() {
	if (!root) return;
	if (!specs.length) {
		root.replaceChildren(el("div", "te-none", "No tiles yet: turn on a plugin that has one."));
		return;
	}
	measure();
	placed = solve(items(), cols);
	const hub = el("div", "te-hub");
	grid = el("div", "te-grid");
	measure();
	const rows = rowsOf(placed) + 1;
	// (every free place, so that a tile can be put in any of them)
	const taken = new Set();
	for (const p of placed.values()) for (let y = p.row; y < p.row + p.h; y++) for (let x = p.col; x < p.col + p.w; x++) taken.add(`${x},${y}`);
	for (let y = 1; y <= rows; y++) {
		for (let x = 1; x <= cols; x++) {
			if (taken.has(`${x},${y}`)) continue;
			const c = el("div", "te-cell");
			c.style.gridColumn = String(x);
			c.style.gridRow = String(y);
			grid.append(c);
		}
	}
	for (const s of shown()) {
		const t = miniTile(s);
		const p = placed.get(s.id);
		t.style.gridColumn = `${p.col} / span ${p.w}`;
		t.style.gridRow = `${p.row} / span ${p.h}`;
		grid.append(t);
	}
	hub.append(grid);
	const panel = el("div", "te-panel");
	panel.append(el("div", "te-grp", "Tiles"));
	const card = el("div", "te-card");
	for (const s of specs) card.append(row(s));
	panel.append(card);
	panel.append(el("div", "te-grp te-grp-2", "Grid"));
	const opts = el("div", "te-card");
	const mid = el("div", "te-row");
	mid.append(el("span", "te-nm", "Center Tiles"));
	const cc = document.createElement("input");
	cc.type = "checkbox";
	cc.className = "set-end";
	cc.checked = !!layout.center;
	cc.setAttribute("aria-label", "Center the tiles of a row when there is room at its sides");
	cc.addEventListener("change", () => {
		layout.center = cc.checked;
		save();
	});
	mid.append(cc);
	opts.append(mid);
	const gp = el("div", "te-row");
	gp.append(el("span", "te-nm", "Tile Gap"));
	const sl = el("span", "set-sl te-sl");
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = "0";
	slider.max = "16";
	slider.step = "1";
	slider.value = String(gap);
	slider.setAttribute("aria-label", "Gap between the tiles");
	const val = el("span", "set-val", `${gap} px`);
	slider.addEventListener("input", () => {
		gap = Number(slider.value);
		val.textContent = `${gap} px`;
	});
	// (kept when let go: it lays the grid out again, and the island follows)
	slider.addEventListener("change", () => {
		layout.gap = gap;
		measure();
		keep(null, null);
	});
	sl.append(el("span"), slider, val);
	gp.append(sl);
	opts.append(gp);
	panel.append(opts);
	// (the island moves a row, not the places: the grid here shows where each tile is kept)
	panel.append(el("div", "te-hint", "Center Tiles puts the tiles of a row in the middle of the island when there is room at its sides. The grid here shows where each tile is kept."));
	panel.append(el("div", "te-hint", "Drag a tile to any place of the grid. A wide tile takes the free places of its row around it, and shares them evenly with another wide tile in the row. A tile offers only the sizes it can be drawn in, and starts at the first its plugin lists. A tile that is off is removed from the island, and its plugin keeps running. Every other tile stays, whether or not anything is going on."));
	const wrap = el("div", "te-cols");
	wrap.append(hub, panel);
	root.replaceChildren(wrap);
}

// ---------------------------------------------------------------------------------------------------- dragging

/** the place (column and row) the top left of a tile in the hand is over */
function cellAt(x, y, d) {
	const r = grid.getBoundingClientRect();
	const cw = (r.width + gap) / cols;
	const span = isWide(d.id) ? { w: 1, h: 1 } : placed.get(d.id) || { w: 1, h: 1 };
	let col = Math.round((x - d.dx - r.left) / cw) + 1;
	let row = Math.round((y - d.dy - r.top) / cw) + 1;
	col = Math.min(Math.max(1, col), cols - span.w + 1);
	row = Math.max(1, row);
	return { col, row };
}

function begin(e, tile) {
	if (e.button !== 0) return;
	drag = { tile, id: tile.dataset.id, x0: e.clientX, y0: e.clientY, started: false, pointer: e.pointerId, ghost: null, target: null, at: null };
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", end);
	window.addEventListener("pointercancel", end);
}

function move(e) {
	const d = drag;
	if (!d || e.pointerId !== d.pointer) return;
	if (!d.started) {
		if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
		d.started = true;
		d.tile.classList.add("tl-lifted");
		const r = d.tile.getBoundingClientRect();
		d.dx = e.clientX - r.left;
		d.dy = e.clientY - r.top;
		const g = d.tile.cloneNode(true);
		g.classList.add("tl-ghost", "te-ghost");
		g.style.width = `${r.width}px`;
		g.style.height = `${r.height}px`;
		g.style.gridColumn = g.style.gridRow = "";
		document.body.append(g);
		d.ghost = g;
		d.target = el("div", "te-target");
		grid.append(d.target);
	}
	d.ghost.style.left = `${e.clientX - d.dx}px`;
	d.ghost.style.top = `${e.clientY - d.dy}px`;
	const at = cellAt(e.clientX, e.clientY, d);
	d.at = at;
	const span = isWide(d.id) ? { w: 1, h: 1 } : placed.get(d.id) || { w: 1, h: 1 };
	d.target.style.gridColumn = `${at.col} / span ${span.w}`;
	d.target.style.gridRow = `${at.row} / span ${span.h}`;
}

function end(e) {
	const d = drag;
	if (!d || e.pointerId !== d.pointer) return;
	window.removeEventListener("pointermove", move);
	window.removeEventListener("pointerup", end);
	window.removeEventListener("pointercancel", end);
	drag = null;
	if (!d.started) return;
	d.ghost.remove();
	d.target?.remove();
	d.tile.classList.remove("tl-lifted");
	if (e.type === "pointerup" && d.at) keep(d.id, d.at);
	else draw();
}

// ---------------------------------------------------------------------------------------------------- the page

export async function render() {
	if (!root || drag?.started) return;
	try {
		const v = await invoke("tiles_get");
		specs = v.tiles || [];
		layout = { positions: v.layout?.positions || {}, sizes: v.layout?.sizes || {}, removed: v.layout?.removed || [], center: !!v.layout?.center, gap: v.layout?.gap ?? null };
		gap = layout.gap ?? GAP;
	} catch (_) {}
	draw();
}

/** the width the island's hub has, so that the grid here is the grid there */
export function setHubWidth(w) {
	hubWidth = Number(w) || 420;
	if (root && specs.length) draw();
}

export function initTilesEditor(box) {
	root = box;
	listen("tiles-changed", render);
	listen("plugins-changed", render);
	render();
}

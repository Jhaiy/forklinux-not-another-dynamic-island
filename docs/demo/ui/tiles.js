// The tiles of the open island: a grid of squares, one for each plugin that has a tile (a phone's widgets). A tile is always
// there while its plugin is on, whether or not anything is going on, and goes only when the user takes it out. Its face says what
// the plugin is doing: from the plugin's first card (the `glance` of it, or its title and its second line), or, with no card, what
// the plugin says it does while idle. Pressing a tile takes the place of the notifications under the grid with the plugin's
// cards (the same cards as ever: they open, and they are dragged out to float, from there); pressing it again brings the
// notifications back. The tiles are not dragged out themselves.
//
// The island only shows them: the user arranges them (where each one is, its size, which to take out) in the settings window
// (tilesedit.js), and the grid is laid out by the same rule there (tilegrid.js).

import { call, el, host, invoke, li, listen } from "./kit.js";
import { drawInto } from "./plugins/surface.js";
import { centered, solve } from "./tilegrid.js";

const grid = document.getElementById("tiles");
const area = document.getElementById("tile-area");
const pageEl = document.getElementById("now-cards");

let specs = []; // [{ id, name, icon, tint, sizes, idle, widget }] of the plugins that are on and have a tile
let layout = { positions: {}, sizes: {}, removed: [], center: false, gap: null };
let cards = []; // the cards of the moment (elements), as main.js builds them
let openId = null;
let lastPageSig = "";
const nodes = new Map(); // tile id -> its element
const faceSig = new Map(); // tile id -> what its face was drawn from

const GAP = 6; // (the standard gap between the tiles: the user can choose another)
let gap = GAP;
const WANT = 44; // the size a square is wanted at

/** the tile a card belongs to: its plugin's, or its bundle's (`claude-sessions` is a part of `claude`) */
const ownerOf = (plugin) => specs.find((s) => s.id === plugin || plugin.startsWith(`${s.id}-`))?.id || null;

/** the tiles to show, in the user's order: the ones the plugins have, and one for a plugin that has cards but no tile of its own */
function visibleSpecs() {
	const all = [...specs];
	for (const c of cards) {
		const d = c._data;
		if (d && !ownerOf(d.plugin) && !all.some((s) => s.id === d.plugin)) all.push({ id: d.plugin, name: d.name || d.plugin, icon: d.icon || "dot", tint: "", sizes: ["small"], start: "small", idle: "", widget: "", derived: true });
	}
	return all.filter((s) => !layout.removed.includes(s.id));
}

const sizeOf = (s) => (layout.sizes[s.id] && s.sizes.includes(layout.sizes[s.id]) ? layout.sizes[s.id] : s.start || s.sizes[0]);
const cardsOf = (id) => cards.filter((c) => c._data && (ownerOf(c._data.plugin) === id || c._data.plugin === id));

// ------------------------------------------------------------------------------------------------------------- the faces
//
// No icon in a corner: what a tile is about is the picture behind its words. The picture is the icon of the program or the cover
// of what is playing (the card's `image`), blown up and frosted; a plugin with none is its own colour with its glyph, large.
// A dark gradient from the bottom sits between the picture and the words, so any icon is readable. With nothing going on the
// picture goes: plain glass, and the glyph large and faint. Selected, the picture sharpens, a ring in its own colour goes round the
// tile, and the others dim (hub.css).

const TONES = { waiting: "#e8963c", working: "#4f8ff0", finished: "#5ac88c" };

function caption(text) {
	return el("div", "tl-cap", text || "");
}

const dominants = new Map(); // a picture -> the colour that is most of it

/** the colour that is most of a picture (its ring): the average of a few pixels, weighted by how colourful they are */
function dominant(src) {
	if (!dominants.has(src)) {
		dominants.set(
			src,
			new Promise((resolve) => {
				const img = new Image();
				img.onload = () => {
					try {
						const c = document.createElement("canvas");
						c.width = c.height = 8;
						const g = c.getContext("2d", { willReadFrequently: true });
						g.drawImage(img, 0, 0, 8, 8);
						const px = g.getImageData(0, 0, 8, 8).data;
						let r = 0;
						let gr = 0;
						let b = 0;
						let w = 0;
						for (let i = 0; i < px.length; i += 4) {
							if (px[i + 3] < 40) continue;
							const hi = Math.max(px[i], px[i + 1], px[i + 2]);
							const lo = Math.min(px[i], px[i + 1], px[i + 2]);
							const k = 0.2 + (hi - lo) / 255 + hi / 600;
							r += px[i] * k;
							gr += px[i + 1] * k;
							b += px[i + 2] * k;
							w += k;
						}
						if (!w) return resolve(null);
						// (lifted a little, so that the ring is seen on the dark)
						const lift = (v) => Math.min(255, Math.round((v / w) * 1.15 + 18));
						resolve(`rgb(${lift(r)}, ${lift(gr)}, ${lift(b)})`);
					} catch (_) {
						resolve(null);
					}
				};
				img.onerror = () => resolve(null);
				img.src = src;
			}),
		);
	}
	return dominants.get(src);
}

/** the flat colour of a tile from the colour of its picture: the same hue, dark enough for the words */
function flat(rgb) {
	const [r, g, b] = rgb.match(/\d+/g).map((v) => Number(v) / 255);
	const hi = Math.max(r, g, b);
	const lo = Math.min(r, g, b);
	const l = (hi + lo) / 2;
	const d = hi - lo;
	let h = 0;
	if (d) h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
	const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
	return `hsl(${Math.round(((h * 60 + 360) % 360))}, ${Math.round(Math.min(0.75, sat * 0.9) * 100)}%, 26%)`;
}

/** the weekday and the day of the month, as a block (a tile whose plugin has a date for a face) */
function dateBlock() {
	const now = new Date();
	const b = el("div", "tl-date");
	b.append(el("div", "tl-dow", now.toLocaleDateString([], { weekday: "short" }).toUpperCase()), el("div", "tl-day", String(now.getDate())));
	return b;
}

/** what the face of a tile is made from: when it changes, the face is drawn again */
function sigOf(spec, size, list) {
	const d = list[0]?._data;
	return [size, list.length, d?.title, d?.sub, d?.image ? d.image.length : 0, spec.picture ? spec.picture.length : 0, d?.tone, d?.glance?.big, d?.glance?.caption, d?.peek, (d?.controls || []).map((x) => `${x.icon}`).join("|"), spec.idle, spec.look === "date" ? new Date().getDate() : "", openId === spec.id].join("~");
}

/** the rings of a widget (System meters) the way a tile has them: the number inside, the label under */
function ringsForTile(box) {
	for (const r of box.querySelectorAll(".sf-ring")) {
		const b = r.querySelector("b");
		if (b && r.dataset.part) {
			b.textContent = r.dataset.part;
			r.append(el("em", null, r.dataset.label || ""));
		}
	}
}

/** a ring that is filled `pct` of the way round, a glyph in the middle of it */
function progress(pct, icon) {
	const wrap = el("span", "tl-ring");
	wrap.innerHTML = `<svg class="tr" viewBox="0 0 32 32" aria-hidden="true"><circle class="tr-track" cx="16" cy="16" r="13" pathLength="100"/><circle class="tr-arc" cx="16" cy="16" r="13" pathLength="100" stroke-dasharray="${pct} 100"/></svg>${icon ? li(icon) : ""}`;
	return wrap;
}

function controlsRow(d) {
	const row = el("div", "tl-controls");
	for (const x of d.controls) {
		const b = el("button", `tl-btn${x.icon === "pause" || x.icon === "play" ? " main" : ""}`);
		b.type = "button";
		b.innerHTML = li(x.icon || "dot");
		b.setAttribute("aria-label", x.label || x.action);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			call(d.plugin, x.action).catch(() => {});
		});
		b.addEventListener("pointerdown", (e) => e.stopPropagation());
		row.append(b);
	}
	return row;
}

/** how full a water tile is (0..100), or null when the tile is not one that is filling: the percent of a download, full when done, a third while it has no percent */
function waterLevel(spec, d, size) {
	if (spec.look !== "water" || !d || size !== "small") return null;
	if (d.tone === "finished" || d.glance?.caption === "done") return 100;
	const m = /^(\d{1,3})%$/.exec(d.glance?.big || "");
	return m ? Math.min(100, Number(m[1])) : 35;
}

/** water: a body and two waves on top of it, going the other way round, all in the colour of the tile (the waves are drawn twice as wide as the tile and slide by a half, so they never end) */
function waterNode() {
	const w = el("div", "tl-water");
	const wave = `<svg viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 6 Q25 0 50 6 T100 6 T150 6 T200 6 V12 H0Z"/></svg>`;
	w.innerHTML = `<div class="tw-body"><span class="tw-wave a">${wave}</span><span class="tw-wave b">${wave}</span></div>`;
	return w;
}

function paintFace(node, spec, size, list) {
	const d = list[0]?._data;
	const tint = spec.tint || "#8e8e96";
	node.dataset.size = size;
	node.style.setProperty("--c", tint);
	node.style.setProperty("--ring", tint);

	// (water that is already filling only rises: it is not drawn again, or its waves would start over at every percent)
	const level = waterLevel(spec, d, size);
	const filling = node.querySelector(":scope > .tl-clip > .tl-water");
	if (level !== null && filling) {
		filling.style.setProperty("--lv", String(level));
		node.querySelector(".tl-solo .tl-ic").innerHTML = li(level === 100 ? "check" : spec.icon || "dot");
		node.dataset.tip = `${spec.name}
${d.glance?.big ? `${d.glance.big} ${d.glance.caption || ""}` : d.title || d.sub || ""}`.trim();
		return;
	}

	// the content, by size
	const face = el("div", "tl-face");
	let active = !!d;
	const widget = el("div", "tl-widget");
	const drawn = !!spec.widget && size !== "small" && drawInto(widget, spec.id, spec.widget);
	if (drawn) {
		ringsForTile(widget);
		active = true;
	}
	if (size === "small") {
		// (too small for words: a number or a percent, else the picture, else the glyph of the plugin; its name and what it says are the tooltip)
		const solo = el("div", "tl-solo");
		const big = d?.glance?.big;
		if (level !== null) {
			// (water, and the glyph over it)
			const ic = el("span", "tl-ic");
			ic.innerHTML = li(level === 100 ? "check" : spec.icon || "dot");
			solo.append(ic);
		} else if (spec.look === "status" && d) {
			// (a status tile says what the plugin is up to, not how many: working, waiting for the user, or done)
			const tone = d.tone || "working";
			node.dataset.state = tone;
			// (the plugin is always to be told: its picture, or its glyph where it has none; the state is on top of it)
			if (!(d.image || spec.picture)) {
				const ic = el("span", "tl-ic");
				ic.innerHTML = li(spec.icon || "dot");
				solo.append(ic);
			}
			if (tone === "working") {
				const dots = el("span", "tl-dots");
				dots.append(el("i"), el("i"), el("i"));
				solo.append(dots);
			} else if (tone === "finished") {
				const ok = el("span", "tl-ok badge");
				ok.innerHTML = li("check");
				solo.append(ok);
			}
		} else if (d && (d.tone === "finished" || d.glance?.caption === "done")) {
			// (nothing is going on any more: done)
			const ok = el("span", "tl-ok");
			ok.innerHTML = li("check");
			solo.append(ok);
		} else if (d && /^\d{1,3}%$/.test(big || "")) {
			// (a percent is a ring that fills, with the glyph in it)
			solo.append(progress(Math.min(100, parseInt(big, 10)), d.image || spec.picture ? "" : spec.icon));
		} else if (d) {
			// (something is going on, and there is no way to say how far: the glyph, or the picture, with a small bar under it that breathes)
			if (!(d.image || spec.picture)) {
				const ic = el("span", "tl-ic");
				ic.innerHTML = li(spec.icon || "dot");
				solo.append(ic);
			}
			solo.append(el("span", "tl-live"));
		} else if (!(d && (d.image || spec.picture))) {
			const ic = el("span", "tl-ic");
			ic.innerHTML = li(spec.icon || "dot");
			solo.append(ic);
		}
		face.append(solo);
		node.dataset.tip = `${spec.name}
${(d ? (big ? `${big} ${d.glance.caption || ""}` : d.title || d.sub) : spec.idle) || ""}`.trim();
	} else if (size === "wide") {
		face.classList.add("tl-row");
		if (spec.look === "date") face.append(dateBlock());
		const mid = el("div", "tl-mid");
		if (drawn) {
			mid.classList.add("has-widget");
			mid.append(widget);
		} else if (d) {
			mid.append(el("div", "tl-nm", d.title || spec.name), caption(d.sub));
		} else {
			mid.append(el("div", "tl-nm", spec.name), caption(spec.idle));
		}
		face.append(mid);
		const right = el("div", "tl-right");
		if (d?.glance?.big) right.append(el("div", "tl-big tl-small", d.glance.big));
		else if (d?.peek) right.append(caption(d.peek));
		if (right.firstChild) face.append(right);
	} else {
		// large: what is playing: its cover is the whole tile, with the words and the buttons under
		const bot = el("div", "tl-bot");
		if (d) {
			bot.append(el("div", "tl-nm tl-lg", d.title || spec.name), caption(d.sub));
			if (d.controls?.length) bot.append(controlsRow(d));
		} else if (drawn) {
			bot.append(widget);
		} else {
			bot.append(el("div", "tl-nm tl-lg", spec.name), caption(spec.idle));
		}
		face.append(bot);
		if (d?.controls?.some((x) => x.icon === "pause")) {
			const eq = el("span", "tl-eq");
			eq.append(el("i"), el("i"), el("i"));
			face.append(eq);
		}
	}

	// the picture behind it: the card's (the icon of a program, a cover), or the plugin's own while something is going on; a tile with
	// none is bare, no background at all
	const src = d ? d.image || spec.picture || "" : "";
	const clip = el("div", "tl-clip");
	node.classList.toggle("tl-wet", level !== null);
	if (level !== null) {
		const w = waterNode();
		w.style.setProperty("--lv", "0");
		clip.append(w);
		// (rises from empty to the level, once it is in the page)
		requestAnimationFrame(() => requestAnimationFrame(() => w.style.setProperty("--lv", String(level))));
	}
	if (src) {
		const art = el("div", `tl-art ${size === "large" ? "cover" : "pic"}${d.image ? "" : " icon"}`);
		art.style.backgroundImage = `url("${src}")`;
		clip.append(art, el("div", "tl-scrim"));
		dominant(src).then((c) => {
			if (!c) return;
			node.style.setProperty("--ring", c);
			node.style.setProperty("--fill", flat(c));
		});
	}
	node.classList.toggle("tl-idle", !active);
	node.classList.toggle("tl-pic", !!src);
	node.classList.toggle("tl-bare", active && !src);
	node.classList.toggle("tl-alert", d?.tone === "waiting");
	node.replaceChildren(clip, face);
}

// ------------------------------------------------------------------------------------------------------------- the grid

let cols = 4;

function measure() {
	const w = grid.clientWidth;
	if (!w) return;
	// (as many columns as fit squares of about 90 px: a wider island has more of them, a narrower one fewer; the squares grow to fill)
	cols = Math.max(2, Math.floor((w + gap) / (WANT + gap)));
	grid.style.setProperty("--cols", String(cols));
	grid.style.setProperty("--gap", `${gap}px`);
	grid.style.setProperty("--tile", `${Math.floor((w - gap * (cols - 1)) / cols)}px`);
}

function tileNode(spec) {
	let node = nodes.get(spec.id);
	if (!node) {
		node = el("div", "tl");
		node.dataset.id = spec.id;
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.addEventListener("click", () => toggle(spec.id));
		node.addEventListener("keydown", (e) => {
			if (e.target === node && (e.key === "Enter" || e.key === " ")) {
				e.preventDefault();
				toggle(spec.id);
			}
		});
		nodes.set(spec.id, node);
	}
	return node;
}

function render() {
	const list = visibleSpecs();
	const have = new Set(list.map((s) => s.id));
	for (const [id, n] of nodes) {
		if (!have.has(id)) {
			n.remove();
			nodes.delete(id);
			faceSig.delete(id);
		}
	}
	// (each where the user put it; the ones with no place, or whose place is gone, take the first free one)
	let placed = solve(
		list.map((s) => ({ id: s.id, size: sizeOf(s), pos: layout.positions[s.id] })),
		cols,
	);
	// (with room at the sides, a row is put in the middle if the user wants that: they are the same places, moved)
	if (layout.center) placed = centered(placed, cols);
	const ordered = [];
	for (const spec of list) {
		const node = tileNode(spec);
		const size = sizeOf(spec);
		const mine = cardsOf(spec.id);
		const sig = sigOf(spec, size, mine) + (spec.widget ? `~${Date.now() >> 10}` : "");
		const at = placed.get(spec.id);
		node.classList.remove("tl-small", "tl-wide", "tl-large");
		node.removeAttribute("data-tip");
		node.removeAttribute("data-state");
		node.classList.add(`tl-${size}`);
		node.style.gridColumn = `${at.col} / span ${at.w}`;
		node.style.gridRow = `${at.row} / span ${at.h}`;
		// (half a column: half a tile and half a gap to the right)
		node.style.left = at.half ? "calc((var(--tile) + var(--gap)) / 2)" : "";
		node.classList.toggle("tl-static", !selectable(spec.id));
		node.tabIndex = selectable(spec.id) ? 0 : -1;
		node.setAttribute("aria-disabled", String(!selectable(spec.id)));
		node.setAttribute("aria-label", `${spec.name}${mine[0]?._data?.sub ? `, ${mine[0]._data.sub}` : ""}`);
		if (faceSig.get(spec.id) !== sig) {
			faceSig.set(spec.id, sig);
			paintFace(node, spec, size, mine);
		}
		ordered.push(node);
	}
	// (the tile that is open has nothing to show any more: it is closed)
	if (openId && !selectable(openId)) {
		openId = null;
		lastPageSig = "";
	}
	for (const [id, n] of nodes) {
		n.classList.toggle("tl-sel", openId === id);
		n.setAttribute("aria-pressed", String(openId === id));
	}
	// (put in order without making them again: a press is never lost to a rebuild)
	if (ordered.some((n, i) => grid.children[i] !== n) || grid.children.length !== ordered.length) grid.replaceChildren(...ordered);
	grid.classList.toggle("hidden", !ordered.length);
	grid.classList.toggle("has-sel", !!openId);
	renderArea();
	host.scheduleHubHeight();
}

// ------------------------------------------------------------------------------------------------------------- the area under the grid

/** a tile has a page to show when its plugin has a card: the others are not pressed */
const selectable = (id) => cardsOf(id).length > 0;

function toggle(id) {
	if (openId === id) close();
	else if (selectable(id)) open(id);
}

function open(id) {
	openId = id;
	lastPageSig = "";
	render();
	// (the page is under the grid: bring it into view)
	requestAnimationFrame(() => area.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

function close() {
	openId = null;
	lastPageSig = "";
	render();
}

function renderArea() {
	const spec = openId && visibleSpecs().find((s) => s.id === openId);
	if (openId && !spec) openId = null;
	area.classList.toggle("paged", !!openId);
	pageEl.classList.toggle("hidden", !openId);
	// (the page has the colour of its tile)
	area.style.setProperty("--pg", (openId && nodes.get(openId)?.style.getPropertyValue("--ring")) || "#8e8e96");
	if (!openId) {
		pageEl.replaceChildren();
		return;
	}
	const mine = cardsOf(spec.id);
	const sig = mine.map((c) => c._sig ?? c.outerHTML).join("");
	if (sig !== lastPageSig) {
		lastPageSig = sig;
		for (const c of mine) c.classList.add("open");
		pageEl.replaceChildren(...(mine.length ? mine : [el("div", "tl-empty", spec.idle ? `${spec.name}: ${spec.idle}` : "Nothing here yet")]));
	} else {
		// same cards, new numbers: in place
		mine.forEach((c, i) => {
			const old = pageEl.children[i];
			if (old && old._update && c._data) old._update(c._data);
		});
	}
}

// ------------------------------------------------------------------------------------------------------------- the island's side

async function load() {
	try {
		const v = await invoke("tiles_get");
		specs = v.tiles || [];
		layout = { positions: v.layout?.positions || {}, sizes: v.layout?.sizes || {}, removed: v.layout?.removed || [], center: !!v.layout?.center, gap: v.layout?.gap ?? null };
		gap = layout.gap ?? GAP;
		measure();
	} catch (_) {}
	render();
}

/** the cards of the moment (main.js builds them): the tiles' faces and the open page follow */
export function update(list) {
	cards = list;
	render();
}

export const hasTiles = () => visibleSpecs().length > 0;

export function initTiles() {
	new ResizeObserver(measure).observe(grid);
	measure();
	listen("tiles-changed", load);
	listen("plugins-changed", load);
	// (the hub closes: the notifications are what it opens on)
	listen("view-tick", (e) => {
		if (e.payload !== "hub" && openId) {
			openId = null;
			lastPageSig = "";
			renderArea();
		}
	});
	load();
}

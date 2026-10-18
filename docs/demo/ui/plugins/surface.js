// What a module draws outside its card: the widgets it offers for the head, and its pane (a view that replaces the cards). It
// sends blocks, never markup (see plugins.rs `clean_blocks`); this file draws them, and a press on one comes back to the module
// as an `action` event ("widget" or "pane", with the id the block named). The Calendar plugin's date and month are drawn here.
import { head } from "../head.js";
import { FLOATS, call, el, host, invoke, li, listen, view, withIcon } from "../kit.js";

const state = new Map(); // plugin -> { widgets: { id: { blocks, tip } }, pane }
const widgetEls = new Map(); // "plugin:id" -> the element the head holds for it
const clocks = new Set(); // { node, kind, h24 }: the time and the date, kept ticking here (a module is not called for it)
const paneEl = () => document.getElementById("pane-plugin");
let paneOwner = null;
let lastDir = 0;

function tickClocks() {
	const now = new Date();
	for (const c of clocks) {
		const text =
			c.kind === "time"
				? now.toLocaleTimeString([], c.h24 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "numeric", minute: "2-digit" })
				: now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
		if (c.node.textContent !== text) c.node.textContent = text;
	}
}

const press = (plugin, where, id, extra = {}) => call(plugin, where, { id, ...extra }).catch(() => {});

/** draw a set of blocks into `box` (what it held is replaced). `where`: "widget" or "pane", what a press is called */
function draw(box, blocks, plugin, where) {
	for (const c of box._clocks || []) clocks.delete(c);
	box._clocks = [];
	box.textContent = "";
	for (const b of blocks || []) {
		if (b.text != null) {
			box.append(el("div", `sf-text ${b.kind || ""}`.trim(), b.text));
		} else if (b.clock) {
			const node = el("span", b.clock === "time" ? "hw-time" : "hw-date");
			const c = { node, kind: b.clock, h24: !!b.h24 };
			clocks.add(c);
			box._clocks.push(c);
			box.append(node);
		} else if (b.bar != null) {
			const line = el("div", "sf-text");
			const bar = el("span", "sf-bar");
			bar.append(el("i"));
			bar.firstChild.style.width = `${Math.round(b.bar * 100)}%`;
			line.append(bar);
			if (b.text) line.append(el("span", null, ` ${b.text}`));
			box.append(line);
		} else if (b.bars) {
			// (in a tooltip they are wide, with the number at the right; in a widget they are the thin stacked bars)
			const wide = box.classList.contains("sf-tip");
			const list = el("div", wide ? "sf-meters" : "sm-bars");
			for (const x of b.bars) {
				const row = el("div", wide ? "sf-meter" : "sm-row");
				const track = el("i");
				const fill = el("u");
				fill.style.width = `${Math.round(x.part * 100)}%`;
				fill.style.background = x.color;
				track.append(fill);
				row.append(el("b", null, x.label), track);
				if (wide) row.append(el("span", null, x.text));
				// (a few words under the bar, so the number at its right keeps its room)
				if (wide && x.sub) row.append(el("em", null, x.sub));
				list.append(row);
			}
			box.append(list);
		} else if (b.rings) {
			// (the same meters as the bars, as circles: the label inside, the share around it)
			const list = el("div", "sf-rings");
			for (const x of b.rings) {
				const c = 2 * Math.PI * 9;
				const ring = el("span", "sf-ring");
				ring.dataset.tip = x.text ? `${x.label} · ${x.text}` : x.label;
				ring.dataset.part = String(Math.round(x.part * 100));
				ring.dataset.label = x.label;
				ring.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="3"/><circle cx="12" cy="12" r="9" fill="none" stroke="${x.color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(c * x.part).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 12 12)"/></svg>`;
				ring.append(el("b", null, x.label));
				list.append(ring);
			}
			box.append(list);
		} else if (b.head != null) {
			const row = el("div", "sf-head");
			const mk = (cls, id, label, d) => {
				const x = el("button", cls);
				x.type = "button";
				x.setAttribute("aria-label", label);
				x.innerHTML = d ? `<svg viewBox="0 0 16 16"><path d="${d}" /></svg>` : "";
				x.addEventListener("click", () => {
					lastDir = cls === "sf-prev" ? -1 : cls === "sf-next" ? 1 : 0;
					press(plugin, where, id);
				});
				return x;
			};
			const prev = mk("sf-prev", b.prev, "Previous", "M10 3.5 5.5 8l4.5 4.5");
			const next = mk("sf-next", b.next, "Next", "M6 3.5 10.5 8 6 12.5");
			if (!b.prev) prev.style.visibility = "hidden";
			if (!b.next) next.style.visibility = "hidden";
			const title = mk("sf-title", b.press, b.head, null);
			title.textContent = b.head;
			if (!b.press) title.style.pointerEvents = "none";
			row.append(prev, title, next);
			box.append(row);
		} else if (b.grid) {
			const week = el("div", "sf-week");
			for (const l of b.grid.labels) week.append(el("span", null, l));
			const grid = el("div", "sf-grid");
			for (const c of b.grid.cells) {
				const day = el("button", `cal-day ${c.state || ""}`.trim());
				day.type = "button";
				const dots = el("span", "cal-dots");
				for (let i = 0; i < c.dots; i++) dots.append(el("i"));
				day.append(el("span", null, c.t), dots);
				day.addEventListener("click", () => press(plugin, where, c.id));
				grid.append(day);
			}
			box.append(week, grid);
			const key = box.querySelector(".sf-title")?.textContent || "";
			if (lastDir && box._title && box._title !== key) {
				grid.classList.add(lastDir > 0 ? "slide-next" : "slide-prev");
			}
			box._title = key;
			lastDir = 0;
		} else if (b.rows) {
			if (!b.rows.length) {
				if (b.empty) box.append(el("div", "notif-history-empty", b.empty));
				continue;
			}
			const list = el("div", "sf-rows flat");
			b.rows.forEach((r, i) => {
				const row = el("div", `cal-event spot fresh${r.past ? " past" : ""}`);
				row.style.setProperty("--i", i);
				row.append(el("div", "cal-event-title", r.title));
				if (r.time || r.sub) {
					const t = el("div", "cal-event-time");
					withIcon(t, "clock", [r.time, r.sub].filter(Boolean).join(" · "));
					row.append(t);
				}
				list.append(row);
			});
			box.append(list);
		} else if (b.item) {
			// a picture or an icon, and a line of words (a song, a download)
			const row = el("span", "sf-item");
			const tile = el("span", "sf-tile");
			if (b.item.tile) {
				const img = document.createElement("img");
				img.src = b.item.tile;
				img.alt = "";
				tile.append(img);
			} else tile.innerHTML = li(b.item.icon || "dot");
			const words = el("span", "sf-words");
			words.append(el("b", null, b.item.text));
			if (b.item.sub) words.append(el("small", null, b.item.sub));
			row.append(tile, words);
			box.append(row);
		} else if (b.icon_button) {
			const x = el("button", "sf-ibtn");
			x.type = "button";
			x.innerHTML = li(b.icon_button.icon || "dot");
			if (b.icon_button.label) x.setAttribute("aria-label", b.icon_button.label);
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				press(plugin, where, b.icon_button.press);
			});
			box.append(x);
		} else if (b.buttons) {
			const row = el("div", "sf-buttons");
			for (const x of b.buttons) {
				const btn = el("button", "set-btn", x.label);
				btn.type = "button";
				btn.addEventListener("click", () => press(plugin, where, x.id));
				row.append(btn);
			}
			box.append(row);
		}
	}
	tickClocks();
}

// ------------------------------------------------------------------------------------------------------- widgets

/** the same bars as before, only their numbers changed: they move to them (a fresh drawing would jump) */
function moveBars(node, blocks) {
	const have = node.querySelector(".sm-bars");
	const want = blocks.length === 1 && blocks[0].bars;
	if (!have || !want || have.children.length !== want.length) return false;
	want.forEach((x, i) => {
		const row = have.children[i];
		if (row.firstChild.textContent !== x.label) return;
		const fill = row.querySelector("u");
		fill.style.width = `${Math.round(x.part * 100)}%`;
		fill.style.background = x.color;
	});
	return true;
}

/** draw what a widget of a plugin shows now into `box` (a tile's face): false when it shows nothing yet. `ref`: "widget" or "plugin:widget" */
export function drawInto(box, plugin, ref) {
	let at = plugin;
	let id = ref;
	if (ref.includes(":")) [at, id] = ref.split(":");
	const blocks = state.get(at)?.widgets?.[id]?.blocks || [];
	if (!blocks.length) return false;
	draw(box, blocks, at, "widget");
	return true;
}

function paint(plugin, id) {
	const node = widgetEls.get(`${plugin}:${id}`);
	if (!node) return;
	const w = state.get(plugin)?.widgets?.[id];
	const blocks = w?.blocks || [];
	// (a clock is a button with a hover of its own; anything else is plain)
	node.className = blocks.some((b) => b.clock) ? "hw-clock" : "hw-surface";
	if (!moveBars(node, blocks)) draw(node, blocks, plugin, "widget");
	node._tip = w?.tip || [];
	host.refreshTip(node);
}

function register(plugin, spec) {
	const key = `${plugin}:${spec.id}`;
	head.register({
		id: key,
		plugin,
		name: spec.name || spec.id,
		place: spec.place || "right",
		rank: spec.rank || 50,
		width: spec.width || 80,
		interactive: !!spec.interactive,
		start: spec.start !== false,
		// (a still picture for the tray: what it shows now, or its name)
		preview: () => {
			const pic = el("span", "still-clock");
			const w = state.get(plugin)?.widgets?.[spec.id];
			if (w?.blocks?.length) draw(pic, w.blocks, plugin, "widget");
			else pic.append(el("span", "still-date", spec.name || spec.id));
			return pic;
		},
		build: () => {
			let node = widgetEls.get(key);
			if (node) return node;
			node = el("button", "hw-clock");
			node.type = "button";
			if (spec.interactive) {
				node.addEventListener("click", () => press(plugin, "widget", spec.id, { pane_open: paneOwner === plugin && host.pane() === "plugin" }));
			} else {
				node.style.cursor = "default";
			}
			host.setTip(node, () => {
				if (!node._tip?.length) return "";
				const box = el("div", "sf-tip");
				draw(box, node._tip, plugin, "widget");
				return box;
			});
			widgetEls.set(key, node);
			paint(plugin, spec.id);
			return node;
		},
	});
}

async function sync() {
	let listing;
	try {
		listing = await invoke("plugin_list");
	} catch (_) {
		return;
	}
	for (const p of listing?.plugins || []) for (const w of p.widgets || []) register(p.id, w);
}

// ---------------------------------------------------------------------------------------------------------- pane

function setPane(plugin, pane, open) {
	const box = paneEl();
	if (!box) return;
	if (!pane) {
		if (paneOwner === plugin) {
			paneOwner = null;
			if (host.pane() === "plugin") host.setPane("info");
			box.textContent = "";
		}
		return;
	}
	if (paneOwner && paneOwner !== plugin && !open) return;
	paneOwner = plugin;
	draw(box, pane.blocks, plugin, "pane");
	if (open || pane.open) host.setPane("plugin");
}

function take(plugin, s) {
	state.set(plugin, { widgets: s.widgets || {}, pane: s.pane || null });
	for (const id of Object.keys(s.widgets || {})) paint(plugin, id);
	// (what a widget showed is gone with it: its element is drawn empty)
	for (const key of widgetEls.keys()) {
		const [pl, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
		if (pl === plugin && !(id in (s.widgets || {}))) paint(plugin, id);
	}
}

export default {
	id: "surface",
	init() {
		if (FLOATS) return;
		paneEl()?.addEventListener("mousedown", (e) => e.stopPropagation());
		listen("plugin-surface", (e) => {
			const { plugin, widgets, pane, open } = e.payload;
			take(plugin, { widgets, pane });
			setPane(plugin, pane, open);
		});
		listen("plugins-changed", sync);
		sync();
		invoke("plugin_surface")
			.then((all) => {
				for (const [plugin, s] of Object.entries(all || {})) {
					take(plugin, s);
					setPane(plugin, s.pane, false);
				}
			})
			.catch(() => {});
		setInterval(() => {
			if (view.name === "hub") tickClocks();
		}, 1000);
	},
	hubOpened() {
		tickClocks();
	},
	cards() {
		return [];
	},
};

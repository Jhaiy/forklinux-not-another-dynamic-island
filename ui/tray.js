// The tray: the widgets the plugins offer, by plugin, for the editors of the settings window (the expanded island's head.js,
// the resting island's restedit.js). A group folds (the first two start open), a search cuts it down, and what is in use
// already can be hidden. It keeps one height and scrolls inside itself, however many widgets there are. A tile is
// picked up by the editor's own pointer handlers (it carries `data-id`); pressing it, with no mouse to drag, is `onPress`.

import { el, li } from "./kit.js";

const folded = new Map(); // plugin id -> true/false, once the user has folded or opened it
let query = "";
let scroll = 0;
let hideUsed = false;
try {
	hideUsed = localStorage.getItem("nadi.trayHideUsed") === "1";
	for (const k of JSON.parse(localStorage.getItem("nadi.trayFolded") || "[]")) folded.set(k[0], k[1]);
} catch (_) {}
const keep = () => {
	try {
		localStorage.setItem("nadi.trayHideUsed", hideUsed ? "1" : "0");
		localStorage.setItem("nadi.trayFolded", JSON.stringify([...folded]));
	} catch (_) {}
};

/** a group opens (so that the tile of a widget just picked up from it is still there to see); `name`: its plugin's name */
export function openGroup(name) {
	folded.set(name, false);
	keep();
}

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

/**
 * Make a tray. `list()`: the widgets on offer, in order ([{ id, name, plugin, preview? }], `preview()` makes a still
 * picture); `used()`: the ids that are in a place now; `plugins()`: id -> name; `onPress(id)`. The element has `fill()`:
 * call it when any of that changed.
 */
export function makeTray({ list, used, plugins, onPress, wasJustDragged = () => false }) {
	const box = el("div", "hh-tray");
	const top = el("div", "hh-tray-h");
	top.append(el("span", "hh-tray-l", "Widgets"));
	const search = el("label", "hh-search");
	search.innerHTML = li("search");
	const input = el("input");
	input.type = "search";
	input.placeholder = "Search Widgets";
	input.value = query;
	input.setAttribute("aria-label", "Search widgets");
	input.addEventListener("input", () => {
		query = input.value;
		fill();
	});
	search.append(input);
	const hide = el("button", "hh-switch");
	hide.type = "button";
	hide.setAttribute("aria-pressed", String(hideUsed));
	hide.append(el("i"), document.createTextNode("Hide in Use"));
	hide.addEventListener("click", () => {
		hideUsed = !hideUsed;
		hide.setAttribute("aria-pressed", String(hideUsed));
		keep();
		fill();
	});
	top.append(search, hide);
	const body = el("div", "hh-tray-body");
	const fade = () => box.classList.toggle("hh-more", body.scrollHeight - body.clientHeight - body.scrollTop > 4);
	body.addEventListener(
		"scroll",
		() => {
			scroll = body.scrollTop;
			fade();
		},
		{ passive: true },
	);
	box.append(top, body);

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
		if (inUse) t.append(el("span", "hh-tile-tag", "In Use"));
		t.addEventListener("click", () => {
			if (inUse || wasJustDragged()) return;
			onPress(w.id);
		});
		return t;
	}

	function fill() {
		const inUse = used();
		const names = plugins();
		const q = query.trim().toLowerCase();
		const groups = new Map(); // plugin id -> { name, all, shown }
		for (const w of list()) {
			// (the parts of one plugin that is made of several are one group: they share its name)
			const key = names.get(w.plugin) || w.plugin || "Other";
			if (!groups.has(key)) groups.set(key, { name: key, all: 0, shown: [] });
			const g = groups.get(key);
			g.all++;
			if (q && !w.name.toLowerCase().includes(q) && !g.name.toLowerCase().includes(q)) continue;
			if (hideUsed && inUse.has(w.id)) continue;
			g.shown.push(w);
		}
		const out = [];
		let n = 0;
		for (const [key, g] of groups) {
			const index = n++;
			if (!g.shown.length) continue;
			// (a search shows what it found: every group that has something is open)
			const open = q ? true : !(folded.has(key) ? folded.get(key) : index >= 2);
			const head = el("button", `hh-tray-gh${open ? " open" : ""}`);
			head.type = "button";
			head.setAttribute("aria-expanded", String(open));
			head.innerHTML = li("chevron");
			head.append(el("span", "hh-tray-n", g.name), el("span", "hh-tray-c", g.shown.length === g.all ? String(g.all) : `${g.shown.length} of ${g.all}`));
			head.addEventListener("click", () => {
				folded.set(key, open);
				keep();
				fill();
			});
			out.push(head);
			if (!open) continue;
			const tiles = el("div", "hh-tiles");
			for (const w of g.shown) tiles.append(tile(w, inUse.has(w.id), q));
			out.push(tiles);
		}
		if (!out.length) out.push(el("div", "hh-tray-none", groups.size ? "No widget has that name" : "No widgets yet: turn a plugin on"));
		body.replaceChildren(...out);
		body.scrollTop = scroll;
		fade();
	}
	box.fill = fill;
	fill();
	// (the editor lays itself out again at each move: the tray keeps where it was scrolled to)
	requestAnimationFrame(() => {
		body.scrollTop = scroll;
		fade();
	});
	return box;
}

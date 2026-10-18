// The resting island: what the collapsed island shows when nothing else does. It is always three sections, left, center and
// right, with one widget in each (the widgets of the head, the same elements: head.js hands them over).
//
// Whose island it is: the user's own (what they chose in Settings > Island, and until they choose, the eyes in the center for
// whoever has them), or the island of a plugin, while the plugin says it is on (its module's `rest`, see plugins.rs) and the user
// has chosen it (until they do, the plugin's pill is what shows); two that are on: the higher priority wins. The host keeps what the user chose (rest.rs).

import { head } from "./head.js";
import { invoke, listen } from "./kit.js";

const root = document.getElementById("rest");
const zone = { left: root.querySelector(".l"), center: root.querySelector(".c"), right: root.querySelector(".r") };
const SECTIONS = ["left", "center", "right"];

/** what the user's island is until they have chosen: the eyes, in the center */
const DEFAULT = { left: "", center: "eyes:head", right: "" };

let state = { mine: {}, edited: false, islands: [] };
const active = new Map(); // plugin -> Set of the ids of its islands that are on
let viewNow = "idle";
let raf = 0;

/** the island shown now: { source: "mine" | "plugin:island", left, center, right } (widget ids; "" for none) */
export function current() {
	// (the host lists the winning one first; a part of a bundle, `bundle-part`, says for its bundle)
	const isOn = (i) => [...active].some(([pl, ids]) => (pl === i.plugin || pl.startsWith(`${i.plugin}-`)) && ids.has(i.id));
	const live = state.islands.filter((i) => i.on && isOn(i));
	if (live.length) {
		const i = live[0];
		const out = { source: i.key };
		// (a section the user changed is theirs; one they did not is what the plugin shipped)
		for (const s of SECTIONS) out[s] = i.custom?.[s] ?? i.shipped?.[s] ?? "";
		return out;
	}
	if (!state.edited) return { source: "mine", ...DEFAULT };
	const m = state.mine || {};
	return { source: "mine", left: m.left || "", center: m.center || "", right: m.right || "" };
}

function draw() {
	raf = 0;
	const idle = viewNow === "idle";
	root.classList.toggle("hidden", !idle);
	if (!idle) return;
	const lay = current();
	head.take(SECTIONS.map((s) => lay[s]).filter(Boolean));
	const buttons = new Set(head.widgetList().filter((w) => w.interactive).map((w) => w.id));
	for (const s of SECTIONS) {
		const id = lay[s];
		const node = id ? head.widgetNode(id) : null;
		const z = zone[s];
		if (!node) {
			if (z.firstChild) z.replaceChildren();
			continue;
		}
		node.classList.toggle("rest-btn", buttons.has(id));
		if (z.firstChild !== node || z.childElementCount !== 1) z.replaceChildren(node);
	}
	fit();
}

/** a widget is made for the head, which is taller than the island is: one that does not fit its section is made smaller to */
function fit() {
	if (root.classList.contains("hidden")) return;
	for (const s of SECTIONS) {
		const z = zone[s];
		const n = z.firstElementChild;
		const body = n?.firstElementChild;
		// (a face is as big as its place; it is not measured)
		if (!body || n.querySelector(".face-widget")) continue;
		n.style.zoom = "";
		const r = body.getBoundingClientRect();
		const k = Math.min(1, r.height ? (z.clientHeight - 2) / r.height : 1, r.width ? z.clientWidth / r.width : 1);
		n.style.zoom = k < 1 ? String(Math.max(0.4, k)) : "";
	}
}

// (a timer, not a frame: the island's page does not draw frames while its window is hidden, and what is in it is drawn when it shows)
const schedule = () => {
	if (!raf) raf = setTimeout(draw, 30);
};

function setActive(plugin, ids) {
	if (ids && ids.length) active.set(plugin, new Set(ids));
	else active.delete(plugin);
}

async function load() {
	try {
		state = (await invoke("rest_get")) || state;
	} catch (_) {}
	schedule();
}

export function initRest() {
	listen("view-tick", (e) => {
		viewNow = e.payload;
		// (the island is not at rest: what it held goes back to the head at once, which is about to be shown)
		if (viewNow !== "idle") head.take([]);
		schedule();
	});
	listen("rest-changed", load);
	listen("plugins-changed", load);
	listen("plugin-surface", (e) => {
		setActive(e.payload.plugin, e.payload.rest);
		schedule();
	});
	invoke("plugin_surface")
		.then((all) => {
			for (const [plugin, s] of Object.entries(all || {})) setActive(plugin, s.rest);
			schedule();
		})
		.catch(() => {});
	head.onChange(schedule);
	// (what a widget says changes: a clock, a number)
	setInterval(fit, 1000);
	load();
}

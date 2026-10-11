// The faces of plugins: a plugin may bring a script that draws in a frame the island gives it (the aura behind the island, the
// eyes, a card of its own). The frame is sandboxed: its script cannot reach the island's page, the network or storage, so all it
// can do is paint in its frame and send back a press. What reaches it is what its plugin's permissions allow (the sound, the
// cursor) and what the island is doing (its size, which view it shows), sent once for every frame the page draws.
//
// Slots (manifest `faces[].slot`):
//   backdrop  behind what the island shows (role "inside": in the island) and outside it (role "outside": over the window's margin)
//   island    over the collapsed island (and the island's head when the hub is open): one frame the size of the island
//   widget    a widget of the head (`place`, `rank`, `width`, `height`)
//   card      a card of the hub (`height`)
//
// What a face's script has (see SHELL): `nadi.on(type, fn)` for "frame", "settings", "event" and "resize"; `nadi.press(id, args)`;
// `nadi.role`, `nadi.face`, `nadi.plugin`.

import { audio, director, onBeat } from "./sound.js";
import { FLOATS, call, el, invoke, listen, view } from "./kit.js";
import { head } from "./head.js";

/** the page a frame is made of: the script of the face goes after the small kit that talks to the island */
const SHELL = (src, meta) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'">
<style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}canvas{display:block}</style></head><body><script>
(function(){
var meta=${JSON.stringify(meta)},h={};
var nadi=window.nadi={role:meta.role,face:meta.face,plugin:meta.plugin,settings:{},
 on:function(t,f){(h[t]=h[t]||[]).push(f)},
 send:function(m){m.nadi=1;m.face=meta.face;m.role=meta.role;parent.postMessage(m,"*")},
 press:function(id,args){nadi.send({t:"press",id:id,args:args||{}})}};
addEventListener("message",function(e){var m=e.data;if(e.source!==parent||!m||m.nadi!==1)return;
 if(m.t==="settings")nadi.settings=m.values||{};
 var l=h[m.t]||[];for(var i=0;i<l.length;i++){try{l[i](m)}catch(x){console.error(x)}}
 if(m.t==="frame")parent.postMessage({nadi:1,t:"ack"},"*")});
addEventListener("resize",function(){var l=h.resize||[];for(var i=0;i<l.length;i++){try{l[i]({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})}catch(x){console.error(x)}}});
addEventListener("error",function(e){nadi.send({t:"error",text:String(e.message||e)})});
})();
</script><script>
${String(src).replace(/<\/script/gi, "<\\/script")}
</script><script>nadi.send({t:"ready"})</script></body></html>`;

const frames = new Map(); // key -> { plugin, spec, role, win, node, ready, want }
const places = new Map(); // key -> { plugin, spec, node }: the widgets that have no frame (their plugin's island face draws there)
const sources = new Map(); // "plugin/file" -> script text
const settings = new Map(); // plugin -> { key: value }
const info = new Map(); // plugin -> { id, enabled, faces, perms }
const geo = { w: 0, h: 0, r: 0, x: 0, y: 0, pad: 0 };
const cursor = { x: 0, y: 0, dx: 0, dy: 0, speed: 0, hover: false, seq: 0 };
let lastSync = 0;

const perms = (p) => new Set((p.permissions || []).map((x) => x.name));

async function sourceOf(plugin, file) {
	const k = `${plugin}/${file}`;
	if (!sources.has(k)) sources.set(k, await invoke("plugin_face", { id: plugin, file }));
	return sources.get(k);
}

function post(f, msg) {
	try {
		f.node.contentWindow?.postMessage({ nadi: 1, ...msg }, "*");
	} catch (_) {}
}

function valuesOf(p) {
	const out = {};
	for (const s of p.settings || []) out[s.key] = s.value;
	return out;
}

function remove(key) {
	const f = frames.get(key);
	if (!f) return;
	f.node.remove();
	frames.delete(key);
}

async function mount(key, p, spec, role, host, placeholder = null) {
	if (frames.has(key)) return frames.get(key);
	const f = { plugin: p.id, spec, role, node: el("iframe", "face-frame"), ready: false, key, placeholder };
	f.node.setAttribute("sandbox", "allow-scripts");
	f.node.setAttribute("aria-hidden", "true");
	f.node.tabIndex = -1;
	f.node.dataset.plugin = p.id;
	f.node.dataset.slot = spec.slot;
	frames.set(key, f);
	let src;
	try {
		src = await sourceOf(p.id, spec.file);
	} catch (_) {
		frames.delete(key);
		return null;
	}
	if (!frames.has(key)) return null;
	f.node.srcdoc = SHELL(src, { plugin: p.id, face: spec.id, role });
	host.append(f.node);
	return f;
}

// --------------------------------------------------------------------------------------------------- the slots

const SLOTS = {
	backdrop: [
		["inside", () => document.getElementById("face-back")],
		["outside", () => document.getElementById("face-outside")],
	],
	island: [["island", () => document.getElementById("face-front")]],
};

/** where the frames of the widgets are: over the hub, never moved */
function widgetLayer() {
	let layer = document.getElementById("face-widgets");
	if (!layer) {
		layer = el("div");
		layer.id = "face-widgets";
		layer.setAttribute("aria-hidden", "true");
		document.getElementById("hub").append(layer);
	}
	return layer;
}

function registerWidget(p, spec) {
	const key = `${p.id}:${spec.id}`;
	head.register({
		id: key,
		plugin: p.id,
		name: spec.name || spec.id,
		place: spec.place || "right",
		rank: spec.rank || 50,
		width: spec.width || 60,
		interactive: false,
		start: spec.start !== false,
		preview: () => el("span", "still-date", spec.name || spec.id),
		build: () => {
			// (the head moves its widgets about, and a frame that is moved is loaded again: the widget is a place, and its frame
			// sits in a layer of its own, put where the place is, for every frame the page draws)
			const box = el("div", "face-widget");
			box.style.width = `${spec.width || 60}px`;
			// (no height said: the height of the row it is in)
			box.style.height = spec.height ? `${spec.height}px` : "var(--rowh, 76px)";
			if (spec.shared) places.set(key, { plugin: p.id, spec, node: box });
			else mount(`${key}#widget`, p, spec, "widget", widgetLayer(), box);
			return box;
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
	const live = new Set();
	for (const p of listing?.plugins || []) {
		if (!p.faces?.length) continue;
		info.set(p.id, { id: p.id, faces: p.faces, perms: perms(p) });
		settings.set(p.id, valuesOf(p));
		if (!p.enabled || p.error) continue;
		for (const spec of p.faces) {
			if (spec.slot === "widget") {
				registerWidget(p, spec);
				if (!spec.shared) live.add(`${p.id}:${spec.id}#widget`);
				continue;
			}
			for (const [role, where] of SLOTS[spec.slot] || []) {
				const key = `${p.id}:${spec.id}#${role}`;
				live.add(key);
				const host = where();
				if (host && !frames.has(key)) mount(key, p, spec, role, host);
			}
		}
	}
	for (const key of [...frames.keys()]) if (!live.has(key)) remove(key);
	// (a plugin that is off or gone has no place either)
	for (const [key, pl] of [...places]) if (!info.get(pl.plugin) || !(listing.plugins.find((x) => x.id === pl.plugin)?.enabled)) places.delete(key);
	// (the plugins that are off or gone: what they showed goes, and a changed script is read again the next time)
	for (const k of [...sources.keys()]) if (!(info.get(k.split("/")[0])?.faces || []).some((f) => k.endsWith(`/${f.file}`))) sources.delete(k);
	for (const f of frames.values()) post(f, { t: "settings", values: settings.get(f.plugin) || {} });
}

// ---------------------------------------------------------------------------------------------- what they are sent

/** what the page knows now: the island's shape, the window, the sound, the cursor */
function snapshot(now, dt, extra) {
	return { t: "frame", now, dt, view: view.name, island: { ...geo }, win: { w: window.innerWidth, h: window.innerHeight, pad: geo.pad }, ...extra };
}

let audioNow = null;
function audioOf() {
	if (!audioNow) audioNow = { ...audio, bands: [...audio.bands], kick: { ...audio.kick }, nod: { ...audio.nod }, state: director.state, video: !!director.video };
	return audioNow;
}

/** called by the page for every frame it draws */
export function frame(now, dt, island) {
	if (!frames.size) return;
	Object.assign(geo, island);
	audioNow = null;
	// where each shown frame is in the window (a face may need it: the eyes look from where they are)
	const shown = [];
	const layer = document.getElementById("face-widgets");
	const lr = layer?.getBoundingClientRect();
	// (the island may be drawn smaller than it is laid out: what the layer measures in pixels the page lays out in)
	const k = layer && layer.offsetWidth ? lr.width / layer.offsetWidth : 1;
	for (const f of frames.values()) {
		if (f.placeholder) {
			// a widget: its frame follows its place; no place on show (the head is not there, the widget is out of the head) and
			// the frame is left alone
			const p = f.placeholder;
			const on = p.isConnected && p.offsetParent !== null && !!lr;
			f.node.style.visibility = on ? "visible" : "hidden";
			if (!on) continue;
			const r = p.getBoundingClientRect();
			f.node.style.left = `${(r.left - lr.left) / k}px`;
			f.node.style.top = `${(r.top - lr.top) / k}px`;
			f.node.style.width = `${p.offsetWidth}px`;
			f.node.style.height = `${p.offsetHeight}px`;
			if (f.ready) shown.push({ f, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
			continue;
		}
		// (a frame that is not shown, because its slot is hidden, is left alone)
		if (!f.ready || f.node.offsetParent === null) continue;
		const r = f.node.getBoundingClientRect();
		shown.push({ f, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
	}
	for (const { f, rect } of shown) {
		// (one frame at a time: a face that paints slower than the page draws is not sent more than it can take, or what is
		// waiting for it piles up in memory)
		if (f.waiting && now - f.postedAt < 500) continue;
		const want = info.get(f.plugin)?.perms;
		const extra = { rect };
		if (want?.has("audio")) extra.audio = audioOf();
		if (want?.has("cursor position")) extra.cursor = cursor;
		// (the island's own frames are told where the plugin's widgets are, in the island's own pixels)
		if (f.spec.slot === "island" || f.spec.slot === "backdrop") {
			extra.peers = shown
				.filter((o) => o.f.plugin === f.plugin && o.f.spec.slot === "widget")
				.map((o) => ({ face: o.f.spec.id, x: o.rect.x - geo.x, y: o.rect.y - geo.y, w: o.rect.w, h: o.rect.h }));
			// (and the places of its widgets that have no frame: where they are on show)
			for (const pl of places.values()) {
				if (pl.plugin !== f.plugin || !pl.node.isConnected || pl.node.offsetParent === null) continue;
				const r = pl.node.getBoundingClientRect();
				extra.peers.push({ face: pl.spec.id, x: r.left - geo.x, y: r.top - geo.y, w: r.width, h: r.height });
			}
		}
		f.waiting = true;
		f.postedAt = now;
		post(f, snapshot(now, dt, extra));
	}
}

/** the cursor, in the window's own pixels (from the page's poll of it) */
export function setCursor(c) {
	Object.assign(cursor, c);
	cursor.seq++;
}

/** something happened on the island that a face may want to move to: "view", "hub-open", "click", "boop"... */
export function event(name, data) {
	for (const f of frames.values()) if (f.ready) post(f, { t: "event", name, data });
}

export const hasFaces = () => frames.size > 0;

// (for looking at them from the console)
window.__faces = () => [...frames.values()].map((f) => ({ key: f.key, ready: f.ready, shown: f.node.offsetParent !== null, w: f.node.offsetWidth, h: f.node.offsetHeight }));

// ------------------------------------------------------------------------------------------------------- start

export default {
	id: "faces",
	init() {
		if (FLOATS) return;
		window.addEventListener("message", (e) => {
			const m = e.data;
			if (!m || m.nadi !== 1) return;
			const f = [...frames.values()].find((x) => x.node.contentWindow === e.source);
			if (!f) return;
			if (m.t === "ack") {
				f.waiting = false;
			} else if (m.t === "ready") {
				f.ready = true;
				f.waiting = false;
				post(f, { t: "settings", values: settings.get(f.plugin) || {} });
			} else if (m.t === "press") {
				call(f.plugin, "face", { face: f.spec.id, id: String(m.id || "").slice(0, 60), args: m.args || {} }).catch(() => {});
			} else if (m.t === "error") {
				console.warn(`[${f.plugin}] ${m.text}`);
			}
		});
		// (a hit of the bass: told to the faces that hear the sound)
		onBeat((strength, pan) => {
			for (const f of frames.values()) if (f.ready && info.get(f.plugin)?.perms.has("audio")) post(f, { t: "event", name: "beat", data: { strength, pan } });
		});
		listen("plugin-setting", (e) => {
			const { plugin, key, value } = e.payload;
			const s = settings.get(plugin) || {};
			s[key] = value;
			settings.set(plugin, s);
			for (const f of frames.values()) if (f.plugin === plugin) post(f, { t: "settings", values: s });
		});
		listen("plugins-changed", () => {
			sources.clear();
			sync();
		});
		sync();
	},
	cards() {
		return [];
	},
};

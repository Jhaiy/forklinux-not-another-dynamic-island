// System meters, the face of the native plugin (src/builtin/system_meters): how busy the CPU, the memory and the graphics card
// are, as widgets of the head of the expanded island (see head.js). It offers two: three thin bars stacked in one widget (it
// starts in the head), and a ring for each (they wait in the tray). Polled once a second while the hub is open and the plugin
// is on. One tooltip says all of it.
import { head } from "../head.js";
import { FLOATS, addRing, el, host, invoke, setRing, tipRows, view } from "../kit.js";

const ID = "system-meters";
const KEYS = [
	["cpu", "CPU", "#5AC8E6"],
	["ram", "RAM", "#B47EE6"],
	["gpu", "GPU", "#8ADB6E"],
];
// the last numbers (null: not read yet, or no such counter), for the bars drawn now and the ones drawn as a picture
const last = { cpu: null, ram: null, gpu: null, ramUsed: null, ramTotal: null };
const SAMPLE = { cpu: 34, ram: 61, gpu: 22 };

/** the colour of a bar: its own, until the load asks for attention */
const tone = (pct, own) => (pct >= 95 ? "#E5675C" : pct >= 80 ? "#E6A15A" : own);

function makeBars() {
	const box = el("div", "sm-bars");
	for (const [key, label] of KEYS) {
		const row = el("div", "sm-row");
		row.dataset.key = key;
		const track = el("i");
		track.append(el("u"));
		row.append(el("b", null, label), track);
		box.append(row);
	}
	return box;
}

/** draw the numbers on a set of bars (`v`: percent by key, null where there is none) */
function paintBars(box, v) {
	for (const [key, , color] of KEYS) {
		const row = box.querySelector(`[data-key="${key}"]`);
		const pct = v[key];
		row.classList.toggle("none", pct == null);
		if (pct == null) continue;
		const fill = row.querySelector("u");
		fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
		fill.style.background = tone(pct, color);
	}
}

/** the tooltip of the bars: a row for each, with its bar, and the memory in gigabytes under its own */
function tip() {
	const rows = [];
	for (const [key, label, color] of KEYS) {
		const pct = last[key];
		if (pct == null) continue;
		rows.push({
			label,
			value: `${Math.round(pct)}%`,
			pct,
			color: tone(pct, color),
			note: key === "ram" && last.ramTotal ? `${last.ramUsed.toFixed(1)} of ${last.ramTotal.toFixed(1)} GB` : null,
		});
	}
	return tipRows(rows, { title: "System" });
}

let bars = null;

async function poll() {
	if (view.name !== "hub" || !head.isEnabled(ID)) return;
	try {
		const s = await invoke("get_sys_stats");
		last.cpu = s.cpu_pct;
		last.ram = s.ram_pct;
		last.ramUsed = s.ram_used_gb;
		last.ramTotal = s.ram_total_gb;
		setRing("cpu", s.cpu_pct, `CPU · ${Math.round(s.cpu_pct)}%`);
		setRing("ram", s.ram_pct, `RAM · ${Math.round(s.ram_pct)}%\n${s.ram_used_gb.toFixed(1)} / ${s.ram_total_gb.toFixed(1)} GB`);
		rings.cpu.classList.remove("hidden");
		rings.ram.classList.remove("hidden");
	} catch (_) {}
	try {
		// null until the counter has a baseline, or on a machine with no GPU counters: that one stays out
		const pct = await invoke("get_gpu_pct");
		if (pct != null) {
			last.gpu = pct;
			setRing("gpu", pct, `GPU · ${Math.round(pct)}%`);
			rings.gpu.classList.remove("hidden");
		}
	} catch (_) {}
	if (last.cpu != null && bars) {
		paintBars(bars, last);
		host.refreshTip(bars);
		head.setHidden(`${ID}:bars`, false);
	}
}

const rings = {};

export default {
	id: ID,
	init() {
		if (FLOATS) return;
		bars = makeBars();
		host.setTip(bars, tip);
		head.register({
			id: `${ID}:bars`,
			plugin: ID,
			name: "Bars",
			place: "right",
			rank: 50,
			width: 76,
			start: true,
			preview: () => {
				const pic = makeBars();
				paintBars(pic, last.cpu != null ? last : SAMPLE);
				return pic;
			},
			build: () => bars,
		});
		// (it takes no room until it has numbers)
		head.setHidden(`${ID}:bars`, true);
		for (const [key, color, name, rank] of [
			["cpu", "#5AC8E6", "CPU ring", 52],
			["ram", "#B47EE6", "RAM ring", 53],
			["gpu", "#8ADB6E", "GPU ring", 54],
		]) {
			const ring = addRing(key, color, ID, rank, false);
			ring.el.dataset.name = name;
			rings[key] = ring.el;
		}
		setInterval(poll, 1000);
	},
	hubOpened: poll,
	cards() {
		return [];
	},
};

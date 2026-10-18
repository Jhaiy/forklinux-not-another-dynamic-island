// What a widget looks like, for the editors of the settings window: a picture with made-up numbers, so that the user gets the
// feel of it. The real widget lives in the island's window and is drawn by its plugin; what is here is guessed from its name.

import { el } from "./kit.js";

/** [pattern, what to draw] in the order they are tried, on the widget's id and name */
const KINDS = [
	[/^ring:/, () => ring(62)],
	[/^eyes:|\beyes\b/, () => eyes()],
	[/hours|time in it|elapsed|length/, () => text("1h 24m", "Today")],
	[/date and time|clock|date|calendar|\btime\b/, () => clock()],
	[/circle|rings/, (hay) => circles(/usage|claude/.test(hay) ? [["5H", 34, "#e8963c"], ["7D", 71, "#e8963c"]] : [["CPU", 34, "#5ac8e6"], ["RAM", 61, "#b47ee6"], ["GPU", 18, "#8adb6e"]])],
	[/usage|limit/, () => bars([["5h", 34, "#e8963c"], ["7d", 71, "#e8963c"]])],
	[/bars|meter|cpu|memory|gpu/, () => bars([["CPU", 34, "#5ac8e6"], ["MEM", 61, "#b47ee6"], ["GPU", 18, "#5ac88c"]])],
	[/ring/, () => ring(62)],
	[/song|track|playing|title/, () => song()],
	[/pause|play/, () => button("pause")],
	[/next|skip/, () => button("next")],
	[/prev|back/, () => button("prev")],
	[/fps|frame/, () => text("144", "fps")],
	[/speed/, () => text("12 MB/s", "Speed")],
	[/file|download/, () => text("ubuntu.iso", "74%")],
	[/game/, () => text("Elden Ring", "Playing")],
	[/session|needs|sessions/, () => needs()],
	[/weather|temperature|temp/, () => text("21°", "Clear")],
	[/sound|audio|level|volume/, () => equalizer()],
];

function eyes() {
	const pic = el("span", "still-eyes");
	pic.append(el("i"), el("i"));
	return pic;
}

function text(main, sub) {
	const box = el("span", "dm-text");
	box.append(el("b", null, main));
	if (sub) box.append(el("small", null, sub));
	return box;
}

function clock() {
	const box = el("span", "dm-clock");
	box.append(el("span", "hw-time", "12:29"), el("span", "hw-date", "Mon, Oct 18"));
	return box;
}

function bars(rows) {
	const box = el("span", "sm-bars");
	for (const [label, pct, color] of rows) {
		const row = el("span", "sm-row");
		const track = el("i");
		const fill = el("u");
		fill.style.width = `${pct}%`;
		fill.style.background = color;
		track.append(fill);
		row.append(el("b", null, label), track);
		box.append(row);
	}
	return box;
}

/** the meters as circles, the label inside (as the island draws the `rings` block) */
function circles(rows) {
	const box = el("span", "sf-rings");
	for (const [label, pct, color] of rows) {
		const c = 2 * Math.PI * 9;
		const one = el("span", "sf-ring");
		one.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="3"/><circle cx="12" cy="12" r="9" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${((c * pct) / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 12 12)"/></svg>`;
		one.append(el("b", null, label));
		box.append(one);
	}
	return box;
}

function ring(pct) {
	const wrap = el("span", "dm-ring");
	const c = 2 * Math.PI * 7;
	wrap.innerHTML = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2.4"/><circle cx="10" cy="10" r="7" fill="none" stroke="#e8963c" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(c * pct) / 100} ${c}" transform="rotate(-90 10 10)"/></svg>`;
	return wrap;
}

function song() {
	const box = el("span", "dm-song");
	box.append(el("i", "dm-art"), text("Midnight City", "M83"));
	return box;
}

const GLYPHS = {
	pause: "M5.5 3.5v9M10.5 3.5v9",
	next: "M12 3.5v9M4 3.8v8.4L10.2 8z",
	prev: "M4 3.5v9M12 3.8v8.4L5.8 8z",
};

function button(kind) {
	const b = el("span", "dm-btn");
	b.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${GLYPHS[kind]}"/></svg>`;
	return b;
}

function needs() {
	const box = el("span", "dm-song");
	const dot = el("i", "dm-dot");
	box.append(dot, text("Needs you", "my-project"));
	return box;
}

function equalizer() {
	const box = el("span", "dm-eq");
	for (const h of [40, 80, 55, 95, 30]) {
		const b = el("i");
		b.style.height = `${h}%`;
		box.append(b);
	}
	return box;
}

/** a picture of the widget `{ id, name }`: what it would look like with something to say */
export function picture({ id = "", name = "" }) {
	const hay = `${id} ${name}`.toLowerCase();
	const found = KINDS.find(([re]) => re.test(hay));
	const pic = el("span", "dm");
	pic.append(found ? found[1](hay) : text(name || id));
	return pic;
}

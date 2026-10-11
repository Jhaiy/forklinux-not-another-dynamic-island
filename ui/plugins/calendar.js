// Calendar, the face of the Calendar plugin (`ics-calendar`: a module plugin the app carries, see plugins/ics-calendar). The
// plugin reads the calendar link, shows the next events on a card and says so shortly before one starts; this file is its
// page and its widget. The widget is the date and the time, at the left of the head: pressed, it swaps the cards for a month
// grid; pressed again, it swaps them back. Pick a day to list its events. The events themselves are the island's (they come
// from whichever plugin brought them, pushed by `calendar-tick`).
import { head } from "../head.js";
import { eyes } from "./eyes.js";
import { FLOATS, el, host, invoke, listen, view, withIcon } from "../kit.js";

const ID = "ics-calendar";
const pane = document.getElementById("pane-calendar");
const calTitleEl = document.getElementById("cal-title");
const calWeekEl = document.getElementById("cal-week");
const calGridEl = document.getElementById("cal-grid");
const calDayTitleEl = document.getElementById("cal-day-title");
const calStatusEl = document.getElementById("cal-status");
const calEventsEl = document.getElementById("cal-events");
const cal = {
	data: null,
	byDay: new Map(),
	month: null,
	sel: null,
};

const dayKey = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// first weekday of the user's locale: 0 = Sunday .. 6 = Saturday
function calFirstDow() {
	try {
		const loc = new Intl.Locale(navigator.language);
		const info = loc.getWeekInfo ? loc.getWeekInfo() : loc.weekInfo;
		if (info && info.firstDay) return info.firstDay % 7;
	} catch (_) {}
	return 0;
}
const CAL_FIRST_DOW = calFirstDow();

function calIndex() {
	cal.byDay = new Map();
	if (!cal.data || !cal.data.events) return;
	for (const ev of cal.data.events) {
		const first = startOfDay(new Date(ev.start_ms));
		// end is exclusive: a 00:00-00:00 all-day event covers exactly one day
		const lastMs = ev.end_ms > ev.start_ms ? ev.end_ms - 1 : ev.start_ms;
		const last = startOfDay(new Date(lastMs));
		let d = first;
		for (let n = 0; d <= last && n < 62; n++, d = addDays(d, 1)) {
			const k = dayKey(d);
			if (!cal.byDay.has(k)) cal.byDay.set(k, []);
			cal.byDay.get(k).push(ev);
		}
	}
}

function calSetData(c) {
	cal.data = c;
	calIndex();
	if (!pane.classList.contains("hidden") && cal.month) {
		buildCalGrid(null);
		renderCalDay(false);
	}
}

function buildCalWeekHeader() {
	calWeekEl.textContent = "";
	const base = new Date(2023, 0, 1); // a Sunday
	for (let i = 0; i < 7; i++) {
		const s = document.createElement("span");
		s.textContent = addDays(base, (CAL_FIRST_DOW + i) % 7).toLocaleDateString([], { weekday: "narrow" });
		calWeekEl.append(s);
	}
}

function buildCalGrid(dir) {
	const first = new Date(cal.month.getFullYear(), cal.month.getMonth(), 1);
	calTitleEl.textContent = first.toLocaleDateString([], { month: "long", year: "numeric" });
	const offset = (first.getDay() - CAL_FIRST_DOW + 7) % 7;
	const gridStart = addDays(first, -offset);
	const todayKey = dayKey(new Date());
	const selKey = dayKey(cal.sel);
	calGridEl.textContent = "";
	for (let i = 0; i < 42; i++) {
		const d = addDays(gridStart, i);
		const k = dayKey(d);
		const btn = document.createElement("button");
		btn.className = "cal-day";
		if (d.getMonth() !== first.getMonth()) btn.classList.add("other");
		if (k === todayKey) btn.classList.add("today");
		if (k === selKey) btn.classList.add("sel");
		btn.dataset.key = k;
		const num = document.createElement("span");
		num.textContent = d.getDate();
		const dots = document.createElement("span");
		dots.className = "cal-dots";
		const n = Math.min((cal.byDay.get(k) || []).length, 3);
		for (let j = 0; j < n; j++) dots.append(document.createElement("i"));
		btn.append(num, dots);
		btn.addEventListener("click", () => selectCalDay(d));
		calGridEl.append(btn);
	}
	if (dir) {
		calGridEl.classList.remove("slide-next", "slide-prev");
		void calGridEl.offsetWidth; // restart the slide
		calGridEl.classList.add(dir > 0 ? "slide-next" : "slide-prev");
	}
}

function calTimeLabel(ev, day) {
	if (ev.all_day) return "All day";
	const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	const dayStart = day.getTime();
	const dayEnd = addDays(day, 1).getTime();
	const startsToday = ev.start_ms >= dayStart;
	const endsToday = ev.end_ms <= dayEnd;
	if (ev.end_ms <= ev.start_ms) return fmt(ev.start_ms);
	if (startsToday && endsToday) return `${fmt(ev.start_ms)} – ${fmt(ev.end_ms)}`;
	if (startsToday) return `${fmt(ev.start_ms)} →`;
	return endsToday ? `→ ${fmt(ev.end_ms)}` : "All day";
}

function renderCalDay(animate) {
	const day = startOfDay(cal.sel);
	const list = (cal.byDay.get(dayKey(day)) || []).slice().sort((a, b) => (b.all_day ? 1 : 0) - (a.all_day ? 1 : 0) || a.start_ms - b.start_ms);
	const label = day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
	// a day with nothing on it shows nothing: no date heading, no placeholder
	calDayTitleEl.textContent = list.length ? `${label} · ${list.length} ${list.length === 1 ? "event" : "events"}` : "";

	calStatusEl.textContent = "";
	calEventsEl.textContent = "";
	const d = cal.data;
	if (!d || !d.configured) {
		// nobody brings events: say where they come from
		calStatusEl.textContent = "No calendar link yet. Paste one in Settings > Plugins > Calendar.";
		return;
	}
	if (d.error) {
		calStatusEl.textContent = d.error;
		return;
	}
	if (!list.length) return;
	const now = Date.now();
	list.forEach((ev, i) => {
		const row = document.createElement("div");
		row.className = "cal-event spot";
		if (ev.end_ms < now && !(ev.all_day && ev.end_ms >= now)) row.classList.add("past");
		if (animate) {
			row.classList.add("fresh");
			row.style.setProperty("--i", i);
		}
		const title = document.createElement("div");
		title.className = "cal-event-title";
		title.textContent = ev.summary;
		const time = document.createElement("div");
		time.className = "cal-event-time";
		withIcon(time, "clock", calTimeLabel(ev, day));
		row.append(title, time);
		calEventsEl.append(row);
	});
}

function selectCalDay(d) {
	const prevMonth = cal.month.getFullYear() * 12 + cal.month.getMonth();
	cal.sel = startOfDay(d);
	const newMonth = d.getFullYear() * 12 + d.getMonth();
	if (newMonth !== prevMonth) {
		cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
		buildCalGrid(newMonth > prevMonth ? 1 : -1);
	} else {
		// same month: just move the highlight (the disc springs between cells)
		const k = String(dayKey(cal.sel));
		for (const e of calGridEl.children) e.classList.toggle("sel", e.dataset.key === k);
	}
	renderCalDay(true);
}

function shiftCalMonth(delta) {
	const prev = cal.month;
	cal.month = new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
	// keep the same day-of-month selected where it exists (clamped to month end)
	const lastDay = new Date(cal.month.getFullYear(), cal.month.getMonth() + 1, 0).getDate();
	cal.sel = new Date(cal.month.getFullYear(), cal.month.getMonth(), Math.min(cal.sel.getDate(), lastDay));
	buildCalGrid(delta);
	renderCalDay(true);
}

function openCalendar() {
	const today = startOfDay(new Date());
	cal.sel = today;
	cal.month = new Date(today.getFullYear(), today.getMonth(), 1);
	buildCalGrid(null);
	renderCalDay(false);
	host.setPane("calendar");
}

async function loadCalendar() {
	try {
		calSetData(await invoke("get_calendar"));
	} catch (_) {}
}

// ---- the widget: the date and the time ----
let time24 = false;
let timeEl = null;
let dateEl = null;

function updateClock() {
	if (!timeEl) return;
	const now = new Date();
	// military time (Settings > Time) shows it as 15:30
	const t = now.toLocaleTimeString([], time24 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "numeric", minute: "2-digit" });
	if (timeEl.textContent !== t) timeEl.textContent = t;
	const d = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
	if (dateEl.textContent !== d) dateEl.textContent = d;
}

function buildClock() {
	const box = el("button", "hw-clock");
	box.type = "button";
	box.dataset.tip = "Calendar";
	timeEl = el("span", "hw-time");
	dateEl = el("span", "hw-date");
	box.append(timeEl, dateEl);
	box.addEventListener("click", () => {
		eyes.mood.happyUntil = performance.now() + 700;
		if (host.pane() === "calendar") host.setPane("info");
		else openCalendar();
	});
	updateClock();
	return box;
}

export default {
	id: ID,
	init() {
		if (FLOATS) return;
		buildCalWeekHeader();
		head.register({
			id: "calendar:date",
			plugin: ID,
			name: "Date and time",
			place: "left",
			rank: 10,
			width: 118,
			interactive: true,
			// (a still picture for the tray: the time and the date as they are now)
			preview: () => {
				const pic = el("span", "still-clock");
				pic.append(el("span", "still-time", timeEl?.textContent || "2:48 PM"), el("span", "still-date", dateEl?.textContent || ""));
				return pic;
			},
			build: buildClock,
		});
		// (its page goes with the plugin: switched off while it is open, the island is back at the cards)
		head.onEnabled(() => {
			if (!head.isEnabled(ID) && host.pane() === "calendar") host.setPane("info");
		});
		document.getElementById("cal-prev").addEventListener("click", () => shiftCalMonth(-1));
		document.getElementById("cal-next").addEventListener("click", () => shiftCalMonth(1));
		calTitleEl.addEventListener("click", () => {
			const today = startOfDay(new Date());
			if (dayKey(today) === dayKey(cal.sel) && cal.month.getMonth() === today.getMonth()) return;
			const dir = today.getFullYear() * 12 + today.getMonth() > cal.month.getFullYear() * 12 + cal.month.getMonth() ? 1 : -1;
			cal.sel = today;
			cal.month = new Date(today.getFullYear(), today.getMonth(), 1);
			buildCalGrid(dir);
			renderCalDay(true);
		});
		let wheelAt = 0;
		pane.addEventListener(
			"wheel",
			(e) => {
				if (!e.target.closest("#cal-grid, #cal-head") || performance.now() - wheelAt < 260) return;
				wheelAt = performance.now();
				e.preventDefault();
				shiftCalMonth(e.deltaY > 0 ? 1 : -1);
			},
			{ passive: false },
		);
		// clicks in here must not reach #pill's mousedown (it would start a window drag / read the click as "toggle the hub")
		pane.addEventListener("mousedown", (e) => e.stopPropagation());
		listen("calendar-tick", (e) => calSetData(e.payload));
		setInterval(() => {
			if (view.name === "hub") updateClock();
		}, 1000);
	},
	hubOpened() {
		loadCalendar();
		invoke("get_settings")
			.then((s) => {
				time24 = !!s?.time_24h;
				updateClock();
			})
			.catch(() => {});
	},
	cards() {
		return [];
	},
};

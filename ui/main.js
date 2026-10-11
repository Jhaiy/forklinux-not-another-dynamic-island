// Canvas-painted idle "eyes" -- a straight port of `_paint_eyes`/`_tick_eyes`
// from the Qt prototype (main.py), driven by the Rust-side `cursor-tick`
// event instead of a QTimer polling QCursor.pos(). No framework, no bundler:
// this is the whole idle-state UI, kept as cheap as the old QPainter path.

import { initFloats } from "./floats.js";
import { head } from "./head.js";
import { initPluginUi, pluginCard, setRings, whenText } from "./pluginui.js";
import { plugins } from "./plugins/index.js";
import { addFromGitHub, askMoved } from "./repo.js";
import { frame as facesFrame, event as faceEvent, setCursor as faceCursor } from "./faces.js";
import { updateAudio } from "./sound.js";
import {
	FLOATS,
	LLM_COLOR,
	LLM_LETTER,
	LLM_RING_C,
	askModal,
	llmCtxColor,
	llmStateIcon,
	ICON,
	call,
	el,
	floatKeys,
	host,
	invoke,
	li,
	listen,
	pills,
	view,
} from "./kit.js";

if (FLOATS) document.documentElement.classList.add("floats");

// ---- the island is not a web page: nothing of the browser should work on it ----
// (the webview's own accelerators, devtools, zoom and menus are switched off in Rust; this covers
// what is left: the keys, the wheel, files dropped on it, dragged links and images, middle click)
const BLOCKED_KEYS =
	/^(F\d{1,2}|BrowserBack|BrowserForward|BrowserRefresh|BrowserSearch|BrowserHome|PrintScreen)$/;
const BLOCKED_CTRL = /^[rpsufgjhdnotwebk\-=+0\[\]]$/i; // ctrl + any of these is a browser command; a, c, v, x, z, y stay
window.addEventListener(
	"keydown",
	(e) => {
		const typing =
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement;
		const block =
			BLOCKED_KEYS.test(e.key) ||
			((e.ctrlKey || e.metaKey) &&
				BLOCKED_CTRL.test(e.key)) ||
			(e.ctrlKey &&
				e.shiftKey &&
				/^[ijcnrdtw]$/i.test(e.key)) ||
			(e.altKey &&
				/^(ArrowLeft|ArrowRight|Home)$/.test(e.key)) ||
			(e.key === "Backspace" &&
				!typing &&
				!e.target.isContentEditable);
		if (block) {
			e.preventDefault();
			e.stopPropagation();
		}
	},
	true,
);
window.addEventListener(
	"wheel",
	(e) => {
		if (e.ctrlKey) e.preventDefault();
	},
	{ passive: false },
);
for (const t of [
	"dragstart",
	"dragover",
	"drop",
	"gesturestart",
	"gesturechange",
	"auxclick",
]) {
	window.addEventListener(t, (e) => e.preventDefault(), {
		passive: false,
	});
}
window.addEventListener(
	"mousedown",
	(e) => {
		if (e.button === 1) e.preventDefault();
	},
	true,
); // no autoscroll

const pill = document.getElementById("pill");
// (the eyes and the sound light are faces of their plugins, see faces.js; the sound they borrow is in sound.js)



// pop a view's children in with a small stagger (see .enter in style.css)
function playEnter(container) {
	container.classList.remove("enter");
	Array.from(container.children).forEach((c, i) =>
		c.style.setProperty("--i", i),
	);
	void container.offsetWidth;
	container.classList.add("enter");
}

// Authoritative view name ("idle" | "media" | "game"), driven by Rust's
// view-tick -- Rust owns the resize/priority decision (media beats game),
// the frontend just reflects it rather than re-deriving it from has_session/
// has_game flags that could race the resize.
let currentView = "idle";


let lastCursor = { x: 0, y: 0 };
// what the faces are told of the island: its size, where it is in the window, how round its corners are
const shape = { w: 0, h: 0, r: 0, x: 0, y: 0, pad: 0 };
let shapeKey = "";
function islandShape() {
	const r = pill.getBoundingClientRect();
	const w = pill.offsetWidth;
	const h = pill.offsetHeight;
	const key = `${w}x${h}`;
	if (key !== shapeKey) {
		shapeKey = key;
		shape.r = parseFloat(getComputedStyle(pill).borderTopLeftRadius) || 0;
	}
	shape.w = w;
	shape.h = h;
	shape.x = r.left;
	shape.y = r.top;
	shape.pad = cursorPad;
	return shape;
}

let lastFrameT = performance.now();
function frame(now) {
	// one bad frame must never kill the loop (the eyes would freeze/vanish for good)
	try {
		const dt = Math.min(
			Math.max((now - lastFrameT) / 1000, 0),
			0.05,
		);
		lastFrameT = now;
		updateCall(now);
		updateAudio(now, dt);
		facesFrame(now, dt, islandShape());
	} catch (err) {
		console.error(err);
	}
	requestAnimationFrame(frame);
}
if (!FLOATS) requestAnimationFrame(frame);

listen("view-tick", (event) => {
	currentView = event.payload;
	view.name = currentView;
	faceEvent("view", currentView);
	for (const [id, node] of pills) node.classList.toggle("hidden", currentView !== id);
	notifEl.classList.toggle(
		"hidden",
		currentView !== "notification",
	);
	briefEl.classList.toggle("hidden", currentView !== "brief");
	hubEl.classList.toggle("hidden", currentView !== "hub");
	pill.dataset.view = currentView;
	// only what happened by itself glows (a notification banner, a session pill): calling the
	// island by hovering the edge, or a media / game / work view that settles in, does not
	document.body.dataset.view = currentView;
	document.body.classList.remove("glow");
	if (
		currentView === "notification" ||
		currentView === "brief"
	) {
		void document.body.offsetWidth;
		document.body.classList.add("glow");
	}
	updateBg();
	const enterTarget = {
		notification: notifEl,
		brief: briefEl,
	}[currentView] || pills.get(currentView);
	if (enterTarget) playEnter(enterTarget);
	if (currentView === "hub") {
		faceEvent("hub-open");
		// left-click opens the info pane; the tray's Settings item asks for settings
		setHubPane(pendingSettingsPane ? "settings" : "info");
		pendingSettingsPane = false;
		playHubEntrance(document.getElementById("hub-head"));
		loadSettingsIntoForm();
		loadNotificationHistory();
		for (const p of plugins) p.hubOpened?.();
		refreshActivity();
	}
});

// -- cursor tracking + squash/stretch, driven by Rust's global cursor poll --
// -- the island being "called": a glow builds at the top edge while the cursor dwells --
const callGlow = document.getElementById("call-glow");
let cursorPad = 0;
let callTarget = 0;
let callSmooth = 0;
let callLast = 0;

function updateCall(nowMs) {
	// follows the charge exactly while it builds; the end is very quick (about 0.14 s to gone)
	const dt = Math.min(
		Math.max((nowMs - callLast) / 1000, 0),
		0.05,
	);
	callLast = nowMs;
	callSmooth =
		callTarget > callSmooth
			? callTarget
			: callTarget +
				(callSmooth - callTarget) *
					Math.exp(-dt / 0.025);
	if (callTarget === 0 && callSmooth < 0.004) callSmooth = 0;
	document.body.classList.toggle("calling", callSmooth > 0);
	// the pill stays out of sight while the glow charges; it appears with the drain
	document.body.classList.toggle(
		"call-hide-pill",
		callTarget > 0,
	);
	if (callSmooth > 0)
		callGlow.style.setProperty(
			"--charge",
			callSmooth.toFixed(3),
		);
	// the end fades as well as shrinks
	callGlow.style.setProperty(
		"--fade",
		callTarget < callSmooth ? callSmooth.toFixed(3) : "1",
	);
}

listen("cursor-tick", (event) => {
	// ease-in curve, as picked in the Edge Glow Lab
	const rawCharge = event.payload.charge || 0;
	callTarget = rawCharge * rawCharge;
	// the window is enlarged while charging and while the island lands: keep the pill at its own size
	// and the glow on the screen's top edge
	// pinned and left alone: drawn smaller (CSS scales the island, see body.shrunk)
	const shrunk = !!event.payload.shrunk;
	if (shrunk !== document.body.classList.contains("shrunk")) {
		document.documentElement.style.setProperty(
			"--shrink",
			String((event.payload.shrink || 75) / 100),
		);
		document.body.classList.toggle("shrunk", shrunk);
	}
	const big = !!event.payload.big;
	const pad = event.payload.pad || 0;
	if (pad !== cursorPad) {
		cursorPad = pad;
		document.documentElement.style.setProperty(
			"--pad",
			`${pad}px`,
		);
	}
	if (big !== document.body.classList.contains("big")) {
		document.body.classList.toggle("big", big);
		if (!big) pill.classList.remove("landing");
	}
	if (big) {
		const rs = document.documentElement.style;
		rs.setProperty("--edge", event.payload.edge.toFixed(1));
		rs.setProperty(
			"--pill-top",
			event.payload.pill_top.toFixed(1),
		);
		rs.setProperty("--pill-w", event.payload.pill_w);
		rs.setProperty("--pill-h", event.payload.pill_h);
	}
	const { local_x, local_y } = event.payload;
	// how far the cursor went since the last time it was told (the faces squash and stretch by it)
	const dx = local_x - lastCursor.x;
	const dy = local_y - lastCursor.y;
	lastCursor = { x: local_x, y: local_y };
	const speed = Math.hypot(dx, dy);
	if (islandShown !== !!event.payload.shown) {
		islandShown = !!event.payload.shown;
		pill.classList.toggle("hiding", !islandShown);
		document.body.classList.toggle(
			"pill-hidden",
			!islandShown,
		);
		if (
			islandShown &&
			document.body.classList.contains("big")
		) {
			// the island lands inside the enlarged window: animate it in place
			pill.classList.remove("landing");
			void pill.offsetWidth;
			pill.classList.add("landing");
		}
		updateBg();
	}
	const over =
		!!event.payload.shown &&
		local_x >= cursorPad &&
		local_x <= window.innerWidth - cursorPad &&
		local_y >= cursorPad &&
		local_y <= window.innerHeight - cursorPad;
	faceCursor({ x: local_x, y: local_y, dx, dy, speed, hover: over });
});

// -- drag to move (native OS move, not a JS-computed one -- cheaper and
// matches exactly how the window manager drags any other window) --
// settings live behind the tray menu's "Settings" item so they aren't always
// on screen (Rust emits "open-settings", then opens the hub if it was closed).
// Left-click opens the hub on the info pane.
let pendingSettingsPane = false;
const paneSettings = document.getElementById("pane-settings");
const paneInfo = document.getElementById("pane-info");
const hubBody = document.getElementById("hub-body");
// the panes of the hub: the cards ("info"), the settings, and a page a plugin brings (a `.hub-pane` named by `data-pane`)
const hubPanes = [...document.querySelectorAll(".hub-pane")];
let currentPane = "info";

function setHubPane(pane) {
	if (!hubPanes.some((p) => p.dataset.pane === pane)) pane = "info";
	currentPane = pane;
	let shown = paneInfo;
	for (const p of hubPanes) {
		const on = p.dataset.pane === pane;
		p.classList.toggle("hidden", !on);
		if (on) shown = p;
	}
	hubBody.scrollTop = 0;
	scheduleHubHeight();
	playHubEntrance(shown);
}

// -- adaptive hub height: the expanded island is only as tall as what it holds
// (up to Rust's max). Watch the panes and the header; whenever the visible
// pane's content height changes, tell Rust the height it should spring to. --
const hubHeadEl = document.getElementById("hub-head");
const hubFootEl = document.getElementById("hub-foot");
let hubHeightSent = 0;
let hubHeightRaf = 0;
function reportHubHeight() {
	hubHeightRaf = 0;
	if (currentView !== "hub") return;
	const pane = hubPanes.find((p) => !p.classList.contains("hidden"));
	if (!pane) return;
	// bottom edge of the last visible card. offsetTop/offsetHeight are layout
	// values (getBoundingClientRect would include the entrance animation's
	// transforms, and measure a pane mid-pop-in too tall)
	let bottom = 0;
	const visit = (el) => {
		for (const c of el.children) {
			if (getComputedStyle(c).display === "contents")
				visit(c);
			else if (c.offsetHeight > 0)
				bottom = Math.max(
					bottom,
					c.offsetTop + c.offsetHeight,
				);
		}
	};
	visit(pane);
	// (edit mode has no cards: only the head, the tray and the foot are measured)
	const pb = head.isEditing()
		? 0
		: parseFloat(getComputedStyle(hubBody).paddingBottom);
	const h = Math.ceil(hubHeadEl.scrollHeight + bottom + pb + hubFootEl.offsetHeight);
	if (Math.abs(h - hubHeightSent) < 2) return;
	hubHeightSent = h;
	invoke("set_hub_height", { h, edit: head.isEditing() });
}
function scheduleHubHeight() {
	if (!hubHeightRaf)
		hubHeightRaf = requestAnimationFrame(reportHubHeight);
}
const hubHeightObserver = new ResizeObserver(scheduleHubHeight);
for (const el of [...hubPanes, hubHeadEl, hubFootEl])
	hubHeightObserver.observe(el);

// stagger the pane's children springing up (CSS `rise` keyframes, --i = order)
function playHubEntrance(container) {
	container.classList.remove("enter");
	const items = [];
	for (const c of container.children) {
		if (c.classList.contains("flat"))
			items.push(...c.children);
		else items.push(c);
	}
	items.forEach((c, i) => c.style.setProperty("--i", i));
	void container.offsetWidth; // restart the animation
	container.classList.add("enter");
	// once played, clear it: cards inserted later (data arriving, list rebuilds) shouldn't re-pop
	clearTimeout(container._enterTimer);
	container._enterTimer = setTimeout(
		() => container.classList.remove("enter"),
		1100,
	);
}

// the head of the hub, and its foot, are rows of widgets that the plugins bring (see head.js); the island only gives them
// their rows, and what the hub's panes do: show one by name (a plugin's page is a pane too)
host.setPane = (pane) => setHubPane(pane);
host.pane = () => currentPane;
if (!FLOATS) {
	head.mount(document.getElementById("hub-head"), document.getElementById("hub-foot"));
	head.init();
}

// nothing is on: the cards say what this is, and where to start
const blankEl = document.getElementById("blank");
document.getElementById("blank-ico").innerHTML = li("plug");
function updateBlank() {
	blankEl.classList.toggle("hidden", head.enabledCount() > 0);
	scheduleHubHeight();
}
head.onEnabled(updateBlank);
document.getElementById("blank-go").addEventListener("click", () => {
	setHubPane("settings");
	showSettingsTab("plugins");
});
document.getElementById("blank-go").addEventListener("mousedown", (e) => e.stopPropagation());

// cursor spotlight: every .spot card gets the cursor position (relative to
// itself) as --mx/--my, which its CSS radial-gradient follows like a flashlight
const hubRoot = document.getElementById("hub");
let spotRaf = 0;
let spotEvent = null;
function updateSpots() {
	spotRaf = 0;
	if (!spotEvent) return;
	for (const el of hubRoot.querySelectorAll(".spot")) {
		const r = el.getBoundingClientRect();
		el.style.setProperty(
			"--mx",
			`${spotEvent.clientX - r.left}px`,
		);
		el.style.setProperty(
			"--my",
			`${spotEvent.clientY - r.top}px`,
		);
	}
}
hubRoot.addEventListener("mousemove", (e) => {
	spotEvent = e;
	hubRoot.classList.add("spot-on");
	if (!spotRaf) spotRaf = requestAnimationFrame(updateSpots);
});
hubRoot.addEventListener("mouseleave", () => {
	// keep --mx/--my where they were: the light fades out in place (--spot-a)
	spotEvent = null;
	hubRoot.classList.remove("spot-on");
});

listen("open-settings", () => {
	if (currentView === "hub") setHubPane("settings");
	else pendingSettingsPane = true;
});

// no native webview context menu on the island
// right-click pins the island in place (no hiding, no following the cursor to
// other monitors, hub stays open on click-outside) until right-clicked again.
// Feedback is a material-style ink ripple that floods the island from the click.
function inkRipple(x, y) {
	const r = pill.getBoundingClientRect();
	// radius that reaches the farthest corner from the click
	// (x1.3 so the soft edge of the gradient is still past the corner)
	const reach =
		1.3 *
		Math.hypot(
			Math.max(x, r.width - x),
			Math.max(y, r.height - y),
		);
	const dot = document.createElement("div");
	dot.className = "ink";
	dot.style.left = `${x - reach}px`;
	dot.style.top = `${y - reach}px`;
	dot.style.width = dot.style.height = `${reach * 2}px`;
	pill.append(dot);
	dot.addEventListener("animationend", (e) => {
		if (e.animationName === "ink-fade") dot.remove(); // the last of its two animations
	});
}

pill.addEventListener("contextmenu", (e) => {
	e.preventDefault();
	const r = pill.getBoundingClientRect();
	inkRipple(e.clientX - r.left, e.clientY - r.top);
	invoke("toggle_pin");
});
const lockBadge = document.getElementById("lock-badge");
listen("pin-tick", (event) => {
	faceEvent("blip"); // a little happy blip either way
	// a lock (pinned) or an open lock (unpinned) pops up at the centre of the island
	const pinned = !!event.payload;
	lockBadge.innerHTML = li(pinned ? "lock" : "unlock");
	lockBadge.classList.toggle("unlocked", !pinned);
	lockBadge.classList.remove("show");
	void lockBadge.offsetWidth;
	lockBadge.classList.add("show");
});

pill.addEventListener("mousedown", (e) => {
	if (e.button !== 0) return;
	// the open hub is a panel to work in: only its head (the eyes) takes the click that closes it
	if (currentView === "hub" && !e.target.closest("#hub-head, #hub-foot")) return;
	faceEvent("boop");
	invoke("drag_start");
});
// No mouseup/drag_end handler: `start_dragging()`'s native OS move-loop can
// swallow the DOM mouseup, so end-of-drag is detected Rust-side instead by
// polling the mouse button's real state -- see spawn_edge_poll in lib.rs.
// Hover (for pausing the idle-hide timer) is computed on the Rust side from
// the global cursor vs. the window's own rect -- see IslandState's doc
// comment in lib.rs for why webview mouseenter/leave aren't used for that.

// -- notification banner: driven by notification-tick, and (for now) a
// pushNotification() global any future subsystem can call to show one --
const notifEl = document.getElementById("notification");
const notifTitle = document.getElementById("notif-title");
const notifBody = document.getElementById("notif-body");
const notifTimer = document.getElementById("notif-timer");
document.getElementById("notif-icon").innerHTML = ICON.bell;

let notifId = 0; // its entry in the scrollback
listen("notification-tick", (event) => {
	const n = event.payload;
	if (!n) return; // dismissed -- view-tick already hid the banner
	if (n.brief) {
		showBrief(n);
		return;
	}
	notifId = n.id;
	notifTitle.textContent = n.title || "";
	notifBody.textContent = n.body || "";
	// restart the draining timer bar for this banner
	notifTimer.classList.remove("run");
	void notifTimer.offsetWidth;
	notifTimer.classList.add("run");
});

// clicking a banner expands the island and scrolls the list to the notification (it stays in the list: it is
// cleared by clicking its card, dragging it away, or "Clear all"); its mousedown must not reach #pill's drag handler
let pendingNotifFocus = 0;
notifEl.addEventListener("mousedown", (e) =>
	e.stopPropagation(),
);
notifEl.addEventListener("click", () => {
	pendingNotifFocus = notifId;
	invoke("open_hub_at_notification");
});

// scroll to the notification a banner brought you for, and let it glow for a moment
function focusPendingNotification() {
	const id = pendingNotifFocus;
	pendingNotifFocus = 0;
	if (!id) return;
	const item = notifHistoryEl.querySelector(`[data-id="${id}"]`);
	if (!item) return;
	const show = () => {
		if (!item.isConnected) return;
		item.scrollIntoView({ block: "center", behavior: "smooth" });
	};
	// (the hub is still growing to its height and the cards are still rising: scroll once it has settled)
	setTimeout(show, 450);
	setTimeout(show, 900);
	item.classList.remove("flash");
	void item.offsetWidth;
	item.classList.add("flash");
	setTimeout(() => item.classList.remove("flash"), 2400);
}

// -- a Claude Code session that needs you or finished: a compact pill from the same queue --
const briefEl = document.getElementById("brief");
const briefTile = document.getElementById("brief-tile");
const briefTitle = document.getElementById("brief-title");
const briefRight = document.getElementById("brief-right");
let briefCurrent = null;
function showBrief(n) {
	const b = n.brief;
	briefCurrent = b;
	// a plugin's pill: its icon, what it says, and a short text at the right; "big" is only light digits, glowing
	const plugin = b.state === "plugin";
	const big = plugin && b.look === "big";
	briefEl.classList.toggle("brief-time", big);
	briefEl.classList.toggle("brief-plugin", plugin);
	if (plugin) {
		briefTile.removeAttribute("style");
		briefTile.className = "pg-tile";
		briefTile.innerHTML = li(b.host_icon || "dot");
		const clock = big ? /^(\d+):(\d+)(?:\s*(AM|PM))?$/i.exec(n.title) : null;
		if (clock) {
			// the time: big light digits glowing in the theme colour, a blinking colon, nothing else
			briefTitle.replaceChildren(el("span", "", clock[1]), el("span", "time-sep", ":"), el("span", "", clock[2]));
			if (clock[3]) briefTitle.append(el("small", "time-suf", clock[3].toUpperCase()));
		} else {
			briefTitle.textContent = whenText(n.title);
		}
		briefRight.replaceChildren(el("span", "pg-right", whenText(b.project || "")));
		briefRight.classList.toggle("hidden", !b.project);
	} else {
		briefTile.className = "llm-tile";
		briefRight.classList.remove("hidden");
		briefTitle.textContent = n.title;
		briefTile.style.setProperty("--c", LLM_COLOR.claude);
		briefTile.innerHTML = `${LLM_LETTER.claude}<svg class="cr" viewBox="0 0 40 40"><circle class="rb" cx="20" cy="20" r="18"/><circle class="rf" cx="20" cy="20" r="18"/></svg>`;
		const rf = briefTile.querySelector(".rf");
		rf.style.strokeDasharray = String(LLM_RING_C);
		rf.style.strokeDashoffset = String(LLM_RING_C * (1 - b.ctx));
		rf.style.stroke = llmCtxColor(b.ctx);
		const host = el("span", "llm-host");
		host.innerHTML = li(b.host_icon);
		briefRight.replaceChildren(host, llmStateIcon(b.state));
	}
	document.body.dataset.brief = b.state;
	// already a brief on screen (the queue moved on): the glow and the entrance start again
	if (currentView === "brief") {
		document.body.classList.remove("glow");
		void document.body.offsetWidth;
		document.body.classList.add("glow");
		playEnter(briefEl);
	}
}
briefEl.addEventListener("mousedown", (e) =>
	e.stopPropagation(),
);
briefEl.addEventListener("click", () => {
	if (!briefCurrent) return;
	if (briefCurrent.state === "plugin") {
		invoke("open_notification_action", { action: "brief" }); // just closes it
		return;
	}
	invoke("focus_source", {
		exePath: briefCurrent.host_exe,
		titleHint: briefCurrent.project,
	});
	if (briefCurrent.state === "finished")
		call("claude-code", "dismiss", { id: briefCurrent.id }).catch(() => {});
	invoke("open_notification_action", { action: "brief" }); // ends the pill
});

window.pushNotification = (title, body) =>
	invoke("push_notification", { title, body });

// -- notification history: the hub's scrollback of past banners --
const notifHistoryEl = document.getElementById("notif-history");

// a card dragged sideways follows the pointer; let go past a third of its width (or with a flick) and it is
// dismissed, else it springs back. The click that ends a drag is not a click.
function makeSwipeable(item, dismissItem) {
	let down = null;
	let moved = false;
	item.style.touchAction = "pan-y";
	item.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || e.target.closest(".notif-x")) return;
		down = { id: e.pointerId, x: e.clientX, t: performance.now(), lastX: e.clientX, lastT: performance.now(), v: 0 };
		moved = false;
	});
	item.addEventListener("pointermove", (e) => {
		if (!down || e.pointerId !== down.id) return;
		const dx = e.clientX - down.x;
		if (!moved) {
			if (Math.abs(dx) < 6) return;
			moved = true;
			item.setPointerCapture(e.pointerId);
			item.classList.add("swiping");
			item.style.transition = "none";
		}
		const now = performance.now();
		if (now > down.lastT) down.v = (e.clientX - down.lastX) / (now - down.lastT);
		down.lastX = e.clientX;
		down.lastT = now;
		const w = item.offsetWidth || 1;
		item.style.transform = `translateX(${dx}px)`;
		item.style.opacity = String(Math.max(0.15, 1 - Math.abs(dx) / w));
	});
	const end = (e) => {
		if (!down || e.pointerId !== down.id) return;
		const d = down;
		down = null;
		if (!moved) return;
		const dx = e.clientX - d.x;
		const w = item.offsetWidth || 1;
		item.classList.remove("swiping");
		const gone = Math.abs(dx) > w / 3 || (Math.abs(d.v) > 0.6 && Math.abs(dx) > 30);
		if (gone && e.type === "pointerup") {
			const to = (dx < 0 ? -1 : 1) * (w + 40);
			item.style.transition = "transform 0.2s cubic-bezier(0.4, 0, 0.9, 0.6), opacity 0.2s ease";
			item.style.transform = `translateX(${to}px)`;
			item.style.opacity = "0";
			setTimeout(dismissItem, 190);
		} else {
			item.style.transition = "transform 0.4s var(--spring), opacity 0.25s ease";
			item.style.transform = "";
			item.style.opacity = "";
			setTimeout(() => (item.style.transition = ""), 420);
		}
	};
	item.addEventListener("pointerup", end);
	item.addEventListener("pointercancel", end);
	// (the click a drag ends with: swallowed, before anything else hears it)
	item.addEventListener(
		"click",
		(e) => {
			if (moved) {
				moved = false;
				e.stopImmediatePropagation();
			}
		},
		true,
	);
}

function renderNotificationHistory(entries) {
	notifHistoryEl.innerHTML = "";
	if (!entries || entries.length === 0) {
		updateInfoEmpty();
		return;
	}
	// the head of the list: what it is, and (while the island is hovered) a button that clears it all
	const bar = document.createElement("div");
	bar.className = "notif-bar";
	const label = document.createElement("span");
	label.textContent = "Notifications";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "notif-clear";
	clear.textContent = "Clear all";
	clear.addEventListener("mousedown", (e) => e.stopPropagation());
	clear.addEventListener("click", () => {
		// (they slide off one after another, then Rust forgets them)
		const items = [...notifHistoryEl.querySelectorAll(".notif-history-item")];
		items.forEach((it, i) => {
			it.style.transition = `transform 0.25s cubic-bezier(0.5, 0, 0.9, 0.6) ${Math.min(i, 8) * 35}ms, opacity 0.25s ease ${Math.min(i, 8) * 35}ms`;
			it.style.transform = "translateX(48px)";
			it.style.opacity = "0";
			it.style.pointerEvents = "none";
		});
		clear.disabled = true;
		setTimeout(() => invoke("clear_notifications"), 250 + Math.min(items.length, 9) * 35);
	});
	bar.append(label, clear);
	notifHistoryEl.appendChild(bar);
	for (const entry of entries) {
		const item = document.createElement("div");
		item.className = "notif-history-item spot";
		item.dataset.id = String(entry.id);
		// dismiss: the card slides off and folds away, then Rust forgets it
		const dismissItem = () => {
			item.style.transition = "";
			item.style.height = `${item.offsetHeight}px`;
			void item.offsetWidth; // commit the explicit height so it can transition to 0
			item.classList.add("leaving");
			setTimeout(
				() =>
					invoke("dismiss_notification", {
						id: entry.id,
					}),
				280,
			);
		};
		// clicking a card clears it (the x does the same without going anywhere, and so does dragging it away);
		// one with an action also jumps to its source app
		item.classList.add("clickable");
		item.addEventListener("mousedown", (e) =>
			e.stopPropagation(),
		);
		item.addEventListener("click", () => {
			if (entry.action)
				invoke("open_notification_action", {
					action: entry.action,
				});
			dismissItem();
		});
		makeSwipeable(item, dismissItem);

		const dismiss = document.createElement("button");
		dismiss.className = "notif-x";
		dismiss.setAttribute("aria-label", "Dismiss");
		dismiss.innerHTML =
			'<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>';
		dismiss.addEventListener("mousedown", (e) =>
			e.stopPropagation(),
		);
		dismiss.addEventListener("click", (e) => {
			e.stopPropagation(); // dismiss only, don't also open the source
			dismissItem();
		});
		item.appendChild(dismiss);

		const title = document.createElement("div");
		title.className = "notif-history-title";
		title.textContent = entry.title || "";
		item.appendChild(title);

		if (entry.body) {
			const body = document.createElement("div");
			body.className = "notif-history-body";
			body.textContent = entry.body;
			item.appendChild(body);
		}

		const time = document.createElement("div");
		time.className = "notif-history-time";
		time.textContent = new Date(
			entry.time_ms,
		).toLocaleString([], {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		item.appendChild(time);

		notifHistoryEl.appendChild(item);
	}
	updateInfoEmpty();
}

async function loadNotificationHistory() {
	renderNotificationHistory(
		await invoke("get_notification_history"),
	);
	focusPendingNotification();
}

listen("notification-history-tick", (event) => {
	// only bother re-rendering if the hub is actually open to see it
	if (currentView === "hub") {
		renderNotificationHistory(event.payload);
	}
});

// -- hub: the pill expanded into a panel, toggled by clicking the pill
// (see drag_end in lib.rs -- a click is just a drag that went nowhere).
// Its eyes + clock are canvas-painted every frame in paintHubEyes() above,
// same as the idle pill's, so they stay live (blink/gaze-track) while open.
const hubEl = document.getElementById("hub");

// -- icons on the static markup: clear buttons, and the plugin list's tools --
(function decorate() {
	for (const b of document.querySelectorAll(".hub-btn-x"))
		b.innerHTML = li("x");
	document.getElementById("plugin-add").innerHTML = li("plus");
	document.getElementById("plugin-folder").innerHTML = li("folder");
	document.getElementById("plugin-rescan").innerHTML = li("refresh");
})();

// -- hub settings: loaded fresh each time the hub opens, saved back to
// Rust (which persists to disk and live-updates the detection threads)
// on every change --
const setStartWithWindows = document.getElementById(
	"set-start-with-windows",
);
const setIdleHideDelay = document.getElementById(
	"set-idle-hide-delay",
);
const setIdleHideDelayLabel = document.getElementById(
	"set-idle-hide-delay-label",
);

const setShowAtCursor = document.getElementById(
	"set-show-at-cursor",
);
// the theme colour: a handful of swatches; the accent of the hub, the glow and the pills follows
const ACCENTS = [
	"#5ac88c",
	"#4cc9c0",
	"#5aa9f0",
	"#a487ee",
	"#ee7fb5",
	"#e8776f",
	"#ee9a4d",
	"#e3c457",
	"#e8e8ee",
];
let accentColor = ACCENTS[0];
function applyAccent(hex) {
	if (!/^#[0-9a-f]{6}$/i.test(hex || "")) hex = ACCENTS[0];
	accentColor = hex.toLowerCase();
	const n = parseInt(accentColor.slice(1), 16);
	const [r, g, b] = [
		(n >> 16) & 255,
		(n >> 8) & 255,
		n & 255,
	];
	const rs = document.documentElement.style;
	rs.setProperty("--accent", accentColor);
	rs.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
	// a lighter tint of it, for the edge glow
	rs.setProperty(
		"--accent-light-rgb",
		`${Math.round(r + (255 - r) * 0.28)}, ${Math.round(g + (255 - g) * 0.28)}, ${Math.round(b + (255 - b) * 0.28)}`,
	);
	// the darker end of the accent's gradients
	rs.setProperty(
		"--accent-deep",
		`rgb(${Math.round(r * 0.62)}, ${Math.round(g * 0.62)}, ${Math.round(b * 0.62)})`,
	);
	for (const sw of document.querySelectorAll(
		"#set-accent .swatch",
	))
		sw.classList.toggle(
			"on",
			sw.dataset.color === accentColor,
		);
}
for (const hex of ACCENTS) {
	const sw = document.createElement("button");
	sw.type = "button";
	sw.className = "swatch";
	sw.dataset.color = hex;
	sw.style.background = hex;
	sw.setAttribute("aria-label", hex);
	sw.addEventListener("mousedown", (e) =>
		e.stopPropagation(),
	);
	sw.addEventListener("click", () => {
		applyAccent(hex);
		saveSettingsFromForm();
	});
	document.getElementById("set-accent").append(sw);
}
const setCursorFollow = document.getElementById(
	"set-cursor-follow",
);
const setPeekDuration = document.getElementById(
	"set-peek-duration",
);
const setPeekDurationLabel = document.getElementById(
	"set-peek-duration-label",
);
const setCompactWidth = document.getElementById(
	"set-compact-width",
);
const setCompactWidthLabel = document.getElementById(
	"set-compact-width-label",
);
const setHubWidth = document.getElementById("set-hub-width");
const setHubWidthLabel = document.getElementById(
	"set-hub-width-label",
);
const setTopMargin = document.getElementById("set-top-margin");
const setTopMarginLabel = document.getElementById(
	"set-top-margin-label",
);
const setPinShrink = document.getElementById("set-pin-shrink");
const setPinShrinkLabel = document.getElementById(
	"set-pin-shrink-label",
);
const pinShrinkText = (v) =>
	Number(v) >= 100 ? "off" : `${v}%`;
const setEdgeDwell = document.getElementById("set-edge-dwell");
const setEdgeDwellLabel = document.getElementById(
	"set-edge-dwell-label",
);
// the Fullscreen Guard: No, or on with Alt (or Ctrl) held to use the island anyway
const setFullscreenGuard = document.getElementById(
	"set-fullscreen-guard",
);
const guardValue = () =>
	setFullscreenGuard.querySelector('[aria-pressed="true"]')
		?.dataset.v || "alt";
const showGuard = (v) => {
	for (const b of setFullscreenGuard.querySelectorAll("button"))
		b.setAttribute("aria-pressed", String(b.dataset.v === v));
};
for (const b of setFullscreenGuard.querySelectorAll("button"))
	b.addEventListener("click", () => {
		showGuard(b.dataset.v);
		saveSettingsFromForm();
	});
const edgeDwellText = (ms) =>
	Number(ms) === 0 ? "off" : `${ms} ms`;
const setGlow = document.getElementById("set-glow");
const setGlowLabel = document.getElementById("set-glow-label");
const setBgDim = document.getElementById("set-bg-dim");
const setBgDimLabel = document.getElementById(
	"set-bg-dim-label",
);

let currentSettings = null;

async function loadSettingsIntoForm() {
	currentSettings = await invoke("get_settings");
	setStartWithWindows.checked =
		currentSettings.start_with_windows;
	setIdleHideDelay.value = currentSettings.idle_hide_delay_s;
	setIdleHideDelayLabel.textContent = `${currentSettings.idle_hide_delay_s}s`;
	setShowAtCursor.checked = currentSettings.show_at_cursor;
	setCursorFollow.checked = currentSettings.cursor_follow;
	applyAccent(currentSettings.accent_color);
	setCompactWidth.value =
		currentSettings.compact_width ?? 260;
	setCompactWidthLabel.textContent = `${setCompactWidth.value}px`;
	setHubWidth.value = currentSettings.hub_width ?? 420;
	setHubWidthLabel.textContent = `${setHubWidth.value}px`;
	setTopMargin.value = currentSettings.top_margin ?? 4;
	setTopMarginLabel.textContent = `${setTopMargin.value}px`;
	setPinShrink.value = currentSettings.pin_shrink ?? 75;
	setPinShrinkLabel.textContent = pinShrinkText(
		setPinShrink.value,
	);
	setEdgeDwell.value = currentSettings.edge_dwell_ms;
	setEdgeDwellLabel.textContent = edgeDwellText(
		currentSettings.edge_dwell_ms,
	);
	showGuard(
		currentSettings.fullscreen_guard === false
			? "off"
			: currentSettings.guard_key === "ctrl"
				? "ctrl"
				: "alt",
	);
	setPeekDuration.value = currentSettings.peek_duration_s;
	setPeekDurationLabel.textContent = `${currentSettings.peek_duration_s}s`;
	setGlow.value = currentSettings.glow_intensity ?? 70;
	setGlowLabel.textContent = `${setGlow.value}%`;
	applyGlow(Number(setGlow.value));
	setBgDim.value = currentSettings.bg_dim;
	setBgDimLabel.textContent = `${currentSettings.bg_dim}%`;
	applyBackgrounds(currentSettings);
	syncSliderResets();
	updateSizePreview();
}

// every slider gets a small reset button that shows only while it is off its default
function syncSliderResets() {
	for (const input of document.querySelectorAll(
		'input[type="range"][data-default]',
	)) {
		const btn = input.previousElementSibling;
		if (btn?.classList.contains("slider-reset"))
			btn.classList.toggle(
				"is-default",
				input.value === input.dataset.default,
			);
		// the filled part of the track
		const lo = Number(input.min);
		const span = Number(input.max) - lo;
		input.style.setProperty(
			"--p",
			`${(((Number(input.value) - lo) / span) * 100).toFixed(1)}%`,
		);
	}
}
for (const input of document.querySelectorAll(
	'input[type="range"][data-default]',
)) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "slider-reset is-default";
	btn.innerHTML = li("reset");
	btn.dataset.tip = "Reset to default";
	btn.addEventListener("mousedown", (e) =>
		e.stopPropagation(),
	);
	btn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		input.value = input.dataset.default;
		input.dispatchEvent(
			new Event("input", { bubbles: true }),
		);
		input.dispatchEvent(
			new Event("change", { bubbles: true }),
		);
	});
	input.addEventListener("input", syncSliderResets);
	input.before(btn);
}

function saveSettingsFromForm() {
	if (!currentSettings) return;
	currentSettings = {
		...currentSettings,
		start_with_windows: setStartWithWindows.checked,
		idle_hide_delay_s: Number(setIdleHideDelay.value),
		show_at_cursor: setShowAtCursor.checked,
		cursor_follow: setCursorFollow.checked,
		peek_duration_s: Number(setPeekDuration.value),
		edge_dwell_ms: Number(setEdgeDwell.value),
		fullscreen_guard: guardValue() !== "off",
		guard_key:
			guardValue() === "off"
				? currentSettings.guard_key || "alt"
				: guardValue(),
		pin_shrink: Number(setPinShrink.value),
		compact_width: Number(setCompactWidth.value),
		hub_width: Number(setHubWidth.value),
		top_margin: Number(setTopMargin.value),
		bg_dim: Number(setBgDim.value),
		glow_intensity: Number(setGlow.value),
	};
	currentSettings.accent_color = accentColor;
	updateClock();
	invoke("save_settings", { settings: currentSettings });
}

for (const el of [
	setStartWithWindows,
	setShowAtCursor,
	setCursorFollow,
]) {
	el.addEventListener("change", saveSettingsFromForm);
}
setIdleHideDelay.addEventListener("input", () => {
	setIdleHideDelayLabel.textContent = `${setIdleHideDelay.value}s`;
});
setIdleHideDelay.addEventListener(
	"change",
	saveSettingsFromForm,
);
setCompactWidth.addEventListener("input", () => {
	setCompactWidthLabel.textContent = `${setCompactWidth.value}px`;
});
setCompactWidth.addEventListener(
	"change",
	saveSettingsFromForm,
);
setHubWidth.addEventListener("input", () => {
	setHubWidthLabel.textContent = `${setHubWidth.value}px`;
});
setHubWidth.addEventListener("change", saveSettingsFromForm);
setTopMargin.addEventListener("input", () => {
	setTopMarginLabel.textContent = `${setTopMargin.value}px`;
});
setTopMargin.addEventListener("change", saveSettingsFromForm);
// ---- the settings tabs: four, each with its name ----
const SET_TABS = [
	{ id: "general", icon: "sliders", tip: "General" },
	{ id: "size", icon: "expand", tip: "Size" },
	{ id: "look", icon: "palette", tip: "Look" },
	{ id: "plugins", icon: "plug", tip: "Plugins" },
];
function showSettingsTab(id) {
	if (id === "plugins") renderPlugins();
	if (id === "size") updateSizePreview();
	for (const p of document.querySelectorAll(
		"#pane-settings .set-tab",
	))
		p.classList.toggle("hidden", p.dataset.tab !== id);
	for (const b of document.querySelectorAll(
		"#set-tabs button",
	)) {
		b.classList.toggle("on", b.dataset.tab === id);
		b.setAttribute(
			"aria-selected",
			String(b.dataset.tab === id),
		);
	}
	try {
		localStorage.setItem("nadi.settingsTab", id);
	} catch (_) {}
	scheduleHubHeight();
}
{
	const bar = document.getElementById("set-tabs");
	for (const t of SET_TABS) {
		const b = document.createElement("button");
		b.type = "button";
		b.dataset.tab = t.id;
		b.setAttribute("role", "tab");
		b.innerHTML = `${li(t.icon)}<span>${t.tip}</span>`;
		b.addEventListener("mousedown", (e) =>
			e.stopPropagation(),
		);
		b.addEventListener("click", () =>
			showSettingsTab(t.id),
		);
		bar.append(b);
	}
	let first = "general";
	try {
		const saved = localStorage.getItem("nadi.settingsTab");
		if (SET_TABS.some((t) => t.id === saved)) first = saved;
	} catch (_) {}
	showSettingsTab(first);
	// the pencil arranges the head and the foot (it closes the settings, as the cards are what is arranged around); the cross
	// closes them (the settings page has no button to it in the head: the tray opens it)
	const edit = document.createElement("button");
	edit.type = "button";
	edit.id = "head-edit";
	edit.className = "set-edit";
	edit.setAttribute("aria-label", "Arrange the widgets");
	edit.dataset.tip = "Arrange the widgets";
	edit.innerHTML = li("pen");
	edit.addEventListener("mousedown", (e) => e.stopPropagation());
	edit.addEventListener("click", () => head.startEdit());
	bar.append(edit);
	const close = document.createElement("button");
	close.type = "button";
	close.className = "set-close";
	close.setAttribute("aria-label", "Close the settings");
	close.dataset.tip = "Back to the cards";
	close.innerHTML = li("x");
	close.addEventListener("mousedown", (e) => e.stopPropagation());
	close.addEventListener("click", () => setHubPane("info"));
	bar.append(close);
}
setPinShrink.addEventListener("input", () => {
	setPinShrinkLabel.textContent = pinShrinkText(
		setPinShrink.value,
	);
});
setPinShrink.addEventListener("change", saveSettingsFromForm);
setEdgeDwell.addEventListener("input", () => {
	setEdgeDwellLabel.textContent = edgeDwellText(
		setEdgeDwell.value,
	);
});
setEdgeDwell.addEventListener("change", saveSettingsFromForm);
setPeekDuration.addEventListener("input", () => {
	setPeekDurationLabel.textContent = `${setPeekDuration.value}s`;
});
setPeekDuration.addEventListener(
	"change",
	saveSettingsFromForm,
);
function applyGlow(pct) {
	document.documentElement.style.setProperty(
		"--gi",
		(pct / 100).toFixed(2),
	);
}
let glowPreviewTimer = 0;
setGlow.addEventListener("input", () => {
	setGlowLabel.textContent = `${setGlow.value}%`;
	applyGlow(Number(setGlow.value)); // live preview while dragging
	document.body.classList.add("glow-preview");
	clearTimeout(glowPreviewTimer);
	glowPreviewTimer = setTimeout(
		() => document.body.classList.remove("glow-preview"),
		900,
	);
});
setGlow.addEventListener("change", saveSettingsFromForm);
setBgDim.addEventListener("input", () => {
	setBgDimLabel.textContent = `${setBgDim.value}%`;
	applyBgDim(Number(setBgDim.value)); // live preview while dragging
});
setBgDim.addEventListener("change", saveSettingsFromForm);

// the Size tab's preview: the collapsed island and the expanded one behind it, at half their size
function updateSizePreview() {
	const k = 0.5;
	const top = 6 + Number(setTopMargin.value) * k * 0.5;
	const hub = document.getElementById("sp-hub");
	const pill = document.getElementById("sp-pill");
	hub.style.width = `${Number(setHubWidth.value) * k}px`;
	hub.style.top = pill.style.top = `${top}px`;
	pill.style.width = `${Number(setCompactWidth.value) * k}px`;
}
paneSettings.addEventListener("input", updateSizePreview);

// -- custom backgrounds: an image or video behind the collapsed island, and
// optionally a different one behind the expanded hub. Files live in the app's
// data folder and load via the asset protocol (video streams with range
// requests). Videos only play while the island is actually on screen, so a
// hidden island costs no decoding. --
const bgLayers = {
	compact: {
		el: document.getElementById("bg-compact"),
		path: "",
		media: null,
	},
	hub: {
		el: document.getElementById("bg-hub"),
		path: "",
		media: null,
	},
};
let bgDim = 0.5;
let islandShown = false;
const BG_VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;

function bgLabel(path) {
	// stored as "<kind>-<timestamp>-<original name>.<ext>"
	const file = path.split(/[\\/]/).pop() || "";
	return file.replace(/^(compact|hub)-\d+-/, "");
}

function setBgLayer(layer, path) {
	if (layer.path === path) return;
	layer.path = path;
	layer.el.textContent = "";
	layer.media = null;
	if (!path) return;
	const src = window.__TAURI__.core.convertFileSrc(path);
	let media;
	if (BG_VIDEO_RE.test(path)) {
		media = document.createElement("video");
		media.muted = true;
		media.loop = true;
		media.playsInline = true;
		media.disablePictureInPicture = true;
		media.preload = "auto";
	} else {
		media = document.createElement("img");
		media.alt = "";
		media.decoding = "async";
		media.draggable = false;
	}
	media.src = src;
	layer.media = media;
	layer.el.append(media);
}

function applyBgDim(pct) {
	bgDim = pct / 100;
	bgLayers.compact.el.style.setProperty("--dim", bgDim);
	// the hub is mostly text: a little more scrim than the compact views
	bgLayers.hub.el.style.setProperty(
		"--dim",
		Math.min(0.92, bgDim + 0.12),
	);
}

// which layer shows, and which videos are allowed to run
function updateBg() {
	const hubWanted =
		currentView === "hub" && !!bgLayers.hub.path;
	const compactWanted = !!bgLayers.compact.path && !hubWanted;
	bgLayers.hub.el.classList.toggle("active", hubWanted);
	bgLayers.compact.el.classList.toggle(
		"active",
		compactWanted,
	);
	const visible = islandShown && !document.hidden;
	for (const [layer, wanted] of [
		[bgLayers.hub, hubWanted],
		[bgLayers.compact, compactWanted],
	]) {
		const v = layer.media;
		if (!v || v.tagName !== "VIDEO") continue;
		if (wanted && visible) v.play().catch(() => {});
		else v.pause();
	}
}

function applyBackgrounds(s) {
	if (!s) return;
	setBgLayer(bgLayers.compact, s.bg_compact || "");
	setBgLayer(bgLayers.hub, s.bg_hub || "");
	applyBgDim(s.bg_dim ?? 50);
	applyGlow(s.glow_intensity ?? 70);
	updateBg();
	for (const kind of ["compact", "hub"]) {
		const path = s["bg_" + kind] || "";
		document.getElementById(`bg-name-${kind}`).textContent =
			path ? bgLabel(path) : "None";
		document.getElementById(`bg-pick-${kind}`).textContent =
			path ? "Change" : "Choose";
		document
			.getElementById(`bg-clear-${kind}`)
			.classList.toggle("hidden", !path);
	}
}

const bgErrorEl = document.getElementById("bg-error");
for (const kind of ["compact", "hub"]) {
	document
		.getElementById(`bg-pick-${kind}`)
		.addEventListener("click", async () => {
			bgErrorEl.textContent = "";
			try {
				const s = await invoke("pick_background", {
					kind,
				});
				if (s) {
					currentSettings = s;
					applyBackgrounds(s);
				}
			} catch (err) {
				bgErrorEl.textContent = String(err);
			}
		});
	document
		.getElementById(`bg-clear-${kind}`)
		.addEventListener("click", async () => {
			bgErrorEl.textContent = "";
			currentSettings = await invoke("clear_background", {
				kind,
			});
			applyBackgrounds(currentSettings);
		});
}
for (const id of [
	"bg-pick-compact",
	"bg-pick-hub",
	"bg-clear-compact",
	"bg-clear-hub",
]) {
	document
		.getElementById(id)
		.addEventListener("mousedown", (e) =>
			e.stopPropagation(),
		);
}
document.addEventListener("visibilitychange", updateBg);
// at startup: the backgrounds apply before the hub (and its form) is ever opened
invoke("get_settings").then((s) => {
	applyBackgrounds(s);
	applyAccent(s.accent_color); // from the start, not only once the settings were opened
});

// every settings row is a <label>, so clicking anywhere on it (not just the
// control) toggles/focuses it -- that click also bubbles up to #pill's own
// mousedown handler, which would otherwise read it as "click the hub
// background" and close the hub right as the user tries to change a setting
for (const row of document.querySelectorAll(".hub-row")) {
	row.addEventListener("mousedown", (e) =>
		e.stopPropagation(),
	);
}

// -- hub "Now" section: one media card per live session (live, from media-tick) + game / work /
// coding cards (polled from Rust while the hub is showing the info pane) --
const nowCardsEl = document.getElementById("now-cards");
let hubHasActivity = false;
// (an empty list just stays empty -- no placeholder text; callers still call this)
function updateInfoEmpty() {}


// ---- the plugins screen: every plugin in one list (the native ones, and the folders with a manifest)

// what a plugin asks to see, and a way to say no: shown before it is switched on, in a modal
async function confirmPlugin(p, item) {
	const answer = await askModal({
		id: `switch-on:${p.id}`,
		remember: "switch-on",
		width: 400,
		title: `Switch on ${p.name}?`,
		icon: { letter: (p.name || "?").trim().charAt(0).toUpperCase(), color: tintOf(p.id) },
		blocks: [
			p.permissions.length ? { facts: p.permissions.map((x) => ({ title: permName(x), text: x.why })) } : { text: "No permissions.", kind: "muted" },
		],
		buttons: [
			{ id: "no", label: "Cancel" },
			{ id: "yes", label: "Switch on", primary: true },
		],
	});
	// (no window to show it on: the same question, under the plugin's row)
	return answer ? answer.button === "yes" : confirmInline(p, item);
}

function confirmInline(p, item) {
	return new Promise((resolve) => {
		// inline, under the plugin's row: the island's window is only as tall as the hub, so an overlay would be cropped
		const box = el("div", "pg-dialog spot");
		box.append(el("h4", null, `Switch on ${p.name}?`));
		box.append(el("p", "pg-dialog-note", "Can access:"));
		const list = el("div", "pg-dialog-perms");
		for (const x of p.permissions) {
			const r = el("div", "pg-dialog-perm");
			r.append(el("b", null, permName(x)), el("span", null, x.why));
			list.append(r);
		}
		if (!p.permissions.length) list.append(el("div", "pg-dialog-perm", "No permissions."));
		box.append(list);
		const buttons = el("div", "pg-dialog-buttons");
		const no = el("button", "set-btn", "Cancel");
		const yes = el("button", "set-btn go", "Switch on");
		for (const b of [no, yes]) b.type = "button";
		const done = (v) => {
			box.remove();
			scheduleHubHeight();
			resolve(v);
		};
		no.addEventListener("click", () => done(false));
		yes.addEventListener("click", () => done(true));
		buttons.append(no, yes);
		box.append(buttons);
		item.append(box);
		scheduleHubHeight();
		box.scrollIntoView({ block: "nearest" });
		yes.focus({ preventScroll: true });
	});
}

// a permission as a badge reads it: what, and (when there is one) of what
const permName = (x) => (x.detail ? `${x.name} · ${x.detail}` : x.name);

// a plugin's tile: its first letter, in a colour its id picks
const PLUGIN_TINTS = ["#7fd1a0", "#8fb6f0", "#e6b070", "#b79af0", "#7fd1d1", "#d98fa8", "#c9c9d0"];
function tintOf(id) {
	let h = 0;
	for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return PLUGIN_TINTS[h % PLUGIN_TINTS.length];
}
// the plugins whose row is open stay open when the list is drawn again
const openPlugins = new Set();

// one plugin: a row (its name, one line about it, its switch) that opens to its settings and what it can see
function pluginItem(p, reload) {
	const item = el("div", `pl${p.enabled ? "" : " off"}`);
	const row = el("div", "prow");
	const open = openPlugins.has(p.id);
	const main = el("button", "pmain");
	main.type = "button";
	main.setAttribute("aria-expanded", String(open));
	const tile = el("span", "tile", (p.name || "?").trim().charAt(0).toUpperCase());
	tile.style.background = tintOf(p.id);
	const text = el("span", "ptext");
	const name = el("span", "pname", p.name);
	if (!p.bundled) name.append(el("span", "pg-tag", p.kind));
	// one line: what is wrong, else what it says of itself, else what it is
	const line = p.error || p.note || p.description || "";
	text.append(name, el("span", `pdesc${p.error ? " pg-err" : ""}`, line));
	const chev = el("span", `chev${open ? " open" : ""}`);
	chev.innerHTML = li("chevron");
	main.append(tile, text, chev);
	const cb = document.createElement("input");
	cb.type = "checkbox";
	cb.checked = p.enabled;
	cb.disabled = !!p.error && !p.enabled;
	cb.setAttribute("aria-label", p.name);
	cb.addEventListener("change", async () => {
		if (cb.checked) {
			// (the switch stays off until the answer is yes)
			cb.checked = false;
			if (!(await confirmPlugin(p, item))) return;
			cb.checked = true;
		}
		await invoke("plugin_set", { id: p.id, on: cb.checked });
		head.refreshEnabled();
		refreshActivity();
		reload();
	});
	row.append(main, cb);
	item.append(row);

	// what it says, what it can see, and (while it is on) what the user can set and its banners
	const more = el("div", "pg-more");
	more.hidden = !open;
	main.addEventListener("click", () => {
		const now = more.hidden;
		more.hidden = !now;
		main.setAttribute("aria-expanded", String(now));
		chev.classList.toggle("open", now);
		if (now) openPlugins.add(p.id);
		else openPlugins.delete(p.id);
		scheduleHubHeight();
	});
	if (p.description) more.append(el("div", "pg-about", p.description));
	if (p.error) more.append(el("div", "pg-about pg-err", p.error));
	// what it may do: a badge each, and the words of the question before it is switched on in a tooltip
	if (p.permissions.length) {
		const perms = el("div", "pg-perms");
		perms.append(el("span", "pg-perms-title", "Permissions"));
		for (const x of p.permissions) {
			const badge = el("span", "perm-badge", permName(x));
			badge.dataset.tip = x.why;
			perms.append(badge);
		}
		more.append(perms);
	}
	if (p.enabled) {
		for (const s of p.settings) {
			const f = el("label", "pg-field");
			f.append(el("span", null, s.label));
			if (s.type === "choice") {
				// one of a few: the island's button group
				const group = el("span", "opt-group pg-choice");
				group.setAttribute("role", "group");
				const buttons = s.options.map((o) => {
					const b = el("button", null, o.label);
					b.type = "button";
					b.setAttribute("aria-pressed", String(o.value === s.value));
					b.addEventListener("click", async (e) => {
						e.preventDefault();
						for (const x of buttons) x.setAttribute("aria-pressed", String(x === b));
						await invoke("plugin_value", { id: p.id, key: s.key, value: o.value });
					});
					group.append(b);
					return b;
				});
				f.append(group);
				more.append(f);
				continue;
			}
			if (s.type === "range") {
				// a slider: the value follows the thumb at once (the plugin may show it live), and is kept as it is let go
				const wrap = el("span", "pg-range");
				const r = document.createElement("input");
				r.type = "range";
				r.min = s.min ?? 0;
				r.max = s.max ?? 100;
				r.step = s.step ?? 1;
				r.value = s.value ?? s.min ?? 0;
				const val = el("span", "set-val");
				const paint = () => {
					val.textContent = `${r.value}${s.unit || ""}`;
					const span = Number(r.max) - Number(r.min) || 1;
					r.style.setProperty("--p", `${(((Number(r.value) - Number(r.min)) / span) * 100).toFixed(1)}%`);
				};
				paint();
				let sentAt = 0;
				r.addEventListener("input", () => {
					paint();
					const now = performance.now();
					if (now - sentAt > 80) {
						sentAt = now;
						invoke("plugin_value", { id: p.id, key: s.key, value: Number(r.value) });
					}
				});
				r.addEventListener("change", () => invoke("plugin_value", { id: p.id, key: s.key, value: Number(r.value) }));
				wrap.append(r, val);
				f.append(wrap);
				more.append(f);
				continue;
			}
			const inp = document.createElement("input");
			if (s.type === "toggle") {
				inp.type = "checkbox";
				inp.checked = !!s.value;
			} else {
				inp.type = s.type === "number" ? "number" : "text";
				if (s.type === "number") inp.step = "any";
				inp.value = s.value ?? "";
				inp.spellcheck = false;
			}
			inp.addEventListener("keydown", (e) => e.stopPropagation());
			inp.addEventListener("change", async () => {
				const v = s.type === "toggle" ? inp.checked : s.type === "number" ? Number(inp.value) : inp.value;
				await invoke("plugin_value", { id: p.id, key: s.key, value: v });
			});
			f.append(inp);
			more.append(f);
		}
		const foot = el("div", "pg-foot");
		// An action may need a word from the user (a code to paste): its field is always there, and what is put in it is kept
		// by itself (a pasted code, or Enter, or leaving the field); emptying the field takes it back. It is a secret, so its
		// letters are dots, and a field that holds something kept shows a row of dots.
		const asking = (p.actions || []).find((a) => a.ask);
		const ask = el("div", "pg-ask");
		const askErr = el("div", "pg-err");
		if (asking) {
			const SECRET = "•".repeat(12);
			let kept = asking.filled ? SECRET : "";
			const row = el("div", "pg-ask-row");
			const input = document.createElement("input");
			input.type = "password";
			input.autocomplete = "off";
			input.spellcheck = false;
			input.placeholder = asking.ask;
			input.setAttribute("aria-label", asking.ask);
			input.value = kept;
			const keep = async (text) => {
				if (text === kept) return;
				if (/^•+$/.test(text)) {
					input.value = kept; // (a dot or two deleted from the dots: nothing new)
					return;
				}
				askErr.textContent = "";
				try {
					await invoke("plugin_call", { id: p.id, cmd: asking.then, args: { text } });
				} catch (e) {
					askErr.textContent = String(e);
					return;
				}
				kept = text ? SECRET : "";
				input.value = kept;
				setTimeout(reload, 1500);
			};
			input.addEventListener("focus", () => {
				if (input.value === SECRET) input.select();
			});
			input.addEventListener("keydown", (e) => e.stopPropagation());
			input.addEventListener("paste", (e) => {
				const text = (e.clipboardData?.getData("text") || "").trim();
				if (!text) return;
				e.preventDefault();
				input.value = text;
				keep(text);
			});
			input.addEventListener("change", () => keep(input.value.trim()));
			const go = el("button", "set-btn", asking.label);
			go.type = "button";
			go.addEventListener("click", async () => {
				askErr.textContent = "";
				try {
					await invoke("plugin_call", { id: p.id, cmd: asking.id, args: null });
				} catch (e) {
					askErr.textContent = String(e);
					return;
				}
				input.focus();
			});
			row.append(input, go);
			ask.append(row, askErr);
		}
		for (const a of p.actions || []) {
			if (a.ask) continue; // (its button is by its field)
			const b = el("button", "set-btn", a.label);
			b.type = "button";
			b.addEventListener("click", async () => {
				try {
					await invoke("plugin_call", { id: p.id, cmd: a.id, args: null });
				} catch (e) {
					askErr.textContent = String(e);
					return;
				}
				setTimeout(reload, 1500);
			});
			foot.append(b);
		}
		if (p.banners) {
			// (a switch like the plugin's own settings: it is on or off)
			const f = el("label", "pg-field");
			f.append(el("span", null, "Mute banners"));
			const mute = document.createElement("input");
			mute.type = "checkbox";
			mute.checked = !!p.muted;
			mute.addEventListener("change", async () => {
				await invoke("plugin_mute", { id: p.id, muted: mute.checked });
				reload();
			});
			f.append(mute);
			more.append(f);
		}
		if (p.cost) foot.append(el("span", "pg-cost", p.cost));
		if (foot.childElementCount) more.append(foot);
		if (asking) more.append(ask);
	}
	item.append(more);
	return item;
}

async function renderPlugins() {
	let listing = { plugins: [], dnd: false };
	try {
		listing = (await invoke("plugin_list")) || listing;
	} catch (_) {}
	document.getElementById("plugin-dnd").checked = !!listing.dnd;
	document.getElementById("plugin-count").textContent = `Plugins · ${listing.plugins.length}`;
	// one list: the ones that ship with the app come first (the host orders them), then the folders
	// (the host lists the ones that ship with the app first, then the folders; the ones from a repository gather under its name)
	const list = [];
	const groups = new Map();
	for (const p of listing.plugins) {
		if (p.from) {
			const key = p.from.split(" ")[0];
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(p);
		} else list.push(pluginItem(p, renderPlugins));
	}
	for (const [repo, members] of groups) {
		const ref = members[0].from.slice(repo.length).trim();
		const head = el("div", "pg-group");
		head.append(el("b", null, repo), el("span", null, `${ref ? `${ref} · ` : ""}${members.length} ${members.length === 1 ? "plugin" : "plugins"}`));
		const up = el("button", "set-btn pg-update", "Check for updates");
		up.type = "button";
		up.addEventListener("click", () => addFromGitHub({ prefill: repo, tint: tintOf, onChange: renderPlugins }));
		head.append(up);
		list.push(head, ...members.map((p) => pluginItem(p, renderPlugins)));
	}
	// (nothing from a repository yet: the way to it, first)
	if (!groups.size) {
		const get = el("div", "pg-get");
		const words = el("div");
		words.append(el("b", null, "Get plugins"), el("span", null, "Time, Calendar and more, from Llyme/nadi-plugins."));
		const go = el("button", "set-btn go", "Browse");
		go.type = "button";
		go.addEventListener("click", () => addFromGitHub({ prefill: "Llyme/nadi-plugins", tint: tintOf, onChange: renderPlugins }));
		get.append(words, go);
		list.unshift(get);
	}
	document.getElementById("plugin-list").replaceChildren(...list);
	scheduleHubHeight();
	checkMoved(listing);
}

// Time and Calendar used to come inside the app: whoever had them on is asked once, at the start
let movedAsked = false;
function checkMoved(listing) {
	if (!listing?.moved?.length || movedAsked) return;
	movedAsked = true;
	askMoved({ moved: listing.moved, tint: tintOf, onChange: renderPlugins });
}
if (!FLOATS) setTimeout(() => invoke("plugin_list").then(checkMoved).catch(() => {}), 2500);
document.getElementById("plugin-dnd").addEventListener("change", (e) => invoke("plugin_dnd", { on: e.target.checked }));
document.getElementById("plugin-add").addEventListener("click", () => addFromGitHub({ tint: tintOf, onChange: renderPlugins }));
document.getElementById("plugin-folder").addEventListener("click", () => invoke("plugin_folder"));
document.getElementById("plugin-rescan").addEventListener("click", async () => {
	try {
		await invoke("plugin_rescan");
	} catch (_) {}
	renderPlugins();
});

let lastActivitySignature = "";
// All the cards of the moment, built: what the hub lists and what the floating cards are made from.
async function fetchCards() {
	const a = await invoke("get_activity");
	const cards = [];
	for (const p of plugins) if (a.cards?.[p.id]) cards.push(...(await p.cards(a.cards[p.id])));
	for (const p of a.plugins || []) cards.push(pluginCard(p));
	// (a stable sort: cards of one rank keep the order their plugin gave them)
	cards.sort((x, y) => (x._rank ?? 50) - (y._rank ?? 50));
	return { a, cards };
}

async function refreshActivity() {
	if (FLOATS) return refreshFloats();
	if (
		currentView !== "hub" ||
		paneInfo.classList.contains("hidden")
	)
		return;
	const built = await fetchCards();
	const a = built.a;
	setRings(a.rings || {});
	// the cards that float on the screen are not listed here
	floatKeys.clear();
	for (const i of await invoke("float_list")) floatKeys.add(i.key);
	const cards = built.cards.filter((c) => !floatKeys.has(c._key));
	const signature = cards
		.map((c) => c._sig ?? c.outerHTML)
		.join("");
	if (signature !== lastActivitySignature) {
		lastActivitySignature = signature;
		nowCardsEl.replaceChildren(...cards);
	} else {
		// same cards, new numbers: update in place so a click is never lost to a re-render
		cards.forEach((c, i) => {
			const old = nowCardsEl.children[i];
			if (old && old._update && c._data)
				old._update(c._data);
		});
	}
	hubHasActivity = cards.length > 0;
	updateInfoEmpty();
}
const refreshFloats = FLOATS
	? initFloats({ fetchCards, el, li, invoke, listen })
	: null;
setInterval(refreshActivity, 1000);

// -- tooltips: a single glass bubble instead of the native Win32 one. Any
// element with data-tip="Headline\nsub line" gets it (hub only -- the small
// pill has no room for one). Ring elements carry data-color for the dot. --
const tipEl = document.createElement("div");
tipEl.id = "tip";
document.body.append(tipEl);
let tipTarget = null;
let tipTimer = 0;

function renderTip(target) {
	// (a tooltip that is not words: an element, or a function that makes one each time)
	const rich = target._tipRich;
	tipEl.classList.toggle("rich", rich != null);
	if (rich != null) {
		let node = null;
		try {
			node = typeof rich === "function" ? rich() : rich.cloneNode(true);
		} catch (_) {}
		tipEl.replaceChildren(...(node ? [node] : []));
		return;
	}
	const [head, ...rest] = (target.dataset.tip || "").split(
		"\n",
	);
	const h = el("div", "tip-head");
	if (target.dataset.color) {
		const dot = el("span", "tip-dot");
		dot.style.background = target.dataset.color;
		h.append(dot);
	}
	h.append(document.createTextNode(head));
	tipEl.replaceChildren(h);
	if (rest.length)
		tipEl.append(el("div", "tip-sub", rest.join(" ")));
}

function placeTip(target) {
	const r = target.getBoundingClientRect();
	const tw = tipEl.offsetWidth;
	const th = tipEl.offsetHeight;
	const x = Math.max(
		8,
		Math.min(
			r.left + r.width / 2 - tw / 2,
			window.innerWidth - tw - 8,
		),
	);
	const below = r.bottom + 10 + th <= window.innerHeight - 4;
	const y = below ? r.bottom + 10 : r.top - th - 10;
	tipEl.style.left = `${x}px`;
	tipEl.style.top = `${y}px`;
	tipEl.style.transformOrigin = `${r.left + r.width / 2 - x}px ${below ? "0" : "100%"}`;
	tipEl.style.setProperty(
		"--tip-shift",
		below ? "-4px" : "4px",
	);
}

function showTip(target) {
	if (!target.dataset.tip || currentView !== "hub") return;
	tipTarget = target;
	renderTip(target);
	placeTip(target);
	tipEl.classList.add("show");
}

function hideTip() {
	clearTimeout(tipTimer);
	tipTarget = null;
	tipEl.classList.remove("show");
}

function refreshTip(target) {
	if (tipTarget === target) {
		renderTip(target);
		placeTip(target);
	}
}

document.addEventListener("mouseover", (e) => {
	const target = e.target.closest?.("[data-tip]");
	if (target === tipTarget) return;
	hideTip();
	if (target)
		tipTimer = setTimeout(() => showTip(target), 80);
});
document.addEventListener("mouseleave", hideTip);
document.addEventListener("mousedown", hideTip);
hubBody.addEventListener("scroll", hideTip);

// Every native title="..." (the plain Windows tooltip) becomes the glass tooltip above: its text moves
// to data-tip. Done for what is in the page now and for anything added or retitled later.
function adoptTitle(node) {
	if (node.nodeType !== 1 || !node.hasAttribute("title"))
		return;
	const text = node.getAttribute("title");
	if (text) node.dataset.tip = text;
	node.removeAttribute("title");
	if (node === tipTarget) refreshTip(node);
}
function adoptTitles(root) {
	adoptTitle(root);
	if (root.querySelectorAll)
		root.querySelectorAll("[title]").forEach(adoptTitle);
}
adoptTitles(document.body);
new MutationObserver((muts) => {
	for (const m of muts) {
		if (m.type === "attributes") adoptTitle(m.target);
		else m.addedNodes.forEach(adoptTitles);
	}
}).observe(document.body, {
	subtree: true,
	childList: true,
	attributes: true,
	attributeFilter: ["title"],
});

// what only this page can do, for the plugins' files (see kit.js)
host.scheduleHubHeight = scheduleHubHeight;
host.refreshTip = refreshTip;
host.setTip = (target, content) => {
	if (typeof content === "string") {
		target._tipRich = null;
		target.dataset.tip = content;
	} else {
		target._tipRich = content;
		target.dataset.tip = "rich";
	}
	if (target === tipTarget) refreshTip(target);
};
host.invalidate = () => (lastActivitySignature = "");
host.refresh = () => refreshActivity();
host.enter = playEnter;
for (const p of plugins) p.init?.();
initPluginUi();

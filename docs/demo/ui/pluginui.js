// What the island draws for a plugin that is not a page of its own: cards from blocks, a pill, rings in the hub. Every
// plugin that is not a Rust plugin with its own face (ui/plugins/*.js) goes through this, and so do those that want to:
// a module or a declarative plugin hands the island data (see plugins.rs: `CardOut`, `PillOut`, `RingOut`) and never any
// markup, so every text goes in as text, every picture is a `data:` raster, and a button only names an action.
import { guideReader } from "./reader.js";
import { FLOATS, ICON, LLM_RING_C, focusButton, addPill, addRing, call, collapsible, el, host, invoke, li, listen, llmStateIcon, peek, ringEls, setRing, textCol, view } from "./kit.js";

// ---------------------------------------------------------------------------------- a moment inside a text

const WHEN = /\{when:(-?\d+)(?::(day))?\}/g;

/** "Today 3:00 PM", "Tomorrow", "Fri, Oct 9 3:00 PM": how this viewer reads a moment (a plugin writes `{when:MS}` or `{when:MS:day}`) */
export function whenText(s) {
	if (typeof s !== "string" || !s.includes("{when:")) return s;
	return s.replace(WHEN, (_, ms, day) => {
		const d = new Date(Number(ms));
		const now = new Date();
		const same = d.toDateString() === now.toDateString();
		const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
		const name = same ? "Today" : tomorrow ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
		return day ? name : `${name} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
	});
}

/** a text that has a moment in it changes by itself at midnight: it is built again by the day */
const hasWhen = (s) => typeof s === "string" && s.includes("{when:");

// ----------------------------------------------------------------------------------------------- the blocks

/** the blocks a plugin can ask for, each built once and then updated in place as the numbers change */
export function pluginBlock(b, plugin, cardId = "") {
	const block = pluginBlockOf(b, plugin, cardId);
	block.kind = b.kind;
	return block;
}

function buttonRow(items, plugin) {
	const box = el("div", "pg-buttons");
	for (const it of items) {
		const b = el("button", it.icon ? "pg-b icon" : "pg-b");
		b.type = "button";
		b.title = it.label || "";
		// (the player's own filled icons, or one of the line icons)
		if (it.icon) b.innerHTML = Object.hasOwn(ICON, it.icon) ? ICON[it.icon] : li(it.icon);
		else b.textContent = it.label;
		// (the island's own press on a card must not take this one)
		b.addEventListener("mousedown", (e) => e.stopPropagation());
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			call(plugin, it.action).catch(() => {});
		});
		box.append(b);
	}
	return box;
}

const iconOf = (name) => (Object.hasOwn(ICON, name) ? ICON[name] : li(name));

/** a button of a player's own kind: a round icon (or its words when it has none), pressing it calls the plugin back */
function roundButton(it, plugin, cls) {
	const b = el("button", cls);
	b.type = "button";
	b.title = it.label || "";
	b.dataset.tip = it.label || "";
	b.dataset.icon = it.icon || "";
	if (it.icon) b.innerHTML = iconOf(it.icon);
	else b.textContent = it.label;
	b.addEventListener("mousedown", (e) => e.stopPropagation());
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		call(plugin, it.action).catch(() => {});
	});
	return b;
}

/** the buttons in a card's header, at the right */
function controlsRow(items, plugin) {
	const box = el("div", "now-controls");
	for (const it of items) box.append(roundButton(it, plugin, ""));
	return box;
}

// The bytes of a page's picture come once per picture (the card only holds its id); the island keeps the last few.
const pageImages = new Map();
async function showPageImage(img, plugin, id) {
	let src = pageImages.get(`${plugin}:${id}`);
	if (src === undefined) {
		try {
			src = (await invoke("browser_get", { plugin, what: "image", args: { id } })) || null;
		} catch (_) {
			src = null;
		}
		pageImages.set(`${plugin}:${id}`, src);
		if (pageImages.size > 12) pageImages.delete(pageImages.keys().next().value);
	}
	// (the card may have moved on to another picture while this was fetched)
	if (img.dataset.id !== String(id)) return;
	if (src) {
		img.src = src;
		img.classList.add("ready");
	} else {
		img.classList.remove("ready");
	}
	host.scheduleHubHeight();
}

function pictureNode(plugin, id) {
	const img = el("img", "pk-img");
	img.alt = "";
	img.draggable = false;
	img.dataset.id = String(id);
	showPageImage(img, plugin, id);
	return img;
}

function pluginBlockOf(b, plugin, cardId) {
	if (b.kind === "progress") {
		const bar = el("div", "pg-bar");
		const fill = el("i");
		bar.append(fill);
		return { node: bar, update: (n) => (fill.style.width = `${Math.round(n.value * 100)}%`) };
	}
	if (b.kind === "bars") {
		// meters: the heights follow the numbers (a live card sends them as they change)
		const box = el("div", "pg-bars");
		const bars = b.values.map(() => {
			const i = el("i");
			box.append(i);
			return i;
		});
		return {
			node: box,
			update: (n) => n.values.forEach((v, i) => bars[i] && (bars[i].style.height = `${Math.max(6, Math.round(v * 100))}%`)),
		};
	}
	if (b.kind === "text" && b.label) {
		// a paragraph that opens with a word in bold (the prompt a session is answering): two lines at most
		const p = el("p", "llm-prompt");
		return {
			node: p,
			update: (n) => {
				p.replaceChildren(el("b", "", n.label), document.createTextNode(whenText(n.text)));
				p.hidden = !n.text;
			},
		};
	}
	if (b.kind === "text" || b.kind === "badge") {
		const t = el("div", b.kind === "text" ? "pg-text" : "pg-badge");
		return { node: t, update: (n) => (t.textContent = whenText(n.text)) };
	}
	if (b.kind === "picture") {
		// the page's main picture, from the browser extension
		const img = pictureNode(plugin, b.id);
		return {
			node: img,
			update: (n) => {
				if (img.dataset.id !== String(n.id)) {
					img.dataset.id = String(n.id);
					showPageImage(img, plugin, n.id);
				}
			},
		};
	}
	if (b.kind === "reader") {
		// a guide laid out to be read (see reader.js): the words come from the island's own link to the browser extension, and
		// a press on a section asks the plugin to send the tab there
		const key = `plugin:${plugin}:${cardId}`;
		const ask = (cmd, args) => {
			if (cmd === "page_guide") return invoke("browser_get", { plugin, what: "guide", args });
			if (cmd === "page_guide_image") return invoke("browser_get", { plugin, what: "picture", args });
			return call(plugin, "go", { url: args.url, card: cardId }).then(() => true);
		};
		const holder = el("div", "pg-reader");
		const image = b.image != null ? pictureNode(plugin, b.image) : null;
		holder.append(
			guideReader({
				el,
				li,
				invoke: ask,
				key: b.key,
				exe: "",
				page: "",
				pageKey: key,
				image,
				onSize: host.scheduleHubHeight,
				onMoved: () => host.refresh(),
				onTyping: FLOATS ? (on) => invoke("float_typing", { on }) : null,
			}),
		);
		return { node: holder, update: () => {} };
	}
	if (b.kind === "lines") {
		// icon rows: what it is doing (lit), and what it did
		const box = el("div", "llm-feed");
		return {
			node: box,
			update: (n) =>
				box.replaceChildren(
					...n.rows.map((r) => {
						const row = el("div", r.now ? "llm-fr now" : "llm-fr");
						row.innerHTML = li(r.icon || "dot");
						row.append(el("span", "", whenText(r.text)));
						return row;
					}),
				),
		};
	}
	if (b.kind === "meter") {
		const box = el("div", "llm-ctx");
		const bar = el("i");
		const val = el("em");
		box.append(el("span"), bar, val);
		return {
			node: box,
			update: (n) => {
				box.firstChild.textContent = n.label;
				bar.style.setProperty("--v", `${Math.round(n.value * 100)}%`);
				if (n.color) bar.style.setProperty("--c", n.color);
				val.textContent = n.text;
			},
		};
	}
	if (b.kind === "stats") {
		const box = el("div", "llm-stats");
		const cells = b.items.map(() => {
			const cell = el("div", "llm-stat");
			const num = el("b");
			const name = el("span");
			cell.append(num, name);
			box.append(cell);
			return { num, name };
		});
		return {
			node: box,
			update: (n) =>
				n.items.forEach((it, i) => {
					if (!cells[i]) return;
					cells[i].num.textContent = it.value;
					cells[i].name.textContent = it.label;
				}),
		};
	}
	if (b.kind === "facts") {
		const box = el("div", "pk-fields");
		const vs = b.rows.map(([k]) => {
			const r = el("div", "pk-row");
			const v = el("div", "pk-v");
			r.append(el("div", "pk-k", k), v);
			box.append(r);
			return v;
		});
		return { node: box, update: (n) => n.rows.forEach((r, i) => vs[i] && (vs[i].textContent = whenText(r[1]))) };
	}
	if (b.kind === "image") {
		const img = el("img", "pg-img");
		img.alt = "";
		img.draggable = false;
		return { node: img, update: (n) => img.getAttribute("src") !== n.src && (img.src = n.src) };
	}
	if (b.kind === "seek") {
		// a thin bar that can be pressed: where, as a part of its width, goes back to the plugin
		const bar = el("div", "pg-bar pg-seek");
		const fill = el("i");
		bar.append(fill);
		bar.addEventListener("mousedown", (e) => e.stopPropagation());
		bar.addEventListener("click", (e) => {
			const r = bar.getBoundingClientRect();
			const fraction = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
			fill.style.width = `${Math.round(fraction * 100)}%`;
			call(plugin, b.action, { fraction }).catch(() => {});
		});
		if (!b.before?.length && !b.after?.length) return { node: bar, update: (n) => (fill.style.width = `${Math.round(n.value * 100)}%`) };
		// with buttons at its sides it is a player's row: a jump back, the bar, a jump forward and the speed
		bar.className = "now-seek";
		fill.className = "hub-media-seek-fill";
		const row = el("div", "media-extra");
		const side = (items) => items.map((it) => roundButton(it, plugin, it.icon ? "media-jump" : "media-rate"));
		const left = side(b.before || []);
		const right = side(b.after || []);
		row.append(...left, bar, ...right);
		const all = [...(b.before || []), ...(b.after || [])];
		return {
			node: row,
			update: (n) => {
				fill.style.width = `${Math.round(n.value * 100)}%`;
				// (a button's words change, the speed: the buttons themselves stay)
				[...left, ...right].forEach((btn, i) => {
					const now = [...(n.before || []), ...(n.after || [])][i];
					if (now && !all[i].icon && btn.textContent !== now.label) btn.textContent = now.label;
				});
			},
		};
	}
	if (b.kind === "graph") {
		// a line through numbers (frame times, a speed), from 0 to `max`, with a faint line at each mark; drawn as shapes, from numbers only
		const NS = "http://www.w3.org/2000/svg";
		const box = el("div", "pg-graph");
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("viewBox", "0 0 120 54");
		svg.setAttribute("preserveAspectRatio", "none");
		const part = (cls) => {
			const p = document.createElementNS(NS, "path");
			p.setAttribute("class", cls);
			return p;
		};
		const area = part("a");
		const line = part("l");
		const marks = part("g");
		svg.append(area, line, marks);
		box.append(svg);
		return {
			node: box,
			update: (n) => {
				const y = (v) => (52 - Math.min(v / (n.max || 1), 1) * 50).toFixed(1);
				const pts = n.values.map((v, i) => `${i ? "L" : "M"}${((i / Math.max(1, n.values.length - 1)) * 120).toFixed(1)} ${y(v)}`).join(" ");
				line.setAttribute("d", pts);
				area.setAttribute("d", n.values.length > 1 ? `${pts} L120 54 L0 54 Z` : "");
				marks.setAttribute("d", n.marks.map((m) => `M0 ${y(m)} L120 ${y(m)}`).join(" "));
			},
		};
	}
	if (b.kind === "buttons") {
		// (rebuilt when the buttons change: see the card's signature)
		return { node: buttonRow(b.items, plugin), update: () => {} };
	}
	// a list: a title and a line under it, and a bar when the row has a progress
	const list = el("div", "pg-list");
	const rows = b.rows.map((r) => {
		const row = el("div", "pg-li");
		const title = el("span", "pg-li-t");
		const sub = el("span", "pg-li-s");
		row.append(title, sub);
		let fill = null;
		if (r.progress != null) {
			const bar = el("div", "pg-bar");
			fill = el("i");
			bar.append(fill);
			row.append(bar);
		}
		list.append(row);
		return { title, sub, fill };
	});
	return {
		node: list,
		update: (n) =>
			n.rows.forEach((r, i) => {
				const x = rows[i];
				if (!x) return;
				x.title.textContent = whenText(r.title);
				x.sub.textContent = whenText(r.sub);
				if (x.fill && r.progress != null) x.fill.style.width = `${Math.round(r.progress * 100)}%`;
			}),
	};
}

// -------------------------------------------------------------------------------------------------- the card

const blockSig = (b) =>
	b.kind +
	(b.action || "") +
	(b.before || b.after ? [...(b.before || []), ...(b.after || [])].map((i) => i.action).join("|") : "") +
	(b.rows ? `${b.rows.length}${b.rows.map((r) => (r.progress != null ? "p" : "")).join("")}` : b.kind === "graph" ? "" : b.values ? b.values.length : b.items ? b.items.map((i) => `${i.action}/${i.icon}/${i.label}`).join("|") : "");

export function pluginCard(c) {
	const card = el("div", "now-card spot pg-card");
	const row = el("div", "now-row");
	const tile = el("div", "now-icon tile");
	tile.innerHTML = li(c.icon);
	// (a picture of its own in place of the icon: what is playing has its cover)
	const art = el("img", "pg-art hidden");
	art.alt = "";
	art.draggable = false;
	tile.append(art);
	// (or a letter in a colour with a ring around it: how full something is)
	let ring = null;
	let letter = null;
	if (c.tile) {
		letter = el("div", "llm-tile");
		letter.innerHTML = `<span></span><svg class="cr" viewBox="0 0 40 40"><circle class="rb" cx="20" cy="20" r="18"/><circle class="rf" cx="20" cy="20" r="18"/></svg>`;
		ring = letter.querySelector(".rf");
		ring.style.strokeDasharray = String(LLM_RING_C);
	}
	const col = textCol(c.title, c.sub);
	row.append(letter || tile, col);
	card.classList.toggle("llm-card", !!(c.tile || c.tone));
	// (the second line may open with an icon, and read as what it is doing)
	const subLine = col.querySelector(".now-sub");
	// (small icons at the right, and how it stands as one icon)
	const right = c.badges?.length || c.tone ? el("div", "llm-right") : null;
	if (right) row.append(right);
	let lastTone = null;
	// (a player's buttons sit in the header, as they always did)
	const controls = c.controls?.length ? controlsRow(c.controls, c.plugin) : null;
	if (controls) row.append(controls);
	card.append(row);
	const body = el("div", "work-body pg-body");
	const blocks = c.body.map((b) => pluginBlock(b, c.plugin, c.id || ""));
	for (const b of blocks) body.append(b.node);
	if (blocks.length) card.append(body);
	const update = (d) => {
		if (art.getAttribute("src") !== (d.image || null)) {
			if (d.image) art.src = d.image;
			else art.removeAttribute("src");
		}
		art.classList.toggle("hidden", !d.image);
		tile.classList.toggle("has-art", !!d.image);
		// (play turns into pause: the icon changes, the button stays)
		d.controls?.forEach((it, i) => {
			const btn = controls?.children[i];
			if (btn && btn.dataset.icon !== it.icon) {
				btn.dataset.icon = it.icon;
				btn.innerHTML = iconOf(it.icon);
				btn.dataset.tip = btn.title = it.label || "";
			}
		});
		col.querySelector(".now-title").textContent = whenText(d.title);
		if (d.sub_icon || d.tone) {
			subLine.className = `now-sub llm-live ${d.tone || ""}`;
			subLine.innerHTML = d.sub_icon ? li(d.sub_icon) : "";
			subLine.append(el("span", "", whenText(d.sub)));
		} else {
			subLine.textContent = whenText(d.sub);
		}
		if (d.tile && letter) {
			letter.style.setProperty("--c", d.tile.color);
			letter.firstChild.textContent = d.tile.text;
			if (d.tile.ring != null) {
				ring.style.strokeDashoffset = String(LLM_RING_C * (1 - d.tile.ring));
				ring.style.stroke = d.tile.ring_color;
			}
			ring.parentElement.style.display = d.tile.ring == null ? "none" : "";
		}
		card.classList.toggle("llm-waiting", d.tone === "waiting");
		if (right && (d.tone !== lastTone || !right.firstChild)) {
			lastTone = d.tone;
			right.replaceChildren();
			for (const b of d.badges || []) {
				const host = el("span", "llm-host");
				host.innerHTML = li(b.icon);
				host.dataset.tip = b.tip;
				right.append(host);
			}
			if (d.tone) right.append(llmStateIcon(d.tone));
		}
		const pk = card.querySelector(".now-peek");
		if (pk) pk.textContent = whenText(d.peek);
		d.body.forEach((n, i) => blocks[i] && blocks[i].kind === n.kind && blocks[i].update(n));
	};
	if (c.peek) peek(card, c.peek);
	update(c);
	// the cards are rebuilt only when their shape changes; new numbers go in place
	card._sig = `pg:${c.plugin}:${c.id || ""}:${c.icon}:${c.peek ? "p" : ""}:${c.tile ? "t" : ""}:${(c.badges || []).length}:${(c.controls || []).map((i) => i.action).join("|")}:${c.body.map(blockSig).join(",")}`;
	// (a moment in a text reads "Today" or "Tomorrow", which change at midnight: rebuilt by the day)
	if ([c.title, c.sub, c.peek, JSON.stringify(c.body)].some(hasWhen)) card._sig += `:${new Date().toDateString()}`;
	card._data = c;
	card._update = update;
	card._rank = c.rank || 70;
	card.dataset.plugin = c.plugin;
	card.addEventListener("mousedown", (e) => e.stopPropagation());
	const wrapped = collapsible(card, `plugin:${c.plugin}${c.id ? `:${c.id}` : ""}`);
	// (the icon goes to what the card is about: the browser window of a page)
	if (c.focus) focusButton(wrapped, () => call(c.plugin, c.focus, { card: c.id || "" }).catch(() => {}));
	// (wide enough, a page's picture moves to the side: see .wide in hub.css)
	if (c.body.some((b) => b.kind === "picture" || (b.kind === "reader" && b.image != null))) {
		new ResizeObserver(() => card.classList.toggle("wide", card.clientWidth >= 520)).observe(card);
	}
	return wrapped;
}

// a live card (a meter) is sent as it changes, not when the next poll comes
listen("plugin-frame", (e) => {
	const c = e.payload;
	for (const card of document.querySelectorAll(".pg-card[data-plugin]")) {
		if (card.dataset.plugin === c.plugin && card._update) {
			card._data = c;
			card._update(c);
		}
	}
});

// --------------------------------------------------------------------------------------------------- the pill

const pgPills = new Map(); // plugin id -> its pill's parts

function pillParts(id) {
	let p = pgPills.get(id);
	if (p) return p;
	const node = addPill(
		`pg-${id}`,
		`<div class="pg-tile"><img class="pg-art hidden" alt="" draggable="false" /></div>
		<div class="text-col"><div class="line-main"></div><div class="line-sub"></div></div>
		<div class="pg-rows"></div>
		<span class="pg-meters"></span>
		<span class="pg-right"></span>
		<span class="pg-pbuttons"></span>
		<div class="pg-pbar"><i></i></div>`,
	);
	node.classList.add("pg-pill");
	p = {
		node,
		tile: node.querySelector(".pg-tile"),
		art: node.querySelector(".pg-art"),
		main: node.querySelector(".line-main"),
		sub: node.querySelector(".line-sub"),
		meters: node.querySelector(".pg-meters"),
		rows: node.querySelector(".pg-rows"),
		text: node.querySelector(".text-col"),
		right: node.querySelector(".pg-right"),
		buttons: node.querySelector(".pg-pbuttons"),
		bar: node.querySelector(".pg-pbar"),
		fill: node.querySelector(".pg-pbar i"),
		icon: "",
		sig: "",
	};
	node.addEventListener("mousedown", (e) => e.target.closest("button") && e.stopPropagation());
	pgPills.set(id, p);
	// the island may already be on this pill (the pill came before its content did)
	node.classList.toggle("hidden", view.name !== `pg-${id}`);
	if (view.name === `pg-${id}`) host.enter?.(node);
	return p;
}

function setPill(pill) {
	const p = pillParts(pill.plugin);
	// (a pill that comes by itself, to say something, glows like a banner: main.js reads this)
	p.node.dataset.brief = pill.brief ? "1" : "";
	if (p.icon !== pill.icon) {
		p.icon = pill.icon;
		p.tile.innerHTML = li(pill.icon);
		p.tile.append(p.art);
	}
	// ("keep": the same picture as before, not sent again)
	if (pill.image !== "keep" && p.art.getAttribute("src") !== (pill.image || null)) {
		if (pill.image) p.art.src = pill.image;
		else p.art.removeAttribute("src");
	}
	const shown = pill.image === "keep" ? !!p.art.getAttribute("src") : !!pill.image;
	p.art.classList.toggle("hidden", !shown);
	p.tile.classList.toggle("has-art", shown);
	p.node.classList.toggle("pg-big", pill.look === "big");
	p.main.textContent = whenText(pill.title);
	p.sub.textContent = whenText(pill.sub);
	p.sub.classList.toggle("hidden", !pill.sub);
	// rows of a label, a bar and a number (a limit that moved): the bars slide to the new numbers
	const rows = pill.rows || [];
	p.node.classList.toggle("pg-has-rows", rows.length > 0);
	p.text.classList.toggle("hidden", rows.length > 0);
	if (p.rows.childElementCount !== rows.length) {
		p.rows.replaceChildren(
			...rows.map(() => {
				const r = el("div", "peek-row");
				const fill = el("div", "peek-fill animating");
				const track = el("div", "peek-track");
				track.append(fill);
				r.append(el("span", "peek-label"), track, el("span", "peek-pct"));
				return r;
			}),
		);
	}
	rows.forEach((r, i) => {
		const node = p.rows.children[i];
		node.firstChild.textContent = r.label;
		node.querySelector(".peek-fill").style.width = `${Math.round(r.value * 100)}%`;
		node.lastChild.textContent = r.text;
	});
	p.right.textContent = whenText(pill.right);
	p.right.classList.toggle("hidden", !pill.right);
	// meters: one bar each, the heights follow the numbers
	if (p.meters.childElementCount !== pill.bars.length) {
		p.meters.replaceChildren(...pill.bars.map(() => el("i")));
	}
	pill.bars.forEach((v, i) => (p.meters.children[i].style.height = `${Math.max(8, Math.round(v * 100))}%`));
	p.meters.classList.toggle("hidden", !pill.bars.length);
	// buttons: built again when they change
	const sig = pill.buttons.map((b) => `${b.action}/${b.icon}/${b.label}`).join("|");
	if (sig !== p.sig) {
		p.sig = sig;
		p.buttons.replaceChildren(...buttonRow(pill.buttons, pill.plugin).children);
	}
	p.buttons.classList.toggle("hidden", !pill.buttons.length);
	p.bar.classList.toggle("hidden", pill.progress == null);
	if (pill.progress != null) p.fill.style.width = `${Math.round(pill.progress * 100)}%`;
}

async function loadPills() {
	try {
		const a = await invoke("plugin_pills");
		for (const pill of a.pills || []) setPill(pill);
		setRings(a.rings || {});
	} catch (_) {}
}

// -------------------------------------------------------------------------------------------------- the rings

const pgRings = new Map(); // plugin id -> the ring keys it shows

/** the rings of one plugin: what it shows now (the ones it showed before and does not now are hidden) */
function setPluginRings(plugin, rings) {
	const had = pgRings.get(plugin) || new Set();
	const now = new Set();
	for (const r of rings) {
		const key = `pg-${plugin}-${r.id}`;
		now.add(key);
		if (!ringEls[key]) {
			const made = addRing(key, r.color, plugin, 45, r.start !== false);
			// (named for the tray: "CPU Ring", "Five Hour Ring"; the plugin's name is its group's)
				made.el.dataset.name = `${String(r.id).split(/[_-]/).map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")} Ring`;
			// (a click on a ring is the plugin's to answer: asking again, say)
			made.el.addEventListener("click", () => call(plugin, "ring", { id: r.id }).catch(() => {}));
		}
		else {
			ringEls[key].fg.setAttribute("stroke", r.color);
			ringEls[key].el.dataset.color = r.color;
		}
		ringEls[key].el.classList.remove("hidden");
		setRing(key, r.pct, whenText(r.tip));
	}
	for (const key of had) if (!now.has(key)) ringEls[key]?.el.classList.add("hidden");
	pgRings.set(plugin, now);
}

/** every plugin's rings at once (what the hub's snapshot holds): a plugin that is not in it shows none */
export function setRings(byPlugin) {
	for (const plugin of new Set([...pgRings.keys(), ...Object.keys(byPlugin)])) setPluginRings(plugin, byPlugin[plugin] || []);
}

// ---------------------------------------------------------------------------------------------------- start

export function initPluginUi() {
	listen("plugin-rings", (e) => setPluginRings(e.payload.plugin, e.payload.rings || []));
	if (FLOATS) return;
	listen("plugin-pill", (e) => {
		if (e.payload.pill) setPill(e.payload.pill);
	});
	// a pill the island has just moved to: make sure it has what it says (the page may have opened after the plugin spoke)
	listen("view-tick", (e) => {
		if (typeof e.payload === "string" && e.payload.startsWith("pg-")) loadPills();
	});
	loadPills();
}

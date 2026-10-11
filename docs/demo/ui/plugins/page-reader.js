// Page Reader, the face of the native plugin (src/builtin/pages): a card for each page you have open, in the expanded
// island. It has no pill: the collapsed island shows nothing of it.
import { FLOATS, KIND_GLYPH, call, collapsible, el, focusable, going, host, iconEl, invoke, li, line, peek, textCol } from "../kit.js";
import { guideReader } from "./guide.js";

// the guide reader asks for words and pictures by the island's old names: they are calls to this plugin
const GUIDE_CALLS = { page_guide: "guide", page_guide_image: "guide_image", guide_go: "go" };
function guideInvoke(cmd, args) {
	const to = GUIDE_CALLS[cmd];
	if (!to) return invoke(cmd, args);
	return call("page-reader", to, cmd === "guide_go" ? { exe_path: args.exePath, page: args.page, url: args.url } : args);
}

// A shortcut to a button of the page in front of you: the click is delivered to
// the browser window, so it works without leaving the island.
function pageButton(b) {
	const btn = el("button", "page-btn", b.label);
	const stop = (e) => e.stopPropagation();
	btn.addEventListener("mousedown", stop);
	btn.addEventListener("click", async (e) => {
		e.stopPropagation(); // not "go to the browser"
		btn.disabled = true;
		const ok = await call("page-reader", "press", { label: b.label });
		btn.classList.add(ok ? "done" : "fail");
		setTimeout(
			() => btn.classList.remove("done", "fail"),
			900,
		);
		btn.disabled = false;
	});
	return btn;
}

// The bytes of a page's picture come once per picture (the card only holds its id); the hub keeps the last few.
const pageImages = new Map();
async function showPageImage(img, id) {
	let src = pageImages.get(id);
	if (src === undefined) {
		try {
			src = (await call("page-reader", "image", { id })) || null;
		} catch (_) {
			src = null;
		}
		pageImages.set(id, src);
		if (pageImages.size > 12)
			pageImages.delete(pageImages.keys().next().value);
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

// the kind's own summary line is a better lead than the page's first paragraph
function hasSummaryOf(b) {
	return (
		!!b.kind &&
		b.kind.fields.some(
			(f) => f.key === "Summary" || f.key === "Gist",
		)
	);
}

// Browsing: the page in front of you and what is in it, read from the page. When the island knows what kind
// of page it is (a walkthrough, an article, a video...) the card lists what is worth knowing about that kind.
function browsingCard(w) {
	const b = w.browse;
	const k = b.kind;
	const pv = b.preview;
	const card = el("div", "now-card spot");
	const row = el("div", "now-row");
	if (k) {
		const tile = el("div", "now-icon tile");
		tile.innerHTML = li(KIND_GLYPH[k.id] || "globe");
		row.append(tile);
	} else {
		row.append(iconEl(w.icon, "globe"));
	}
	// the two lines that change as you read: the sub-line, and what the collapsed card says at its right
	const subOf = (w) => {
		const b = w.browse;
		const k = b.kind;
		return k
			? b.domain
				? `${k.label} \u00b7 ${b.domain}`
				: k.label
			: b.domain || going(w.going_secs);
	};
	const peekOf = (w) => {
		const b = w.browse;
		const k = b.kind;
		if (k && k.peek) return k.peek;
		return b.domain || going(w.going_secs);
	};
	row.append(
		textCol(w.page || w.app_name || "Browsing", subOf(w)),
	);
	card.append(row);

	const body = el("div", "work-body");
	const guide = k && k.guide;
	// one card per recently focused page: per-page key keeps expand state separate,
	// titleHint focuses the right browser window (chrome vs edge, window vs window)
	const pageKey = `web:${w.exe_path || ""}:${w.page || ""}`;
	let pic = null;
	if (b.image != null) {
		// the page's main picture: fetched once per picture (the id changes only when the picture does)
		pic = el("img", "pk-img");
		pic.alt = "";
		pic.draggable = false;
		pic.dataset.id = String(b.image);
		showPageImage(pic, b.image);
		// (a guide places it itself: see guide.js)
		if (!guide) body.append(pic);
	}
	// a guide: laid out to be read, with the sections around it (see guide.js)
	if (guide)
		body.append(
			guideReader({
				el,
				li,
				invoke: guideInvoke,
				key: guide.key,
				exe: w.exe_path,
				page: w.page,
				pageKey,
				image: pic,
				onSize: host.scheduleHubHeight,
				onMoved: () => host.refresh(),
				onTyping: FLOATS ? (on) => invoke("float_typing", { on }) : null,
			}),
		);
	if (k && k.fields.length && !guide) {
		const list = el("div", "pk-fields");
		for (const f of k.fields) {
			const r = el("div", "pk-row");
			const v = el(
				"span",
				f.rough ? "pk-v rough" : "pk-v",
				f.value,
			);
			r.append(el("span", "pk-k", f.key), v);
			list.append(r);
		}
		body.append(list);
	}
	if (pv && !guide) {
		// (the kind's own summary line is the better lead)
		if (pv.lead && !hasSummaryOf(b))
			body.append(el("div", "work-desc", pv.lead));
		if (pv.buttons.length) {
			const btns = el("div", "page-btns");
			for (const b of pv.buttons)
				btns.append(pageButton(b));
			body.append(btns);
		}
	}
	if (body.childElementCount) card.append(body);
	// wide enough, the picture moves to the side (see .wide in hub.css)
	if (b.image != null)
		new ResizeObserver(() =>
			card.classList.toggle("wide", card.clientWidth >= 520),
		).observe(card);
	const peekText = peekOf(w);
	// Rebuilt only when the card's shape changes (another kind, other fields, other buttons); the values that
	// move while you read (scroll, the video's clock) are written in place, so an open card does not replay
	// its entrance animation every time you scroll.
	card._sig = `${pageKey}:${b.image != null ? "img" : ""}:${guide ? guide.key : ""}:${k ? `${k.id}:${k.fields.map((f) => f.key).join("|")}` : ""}:${pv && pv.lead && !hasSummaryOf(b) ? "lead" : ""}:${pv ? pv.buttons.map((x) => x.label).join("|") : ""}`;
	card._data = w;
	card._update = (w) => {
		const b = w.browse;
		const k = b.kind;
		const sub = card.querySelector(".now-sub");
		const nextSub = line("now-sub", subOf(w));
		if (sub && sub.textContent !== nextSub.textContent) sub.replaceWith(nextSub);
		const pk = card.querySelector(".now-peek");
		const nextPeek = line("now-peek", peekOf(w));
		if (pk && pk.textContent !== nextPeek.textContent) pk.replaceWith(nextPeek);
		if (k) {
			const vals = card.querySelectorAll(".pk-v");
			k.fields.forEach((f, i) => {
				const v = vals[i];
				if (!v) return;
				if (v.textContent !== f.value) v.textContent = f.value;
				v.classList.toggle("rough", !!f.rough);
			});
		}
		const pic = card.querySelector(".pk-img");
		if (pic && b.image != null && pic.dataset.id !== String(b.image)) {
			pic.dataset.id = String(b.image);
			showPageImage(pic, b.image);
		}
		const lead = card.querySelector(".work-desc");
		if (lead && b.preview && lead.textContent !== b.preview.lead)
			lead.textContent = b.preview.lead;
	};
	return focusable(
		collapsible(peek(card, peekText), pageKey),
		{ exePath: w.exe_path, titleHint: w.page },
	);
}

export default {
	id: "page-reader",
	cards(data) {
		return data.map((w) => {
			const c = browsingCard(w);
			c._rank = 60;
			return c;
		});
	},
};

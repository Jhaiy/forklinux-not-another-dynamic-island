// A modal's content (see modal.rs): the island and the plugins describe a window as a *spec*, and this draws it. It runs on the
// floating cards' layer (floats.js places and moves what is built here).
//
// A spec:
//   id         what it is called (opening one with the id of one that is open replaces it, as the next step of a flow)
//   title      its first line
//   icon       { letter, color }: the tile at the left of the bar
//   owner      a plugin's name: drawn by the island beside the title, where the plugin's own words cannot reach
//   width      280 to 520 px
//   blocks     what is in it, in order (below)
//   buttons    up to three: { id, label, primary, danger, stay }  (`stay`: the modal stays open for the next step)
//   busy       a line to say while something is being done (the buttons wait)
//   remember   the kind of modal it is, for remembering where you left it
//   at         where it opens the first time (after you have moved one of this kind, it opens where you left it):
//                "center" (the default: the middle of the screen the island is on), "island" (beside the island), "cursor"
//                (under the pointer), an edge or a corner of the screen ("top", "bottom-right"...), or { x, y }: where the
//                modal's middle goes, as a part of the screen (0 to 1 each way)
//
// The blocks:
//   { text, kind }                      kind: "title" | "muted" | "note" | "warn" | (plain)
//   { facts: [{ title, text }] }        a title, in a face of its own, and what it means, under it
//   { field, label, value, placeholder, focus }   one line of text; `field` is its name in the answer
//   { choice, options: [{ id, label }], value }   a few options, one picked
//   { list, items: [{ id, label, sub }], value }   a list, one row picked
//   { checks, items: [{ id, label, sub, tag, badges: [{ text, kind }], checked, disabled, note, letter, color }] }
//   { progress, text }                  a bar (0 to 1; none: it is moving) with a line under it
//
// What comes back with a button is `{ field: text, choice: id, list: id, checks: [ids] }`, by the names the blocks gave.

const MAX_BLOCKS = 40;
const MAX_ITEMS = 200;
const str = (v, n = 400) => (typeof v === "string" ? v.slice(0, n) : v == null ? "" : String(v).slice(0, n));

export function buildModal(spec, { el, li, onButton, onClose, onTyping }) {
	const root = el("div", "md");
	const bar = el("div", "md-bar");
	const tile = el("span", "md-tile");
	const title = el("span", "md-title");
	const from = el("span", "md-from");
	const x = el("button", "md-x");
	x.type = "button";
	x.setAttribute("aria-label", "Close");
	x.innerHTML = li("x");
	x.addEventListener("pointerdown", (e) => e.stopPropagation());
	x.addEventListener("click", () => onClose());
	bar.append(tile, title, from, x);
	const body = el("div", "md-body");
	const foot = el("div", "md-foot");
	root.append(bar, body, foot);

	/** the answers so far, by the names the blocks gave */
	let answers = {};
	let current = spec;

	function values() {
		const out = {};
		for (const [k, v] of Object.entries(answers)) out[k] = Array.isArray(v) ? [...v] : v;
		return out;
	}

	// the field that has the keyboard: the layer is given it while one is in use (see float_typing)
	let typingTimer = 0;
	function typing(input) {
		input.addEventListener("focus", () => {
			clearTimeout(typingTimer);
			onTyping?.(true);
		});
		input.addEventListener("blur", () => {
			clearTimeout(typingTimer);
			typingTimer = setTimeout(() => onTyping?.(false), 80);
		});
	}

	function block(b) {
		if (b == null || typeof b !== "object") return null;
		if (b.text != null) {
			const kind = ["title", "muted", "note", "warn"].includes(b.kind) ? b.kind : "";
			return el("div", `md-text${kind ? ` ${kind}` : ""}`, str(b.text, 1200));
		}
		if (Array.isArray(b.facts)) {
			const box = el("div", "md-facts");
			for (const f of b.facts.slice(0, 30)) {
				const row = el("div", "md-fact");
				row.append(el("b", null, str(f.title, 120)), el("span", null, str(f.text, 400)));
				box.append(row);
			}
			return box;
		}
		if (b.field) {
			const name = str(b.field, 40);
			const wrap = el("label", "md-fieldwrap");
			if (b.label) wrap.append(el("span", "md-label", str(b.label, 80)));
			const input = el("input", "md-field");
			input.type = "text";
			input.spellcheck = false;
			input.autocomplete = "off";
			input.value = str(b.value, 400);
			input.placeholder = str(b.placeholder, 80);
			answers[name] = input.value;
			input.addEventListener("input", () => {
				answers[name] = input.value;
			});
			// (Enter presses the main button)
			input.addEventListener("keydown", (e) => {
				if (e.key !== "Enter") return;
				const main = (current.buttons || []).find((x) => x.primary) || (current.buttons || [])[0];
				if (main) press(main);
			});
			typing(input);
			wrap.append(input);
			if (b.focus) setTimeout(() => input.focus(), 60);
			return wrap;
		}
		if (b.choice) {
			const name = str(b.choice, 40);
			const group = el("div", "md-choice");
			group.setAttribute("role", "group");
			const opts = (b.options || []).slice(0, 8);
			answers[name] = b.value != null ? str(b.value, 60) : opts[0] ? str(opts[0].id, 60) : "";
			for (const o of opts) {
				const btn = el("button", "md-opt", str(o.label, 40));
				btn.type = "button";
				const id = str(o.id, 60);
				btn.setAttribute("aria-pressed", String(answers[name] === id));
				btn.addEventListener("click", () => {
					answers[name] = id;
					for (const s of group.children) s.setAttribute("aria-pressed", String(s === btn));
				});
				group.append(btn);
			}
			return group;
		}
		if (b.list) {
			const name = str(b.list, 40);
			const box = el("div", "md-list");
			box.setAttribute("role", "listbox");
			const items = (b.items || []).slice(0, MAX_ITEMS);
			answers[name] = b.value != null ? str(b.value, 120) : "";
			for (const it of items) {
				const id = str(it.id, 120);
				const row = el("button", "md-row");
				row.type = "button";
				row.setAttribute("role", "option");
				row.setAttribute("aria-selected", String(answers[name] === id));
				row.append(el("span", "md-row-l", str(it.label, 120)));
				if (it.sub) row.append(el("span", "md-row-s", str(it.sub, 120)));
				row.addEventListener("click", () => {
					answers[name] = id;
					for (const s of box.children) s.setAttribute("aria-selected", String(s === row));
				});
				row.addEventListener("dblclick", () => {
					const main = (current.buttons || []).find((x) => x.primary);
					if (main) press(main);
				});
				box.append(row);
			}
			return box;
		}
		if (b.checks) {
			const name = str(b.checks, 40);
			const box = el("div", "md-checks");
			const items = (b.items || []).slice(0, MAX_ITEMS);
			answers[name] = items.filter((it) => it.checked && !it.disabled).map((it) => str(it.id, 120));
			for (const it of items) {
				const id = str(it.id, 120);
				const row = el("label", `md-check${it.disabled ? " off" : ""}`);
				const cb = el("input");
				cb.type = "checkbox";
				cb.checked = !!it.checked && !it.disabled;
				cb.disabled = !!it.disabled;
				cb.addEventListener("change", () => {
					const set = new Set(answers[name]);
					if (cb.checked) set.add(id);
					else set.delete(id);
					answers[name] = [...set];
					row.classList.toggle("on", cb.checked);
				});
				const mark = el("span", "md-cb");
				mark.innerHTML = li("check");
				row.classList.toggle("on", cb.checked);
				const text = el("span", "md-check-t");
				const line = el("span", "md-check-n");
				line.append(el("b", null, str(it.label, 80)));
				if (it.tag) line.append(el("i", "md-tag", str(it.tag, 24)));
				text.append(line);
				if (it.sub) text.append(el("span", "md-check-s", str(it.sub, 200)));
				if (Array.isArray(it.badges) && it.badges.length) {
					const bd = el("span", "md-badges");
					for (const x of it.badges.slice(0, 8)) bd.append(el("i", `md-badge ${["net", "add", "warn"].includes(x.kind) ? x.kind : ""}`, str(x.text, 60)));
					text.append(bd);
				}
				if (it.note) text.append(el("span", "md-check-note", str(it.note, 200)));
				row.append(cb, mark);
				if (it.letter) {
					const t = el("span", "md-ico", str(it.letter, 2));
					if (it.color) t.style.background = str(it.color, 20);
					row.append(t);
				}
				row.append(text);
				box.append(row);
			}
			return box;
		}
		if (b.progress !== undefined) {
			const box = el("div", "md-progress");
			const track = el("div", "md-track");
			const fill = el("i");
			if (typeof b.progress === "number") fill.style.width = `${Math.max(0, Math.min(1, b.progress)) * 100}%`;
			else track.classList.add("moving");
			track.append(fill);
			box.append(track);
			if (b.text) box.append(el("div", "md-text muted", str(b.text, 200)));
			return box;
		}
		return null;
	}

	function press(b) {
		if (busyNow) return;
		onButton(str(b.id, 40), values(), !!b.stay);
	}

	let busyNow = false;

	/** draw a spec (the first, or the next step of a flow) */
	function draw(next) {
		current = next;
		answers = {};
		const icon = next.icon || {};
		tile.textContent = str(icon.letter || (next.title || "?").trim().charAt(0).toUpperCase(), 2);
		tile.style.background = icon.color ? str(icon.color, 20) : "";
		title.textContent = str(next.title, 80);
		from.textContent = next.owner ? str(next.owner, 40) : "";
		from.hidden = !next.owner;
		const blocks = (next.blocks || []).slice(0, MAX_BLOCKS).map(block).filter(Boolean);
		busyNow = !!next.busy;
		if (next.busy) blocks.push(block({ progress: null, text: next.busy }));
		body.replaceChildren(...blocks);
		foot.replaceChildren();
		for (const b of (next.buttons || []).slice(0, 3)) {
			const btn = el("button", `md-btn${b.primary ? " p" : ""}${b.danger ? " d" : ""}`, str(b.label, 40));
			btn.type = "button";
			btn.disabled = busyNow;
			btn.addEventListener("click", () => press(b));
			foot.append(btn);
		}
		foot.hidden = !foot.childElementCount;
		root.classList.toggle("md-busy", busyNow);
	}

	draw(spec);
	return { root, bar, draw, values };
}

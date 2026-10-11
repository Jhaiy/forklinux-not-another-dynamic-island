// Add plugins from a GitHub repository, in a modal (see repo.rs for what the app does, modal.js for what a modal can hold).
// Three steps in one window: the link, what the repository holds (you choose), and what was installed.

import { invoke, openModal } from "./kit.js";

const ID = "add-plugins";
const KIND = { wasm: "Module", declarative: "Declarative" };

/** a permission as a badge says it: what, and of what */
const permText = (x) => (x.detail ? `${x.name} · ${x.detail}` : x.name);

function linkStep(link = "", error = null, busy = null) {
	return {
		id: ID,
		remember: ID,
		width: 400,
		title: "Add plugins",
		icon: { letter: "+" },
		blocks: [
			...(error ? [{ text: error, kind: "warn" }] : []),
			{ field: "link", value: link, placeholder: "owner/repo or GitHub link", focus: !busy },
		],
		busy,
		buttons: [
			{ id: "cancel", label: "Cancel" },
			{ id: "look", label: "Look", primary: true, stay: true },
		],
	};
}

function chooseStep(found, tint) {
	const list = found.plugins;
	const usable = list.filter((p) => !p.problem);
	const items = list.map((p) => ({
		id: p.id,
		label: p.name,
		sub: p.description,
		tag: KIND[p.kind] || p.kind,
		letter: (p.name || "?").trim().charAt(0).toUpperCase(),
		color: tint(p.id),
		badges: [
			...p.permissions.map((x) => ({ text: permText(x), kind: x.name === "network" ? "net" : "" })),
			...p.adds.map((x) => ({ text: `Adds ${x}`, kind: "add" })),
		],
		note: p.problem ? `Skipped: ${p.problem}` : p.installed != null ? `Installed${p.installed ? ` · v${p.installed}` : ""}${p.version && p.version !== p.installed ? ` → v${p.version}` : ""}` : null,
		disabled: !!p.problem,
		// (what is already here is ticked only when this one is a different version)
		checked: !p.problem && (p.installed == null || (p.version && p.version !== p.installed)),
	}));
	const blocks = [{ text: `${found.reference === "HEAD" ? "the latest commit" : found.reference} · ${list.length} ${list.length === 1 ? "plugin" : "plugins"} · ${found.size_kb} KB`, kind: "muted" }];
	if (found.about) blocks.push({ text: found.about, kind: "muted" });
	if (list.length) blocks.push({ checks: "pick", items });
	else blocks.push({ text: "No manifest.json found.", kind: "warn" });
	return {
		id: ID,
		remember: ID,
		width: 440,
		title: found.name || found.repo,
		icon: { letter: "G" },
		blocks,
		buttons: [
			{ id: "back", label: "Back", stay: true },
			...(usable.length ? [{ id: "install", label: "Install", primary: true, stay: true }] : []),
		],
	};
}

function doneStep(done, found) {
	return {
		id: ID,
		remember: ID,
		width: 400,
		title: "Installed",
		icon: { letter: "✓" },
		blocks: [
			{ text: done.length ? `${done.length} ${done.length === 1 ? "plugin" : "plugins"} installed, switched off.` : "Nothing installed.", kind: done.length ? "" : "warn" },
		],
		buttons: [
			{ id: "more", label: "Add more", stay: true },
			{ id: "show", label: "Show in the list", primary: true },
		],
	};
}

/**
 * Open the modal. `prefill`: a repository to look in at once (an update). `tint(id)`: a plugin's colour. `onChange`: the
 * plugin list should be drawn again.
 */
export function addFromGitHub({ prefill = "", tint, onChange }) {
	let found = null;
	let link = prefill;
	let steps = null;
	const look = async (api, text) => {
		api.update(linkStep(text, null, "Looking…"));
		try {
			found = await invoke("repo_look", { link: text });
			api.update(chooseStep(found, tint));
		} catch (e) {
			api.update(linkStep(text, String(e)));
		}
	};
	openModal(prefill ? { ...linkStep(prefill, null, "Looking…") } : linkStep(), async (button, values, api, closed) => {
		if (button === "look") {
			link = String(values.link || "").trim();
			if (!link) return api.update(linkStep("", "Enter a repository."));
			return look(api, link);
		}
		if (button === "back" || button === "more") return api.update(linkStep(link));
		if (button === "install") {
			const ids = values.pick || [];
			if (!ids.length) return;
			api.update({ ...chooseStep(found, tint), busy: "Installing…" });
			try {
				const done = await invoke("repo_install", { token: found.token, ids });
				onChange?.();
				api.update(doneStep(done, found));
			} catch (e) {
				api.update(linkStep(link, String(e)));
			}
			return;
		}
		if (closed) onChange?.();
	}).then((api) => {
		if (api && prefill) look(api, prefill);
		steps = api;
	});
	return () => steps?.close();
}

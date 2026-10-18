// Where the tiles are on their grid: each has a size (small 1 x 1, large 2 x 2, wide: as much of its row as is free) and, when the
// user put it somewhere, a column and a row (counted from 1). A wide tile with a place holds that one cell, and then stretches over
// the free cells of its row around it; two of them in a row between the same tiles share those cells evenly. One with no place
// takes a row to itself. A tile with no place, or whose place is taken or no longer fits (the island got
// narrower), takes the first free place that fits. Pure: the island (tiles.js) and the settings window (tilesedit.js) lay the grid
// out with the same rule, so what is arranged there is what is shown here.

/** how many columns and rows a size covers on a grid of `cols` columns (a wide one: the whole row at most; solve() gives it what is free) */
export function spanOf(size, cols) {
	if (size === "wide") return { w: cols, h: 1 };
	if (size === "large") return { w: Math.min(2, cols), h: 2 };
	return { w: 1, h: 1 };
}

/**
 * `items`: [{ id, size, pos?: { col, row } }]. `first`: the id of the tile in the hand, which gets its place before the others.
 * Returns a Map: id -> { col, row, w, h }. The others keep their places when they can, in the order of the grid (the one higher up
 * and further left is placed first), and the one that is in the way is moved on to the next free place.
 */
export function solve(items, cols, first = null) {
	const taken = new Set();
	const out = new Map();
	const free = (c, r, w, h) => {
		for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (taken.has(`${x},${y}`)) return false;
		return true;
	};
	const wideRows = new Set(items.filter((i) => i.size === "wide" && i.pos).map((i) => Math.max(1, i.pos.row)));
	const flex = new Set(); // the wide tiles that were put somewhere: they spread out once the others are down
	const put = (item) => {
		if (item.size === "wide") {
			let col = item.pos ? Math.min(Math.max(1, item.pos.col), cols) : 1;
			let row = item.pos ? Math.max(1, item.pos.row) : 1;
			if (!item.pos) {
				// (no place: a row of its own)
				while (!free(1, row, cols, 1)) row++;
				for (let x = 1; x <= cols; x++) taken.add(`${x},${row}`);
				out.set(item.id, { col: 1, row, w: cols, h: 1, ac: 1 });
				return;
			}
			for (let guard = 0; guard < 2000; guard++) {
				if (free(col, row, 1, 1)) break;
				col++;
				if (col > cols) {
					col = 1;
					row++;
				}
			}
			taken.add(`${col},${row}`);
			out.set(item.id, { col, row, w: 1, h: 1, ac: col });
			flex.add(item.id);
			return;
		}
		const { w, h } = spanOf(item.size, cols);
		const last = cols - w + 1;
		// (a tile with no place does not take a cell of a row that has a wide tile in it: that is the room the wide tile spreads over)
		const roomy = (r) => !item.pos && [...Array(h).keys()].some((k) => wideRows.has(r + k));
		let col = item.pos ? Math.min(Math.max(1, item.size === "wide" ? 1 : item.pos.col), last) : 1;
		let row = item.pos ? Math.max(1, item.pos.row) : 1;
		// (its own place if it is free; else the first free one from there on, along the rows)
		for (let guard = 0; guard < 2000; guard++) {
			if (free(col, row, w, h) && !roomy(row)) break;
			col++;
			if (col > last) {
				col = 1;
				row++;
			}
		}
		for (let y = row; y < row + h; y++) for (let x = col; x < col + w; x++) taken.add(`${x},${y}`);
		out.set(item.id, { col, row, w, h });
	};
	const hand = items.find((i) => i.id === first);
	if (hand) put(hand);
	const placed = items.filter((i) => i !== hand && i.pos).sort((a, b) => a.pos.row - b.pos.row || a.pos.col - b.pos.col);
	for (const i of placed) put(i);
	for (const i of items) if (i !== hand && !i.pos) put(i);
	// (each row: the free cells between the tiles that stay are shared by the wide ones in them, evenly, in the order they are in)
	const byRow = new Map();
	for (const id of flex) {
		const p = out.get(id);
		byRow.set(p.row, [...(byRow.get(p.row) || []), p]);
	}
	for (const [row, mine] of byRow) {
		const blocked = new Set();
		for (const [id, p] of out) if (!flex.has(id) && p.row <= row && row < p.row + p.h) for (let x = p.col; x < p.col + p.w; x++) blocked.add(x);
		mine.sort((a, b) => a.ac - b.ac);
		let x = 1;
		while (x <= cols) {
			if (blocked.has(x)) {
				x++;
				continue;
			}
			let e = x;
			while (e + 1 <= cols && !blocked.has(e + 1)) e++;
			const here = mine.filter((p) => p.ac >= x && p.ac <= e);
			if (here.length) {
				const len = e - x + 1;
				let extra = len % here.length;
				let c = x;
				for (const p of here) {
					const n = Math.floor(len / here.length) + (extra > 0 ? 1 : 0);
					if (extra > 0) extra--;
					p.col = c;
					p.w = n;
					c += n;
				}
			}
			x = e + 1;
		}
	}
	return out;
}

/**
 * The same places with each band of rows put in the middle of the grid when there is room at its sides (a tile that spans two rows holds
 * them together as one band). A band moves as it is, by whole columns and by half of one: `half` is true when it is half a column off.
 * Returns a Map: id -> { col, row, w, h, half }.
 */
export function centered(placed, cols) {
	const rows = rowsOf(placed);
	const up = Array.from({ length: rows + 2 }, (_, i) => i);
	const find = (r) => (up[r] === r ? r : (up[r] = find(up[r])));
	for (const p of placed.values()) for (let y = p.row + 1; y < p.row + p.h; y++) up[find(y)] = find(p.row);
	const band = new Map();
	for (const p of placed.values()) {
		const b = band.get(find(p.row)) || { lo: cols + 1, hi: 0 };
		b.lo = Math.min(b.lo, p.col);
		b.hi = Math.max(b.hi, p.col + p.w - 1);
		band.set(find(p.row), b);
	}
	const out = new Map();
	for (const [id, p] of placed) {
		const b = band.get(find(p.row));
		const shift = (cols - b.hi - (b.lo - 1)) / 2;
		const whole = Math.floor(shift);
		out.set(id, { ...p, col: p.col + whole, half: shift !== whole });
	}
	return out;
}

/** the rows the placed tiles reach */
export function rowsOf(placed) {
	let rows = 0;
	for (const p of placed.values()) rows = Math.max(rows, p.row + p.h - 1);
	return rows;
}

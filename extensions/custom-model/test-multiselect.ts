/**
 * Unit tests for multiselect.ts — run with: node test-multiselect.ts
 */
import assert from "node:assert/strict";
import { MultiSelect, type MultiSelectTheme } from "./multiselect.ts";

const theme: MultiSelectTheme = {
	accent: (s) => s,
	muted: (s) => s,
	dim: (s) => s,
	bold: (s) => s,
	warning: (s) => s,
};

let passed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		console.error(`FAIL ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

function make(items: string[], maxVisible = 5) {
	let result: string[] | null | undefined;
	const ms = new MultiSelect(items, maxVisible, theme, (r) => (result = r));
	return { ms, getResult: () => result };
}

test("space toggles current item, enter confirms selection", () => {
	const { ms, getResult } = make(["a", "b", "c"]);
	ms.handleInput(" ");
	assert.deepEqual(ms.selectedItems, ["a"]);
	ms.handleInput("\x1b[B"); // down
	ms.handleInput(" ");
	assert.deepEqual(ms.selectedItems, ["a", "b"]);
	ms.handleInput("\r");
	assert.deepEqual(getResult(), ["a", "b"]);
});

test("space toggles off again", () => {
	const { ms } = make(["a"]);
	ms.handleInput(" ");
	ms.handleInput(" ");
	assert.deepEqual(ms.selectedItems, []);
});

test("esc cancels with null", () => {
	const { ms, getResult } = make(["a", "b"]);
	ms.handleInput("\x1b");
	assert.equal(getResult(), null);
});

test("enter with nothing selected picks the item under the cursor", () => {
	const { ms, getResult } = make(["a", "b", "c"]);
	ms.handleInput("\x1b[B");
	ms.handleInput("\r");
	assert.deepEqual(getResult(), ["b"]);
});

test("'a' selects all, then none", () => {
	const { ms } = make(["a", "b", "c"]);
	ms.handleInput("a");
	assert.equal(ms.selectedItems.length, 3);
	ms.handleInput("a");
	assert.equal(ms.selectedItems.length, 0);
});

test("navigation wraps around", () => {
	const { ms, getResult } = make(["a", "b", "c"]);
	ms.handleInput("\x1b[A"); // up from 0 wraps to last
	ms.handleInput("\r");
	assert.deepEqual(getResult(), ["c"]);
});

test("j/k navigate like arrows", () => {
	const { ms, getResult } = make(["a", "b"]);
	ms.handleInput("j");
	ms.handleInput("\r");
	assert.deepEqual(getResult(), ["b"]);
});

test("long list scrolls and selection stays correct", () => {
	const items = Array.from({ length: 30 }, (_, i) => `m${i}`);
	const { ms, getResult } = make(items, 5);
	for (let i = 0; i < 17; i++) ms.handleInput("\x1b[B");
	ms.handleInput(" ");
	ms.handleInput("\r");
	assert.deepEqual(getResult(), ["m17"]);
	// window must have scrolled: render should contain m17
	const lines = ms.render(80).join("\n");
	assert.ok(lines.includes("m17"), "rendered window contains cursor item");
	assert.ok(lines.includes("of 30"), "scroll info shown");
});

test("render shows selection count", () => {
	const { ms } = make(["a", "b"]);
	ms.handleInput(" ");
	const first = ms.render(80)[0];
	assert.ok(first.includes("1/2"), `title shows count, got: ${first}`);
});

test("injected matcher handles Kitty-protocol CSI-u sequences", () => {
	// Simulate what pi-tui's matchesKey does for a Kitty terminal:
	// arrows arrive as CSI-u (e.g. \x1b[1;1A), not legacy \x1b[A.
	const kittyMatch = (data: string, keyId: string) => {
		const kitty: Record<string, string[]> = {
			up: ["\x1b[A", "\x1b[1;1A"],
			down: ["\x1b[B", "\x1b[1;1B"],
			escape: ["\x1b", "\x1b[27u"],
			enter: ["\r", "\x1b[13u"],
			space: [" ", "\x1b[32u"],
		};
		return (kitty[keyId] ?? [keyId]).includes(data);
	};
	let result: string[] | null | undefined;
	const ms = new MultiSelect(["a", "b", "c"], 5, theme, (r) => (result = r), kittyMatch);
	ms.handleInput("\x1b[1;1B"); // kitty down
	ms.handleInput("\x1b[1;1B"); // kitty down
	ms.handleInput("\x1b[32u"); // kitty space
	assert.deepEqual(ms.selectedItems, ["c"]);
	ms.handleInput("\x1b[13u"); // kitty enter
	assert.deepEqual(result, ["c"]);
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);

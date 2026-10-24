// The diff cards' colours: the usual green and red, and readable (WCAG AA for normal text, 4.5:1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DIFF, contrast } from "../src/engine/diffColors.ts";

test("diff cards: added lines green, removed lines red, both readable", () => {
  assert.equal(DIFF.add.bg, "#e6ffec");
  assert.equal(DIFF.del.bg, "#ffebe9");
  assert.ok(contrast(DIFF.add.ink, DIFF.add.bg) >= 4.5, `add ${contrast(DIFF.add.ink, DIFF.add.bg).toFixed(2)}`);
  assert.ok(contrast(DIFF.del.ink, DIFF.del.bg) >= 4.5, `del ${contrast(DIFF.del.ink, DIFF.del.bg).toFixed(2)}`);
  // green reads green, red reads red: the hue sits in the right channel
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  assert.ok(ch(DIFF.add.ink, 1) > ch(DIFF.add.ink, 0) && ch(DIFF.add.ink, 1) > ch(DIFF.add.ink, 2));
  assert.ok(ch(DIFF.del.ink, 0) > ch(DIFF.del.ink, 1) && ch(DIFF.del.ink, 0) > ch(DIFF.del.ink, 2));
});

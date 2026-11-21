import assert from "node:assert/strict";
import { test } from "node:test";
import { DETAIL, DIGEST, reviewLines } from "../src/render.ts";

const finding = (i: number, extra: { need?: boolean; witness?: string } = {}) => ({
  witness: extra.witness ?? `witness ${i}`, basis: "observed a.ts:1", consequence: "consequence", change: `change ${i}`,
  ...(extra.need ? { need: true } : {}),
});
const review = (name: string, findings: ReturnType<typeof finding>[], summary = "summary") => ({ name, verdict: "fail" as const, summary, findings });

test("reviewLines: the digest keeps four per reviewer and says where the rest are", () => {
  const lines = reviewLines([review("pair", [0, 1, 2, 3, 4, 5].map((i) => finding(i)))], { ...DIGEST, label: "worq_list(abcd)" });
  assert.equal(lines.filter((line) => line.startsWith("  pair-")).length, 4);
  // Ids stay positional, so they match what worq_list shows for the same review.
  assert.deepEqual(lines.slice(1, 5).map((line) => line.slice(2, 8)), ["pair-1", "pair-2", "pair-3", "pair-4"]);
  assert.equal(lines.at(-1), "  (2 more: worq_list(abcd))");
});

test("reviewLines: a finding only the requester can settle is never the one the cap hides", () => {
  const findings = [0, 1, 2, 3, 4].map((i) => finding(i, { need: i === 4 }));
  const lines = reviewLines([review("pair", findings)], DIGEST);
  assert.ok(lines.some((line) => line.includes("pair-5 [need: requester]: witness 4")));
  assert.ok(!lines.some((line) => line.includes("pair-4:")));
  assert.equal(lines.at(-1), "  (1 more: worq_list)");
});

test("reviewLines: detail is lossless at the schema maxima, the digest is not", () => {
  const witness = "w".repeat(800), change = "c".repeat(500), basis = "b".repeat(400);
  const record = [{ name: "pair", verdict: "fail" as const, findings: [{ witness, basis, consequence: "x", change }] }];
  assert.ok(reviewLines(record)[1].includes(`${witness} → ${change} (${basis})`));
  const digest = reviewLines(record, DIGEST)[1];
  assert.ok(!digest.includes(witness) && digest.includes("…"), "the digest clips long fields");
  assert.equal(reviewLines(record, DETAIL)[0], "pair: fail");
});

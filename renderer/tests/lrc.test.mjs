import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLrc, activeLineIndex } from "../lrc.mjs";

test("parses timestamped lines into seconds + text", () => {
  const { lines } = parseLrc("[00:12.50] Hello world\n[00:15.00] Second line");
  assert.deepEqual(lines, [
    { t: 12.5, text: "Hello world" },
    { t: 15, text: "Second line" },
  ]);
});

test("accepts 1-3 fraction digits and mm:ss with no fraction", () => {
  const { lines } = parseLrc("[01:02.5] a\n[01:03.123] b\n[01:04] c");
  assert.deepEqual(
    lines.map((l) => l.t),
    [62.5, 63.123, 64],
  );
});

test("expands multiple timestamps on one line", () => {
  const { lines } = parseLrc("[00:10.00][00:50.00] chorus");
  assert.deepEqual(lines, [
    { t: 10, text: "chorus" },
    { t: 50, text: "chorus" },
  ]);
});

test("captures metadata tags without emitting lines", () => {
  const { lines, meta } = parseLrc("[ar:Jackson 5]\n[ti:I Want You Back]\n[00:01.00] hi");
  assert.equal(meta.ar, "Jackson 5");
  assert.equal(meta.ti, "I Want You Back");
  assert.equal(lines.length, 1);
});

test("applies offset tag (+ shifts lyrics earlier)", () => {
  const { lines } = parseLrc("[offset:+500]\n[00:10.00] x");
  assert.equal(lines[0].t, 9.5);
});

test("offset never produces negative times", () => {
  const { lines } = parseLrc("[offset:+2000]\n[00:01.00] x");
  assert.equal(lines[0].t, 0);
});

test("keeps empty timestamped lines (musical gaps)", () => {
  const { lines } = parseLrc("[00:05.00] \n[00:09.00] words");
  assert.deepEqual(lines, [
    { t: 5, text: "" },
    { t: 9, text: "words" },
  ]);
});

test("skips malformed/untimestamped lines", () => {
  const { lines } = parseLrc("just prose\n[bad:stamp] nope\n[00:07.00] ok");
  assert.deepEqual(lines, [{ t: 7, text: "ok" }]);
});

test("sorts output by time", () => {
  const { lines } = parseLrc("[00:30.00] late\n[00:10.00] early");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["early", "late"],
  );
});

test("handles CRLF input", () => {
  const { lines } = parseLrc("[00:01.00] a\r\n[00:02.00] b\r\n");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["a", "b"],
  );
});

test("activeLineIndex: -1 before first line", () => {
  const { lines } = parseLrc("[00:10.00] a\n[00:20.00] b");
  assert.equal(activeLineIndex(lines, 3), -1);
});

test("activeLineIndex: last line whose t <= now", () => {
  const { lines } = parseLrc("[00:10.00] a\n[00:20.00] b\n[00:30.00] c");
  assert.equal(activeLineIndex(lines, 10), 0);
  assert.equal(activeLineIndex(lines, 19.99), 0);
  assert.equal(activeLineIndex(lines, 20), 1);
  assert.equal(activeLineIndex(lines, 99), 2);
});

test("activeLineIndex: empty lines array", () => {
  assert.equal(activeLineIndex([], 5), -1);
});

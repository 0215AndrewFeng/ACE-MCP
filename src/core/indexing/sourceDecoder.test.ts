import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeSourceBuffer,
  isValidUtf8,
  scoreDecodedContent,
} from "./indexCoordinator.js";

test("decodeSourceBuffer decodes valid utf-8 with utf8 encoding", () => {
  const text = "hello 世界";
  const result = decodeSourceBuffer(Buffer.from(text, "utf8"));
  assert.equal(result.content, text);
  assert.equal(result.encoding, "utf8");
});

test("isValidUtf8 is true for valid utf-8 and false for invalid bytes", () => {
  assert.equal(isValidUtf8(Buffer.from("hello 世界", "utf8")), true);
  // 0xff 0xfe 0xff is not a valid utf-8 sequence
  assert.equal(isValidUtf8(Buffer.from([0xff, 0xfe, 0xff])), false);
});

test("scoreDecodedContent scores clean text higher than replacement-laden content", () => {
  const clean = "function hello() { return 1; }";
  const dirty = "�����";
  assert.ok(scoreDecodedContent(clean) > scoreDecodedContent(dirty));
});

test("scoreDecodedContent penalizes replacement characters", () => {
  const base = "abcde";
  const withReplacements = "abcde�";
  // each replacement char subtracts 10; printable count rises by 0 (it's counted then -10)
  assert.ok(scoreDecodedContent(withReplacements) < scoreDecodedContent(base));
});

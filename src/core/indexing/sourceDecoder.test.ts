import test from "node:test";
import assert from "node:assert/strict";

import iconv from "iconv-lite";

import { decodeSourceBuffer, isValidUtf8, scoreDecodedContent } from "./indexCoordinator.js";

test("isValidUtf8 accepts exact UTF-8 round trips and rejects invalid byte sequences", () => {
  assert.equal(isValidUtf8(Buffer.from("const value = '退款';", "utf8")), true);
  assert.equal(isValidUtf8(Buffer.from([0xff, 0xfe, 0xfd])), false);
});

test("decodeSourceBuffer keeps valid UTF-8 and chooses a better legacy encoding when needed", () => {
  const utf8 = decodeSourceBuffer(Buffer.from("hello", "utf8"));
  assert.deepEqual(utf8, { content: "hello", encoding: "utf8" });

  const gbk = decodeSourceBuffer(iconv.encode("中文内容", "gbk"));
  assert.equal(gbk.content, "中文内容");
  assert.equal(gbk.encoding, "gbk");
});

test("scoreDecodedContent penalizes replacement characters", () => {
  assert.ok(scoreDecodedContent("valid text") > scoreDecodedContent("bad \uFFFD\uFFFD"));
});

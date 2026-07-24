import assert from "node:assert/strict";
import test from "node:test";

import { findAggregateProjectRoots, isNestedProjectPath } from "./projectHierarchy.js";

test("project hierarchy uses path boundaries when identifying nested projects", () => {
  assert.equal(isNestedProjectPath("/work/code", "/work/code/service-a"), true);
  assert.equal(isNestedProjectPath("/work/code", "/work/code"), false);
  assert.equal(isNestedProjectPath("/work/code", "/work/code-a"), false);
});

test("only roots with more than one registered child are aggregate projects", () => {
  const roots = [
    "/work/code",
    "/work/code/service-a",
    "/work/code/service-b",
    "/work/admin",
    "/work/admin/web",
  ];

  assert.deepEqual(findAggregateProjectRoots(roots), new Set(["/work/code"]));
});

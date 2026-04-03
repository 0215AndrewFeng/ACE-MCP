import assert from "node:assert/strict";
import test from "node:test";

import { formatHelpText, parseCliArgs } from "./cli.js";

test("parseCliArgs supports version flag", () => {
  assert.deepEqual(parseCliArgs(["--version"]), {
    help: false,
    version: true,
    webPort: undefined,
  });
  assert.deepEqual(parseCliArgs(["-v", "--web-port", "8787"]), {
    help: false,
    version: true,
    webPort: 8787,
  });
});

test("formatHelpText mentions version flag", () => {
  const helpText = formatHelpText();

  assert.equal(helpText.includes("--version"), true);
  assert.equal(helpText.includes("-v, --version"), true);
});

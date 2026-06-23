import test from "node:test";
import assert from "node:assert/strict";

import { formatHelpText, parseCliArgs } from "./cli.js";

test("parseCliArgs parses web, warm, eval, doctor, version, and autostart flags", () => {
  const parsed = parseCliArgs([
    "--web-port",
    "8787",
    "--warm",
    "--eval=eval-cases/golden.json",
    "--doctor",
    "--autostart",
    "status",
    "-v",
  ]);

  assert.equal(parsed.webPort, 8787);
  assert.equal(parsed.warm, true);
  assert.equal(parsed.evalPath, "eval-cases/golden.json");
  assert.equal(parsed.doctor, true);
  assert.equal(parsed.autostart, "status");
  assert.equal(parsed.version, true);
});

test("parseCliArgs rejects invalid ports and missing eval paths", () => {
  assert.throws(() => parseCliArgs(["--web-port", "70000"]), /Invalid --web-port/);
  assert.throws(() => parseCliArgs(["--eval", "--warm"]), /Missing --eval value/);
});

test("formatHelpText documents v4 CLI quality gates", () => {
  const help = formatHelpText();

  assert.match(help, /--warm/);
  assert.match(help, /--eval <caseFile>/);
  assert.match(help, /--doctor/);
  assert.match(help, /--autostart <action>/);
});

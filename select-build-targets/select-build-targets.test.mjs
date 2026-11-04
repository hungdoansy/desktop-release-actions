import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { selectTargets } from "./select-build-targets.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "select-build-targets.mjs");

const TARGETS = [
  { input: "mac_arm64", name: "mac-arm64", os: "macos-latest", target: "aarch64-apple-darwin" },
  { input: "mac_x64", name: "mac-x64", os: "macos-latest", target: "x86_64-apple-darwin" },
  { input: "windows_x64", name: "windows-x64", os: "windows-latest", arch: "x64" },
  { input: "linux_x64", name: "linux-x64", os: "ubuntu-latest", bundles: "deb,appimage" },
];
const NONE = { mac_arm64: false, mac_x64: false, windows_x64: false, linux_x64: false };

test("keeps only the ticked target, with its extra fields unchanged", () => {
  const { include } = selectTargets(TARGETS, { ...NONE, linux_x64: true });
  assert.deepEqual(include, [TARGETS[3]]);
});

test("keeps several ticked targets in list order", () => {
  const { include } = selectTargets(TARGETS, { ...NONE, windows_x64: true, mac_arm64: true });
  assert.deepEqual(
    include.map((t) => t.name),
    ["mac-arm64", "windows-x64"],
  );
});

test("counts boolean true and the string 'true' as ticked", () => {
  assert.equal(selectTargets(TARGETS, { ...NONE, mac_x64: true }).include.length, 1);
  assert.equal(selectTargets(TARGETS, { ...NONE, mac_x64: "true" }).include.length, 1);
});

test("fails when nothing is ticked, and lists the checkboxes", () => {
  assert.throws(() => selectTargets(TARGETS, NONE), /mac_arm64, mac_x64, windows_x64, linux_x64/);
});

test("fails when a target has no matching checkbox", () => {
  const { linux_x64: _removed, ...selected } = { ...NONE, mac_arm64: true };
  assert.throws(() => selectTargets(TARGETS, selected), /"linux_x64" has no matching/);
});

test("fails when a target has no input field", () => {
  assert.throws(() => selectTargets([{ name: "x" }], NONE), /no "input" field/);
});

test("fails on an empty target list", () => {
  assert.throws(() => selectTargets([], NONE), /non-empty/);
});

test("ignores inputs that are not targets", () => {
  const selected = { ...NONE, mac_arm64: true, version: "1.0.0", dry_run: true };
  assert.equal(selectTargets(TARGETS, selected).include.length, 1);
});

function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "select-targets-"));
  const output = join(dir, "output");
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
  });
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    // No output file means the script failed first.
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, written };
}

test("the CLI writes the matrix to GITHUB_OUTPUT", () => {
  const result = run({
    TARGETS: JSON.stringify(TARGETS),
    SELECTED: JSON.stringify({ ...NONE, mac_arm64: true }),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Building: mac-arm64/);
  assert.deepEqual(JSON.parse(result.written.replace(/^matrix=/, "")), { include: [TARGETS[0]] });
});

test("the CLI reports invalid targets JSON as an error", () => {
  const result = run({ TARGETS: "[oops", SELECTED: "{}" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::targets is not valid JSON/);
});

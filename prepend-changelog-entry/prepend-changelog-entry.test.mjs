import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { insertEntry, renderHeading } from "./prepend-changelog-entry.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "prepend-changelog-entry.mjs");
const DEFAULT = "## v1.1.0 (2026-11-04)";

test("renderHeading fills the default template", () => {
  const heading = renderHeading("## {tag} ({date})", { tag: "v2.5.0", date: "2026-11-04" });
  assert.equal(heading, "## v2.5.0 (2026-11-04)");
});

test("renderHeading fills {version} without the leading v", () => {
  const heading = renderHeading("## [{version}] - {date}", { tag: "v1.5.0", date: "2026-11-04" });
  assert.equal(heading, "## [1.5.0] - 2026-11-04");
});

test("a missing file starts a changelog", () => {
  assert.equal(insertEntry(null, DEFAULT, "- new"), `# Changelog\n\n${DEFAULT}\n\n- new\n`);
});

test("the block goes directly under the title and above older releases", () => {
  const old = "# Changelog\n\n## v1.0.0 (2026-11-01)\n\n- old\n";
  assert.equal(
    insertEntry(old, DEFAULT, "- new"),
    `# Changelog\n\n${DEFAULT}\n\n- new\n\n## v1.0.0 (2026-11-01)\n\n- old\n`,
  );
});

test("an intro under the title stays above the block", () => {
  const old = "# Changelog\n\nAll notable changes.\n\n## [1.4.0] - 2026-07-18\n\n- old\n";
  const out = insertEntry(old, "## [1.5.0] - 2026-11-04", "- new");
  assert.equal(
    out,
    "# Changelog\n\nAll notable changes.\n\n## [1.5.0] - 2026-11-04\n\n- new\n\n## [1.4.0] - 2026-07-18\n\n- old\n",
  );
});

test("a title with no releases gets its first block and one trailing newline", () => {
  assert.equal(insertEntry("# Changelog\n\n", DEFAULT, "- new"), `# Changelog\n\n${DEFAULT}\n\n- new\n`);
});

test("a file with no title keeps its releases below the block", () => {
  const out = insertEntry("## v1.0.0 (2026-11-01)\n\n- old\n", DEFAULT, "- new");
  assert.equal(out, `${DEFAULT}\n\n- new\n\n## v1.0.0 (2026-11-01)\n\n- old\n`);
});

test("an empty file gets just the block", () => {
  assert.equal(insertEntry("", DEFAULT, "- new"), `${DEFAULT}\n\n- new\n`);
});

test("CRLF files keep CRLF line endings", () => {
  const old = "# Changelog\r\n\r\n## v1.0.0 (2026-11-01)\r\n\r\n- old\r\n";
  const out = insertEntry(old, DEFAULT, "- one\n- two");
  assert.equal(
    out,
    `# Changelog\r\n\r\n${DEFAULT}\r\n\r\n- one\r\n- two\r\n\r\n## v1.0.0 (2026-11-01)\r\n\r\n- old\r\n`,
  );
});

test("empty entries fail", () => {
  assert.throws(() => insertEntry(null, DEFAULT, "   "), /entries must not be empty/);
  assert.throws(() => insertEntry(null, DEFAULT, undefined), /entries must not be empty/);
});

function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "prepend-changelog-"));
  try {
    return env(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the CLI updates the named file with a custom heading", () => {
  run((dir) => {
    const file = join(dir, "CHANGES.md");
    writeFileSync(file, "# Changelog\n\n## [1.4.0] - 2026-07-18\n\n- old\n");
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        TAG: "v1.5.0",
        DATE: "2026-11-04",
        ENTRIES: "- new",
        CHANGELOG_FILE: file,
        HEADING: "## [{version}] - {date}",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(file, "utf8"), /## \[1\.5\.0\] - 2026-11-04\n\n- new\n\n## \[1\.4\.0\]/);
  });
});

test("the CLI reports missing entries as an error", () => {
  run((dir) => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        TAG: "v1.5.0",
        DATE: "2026-11-04",
        ENTRIES: "",
        CHANGELOG_FILE: join(dir, "CHANGELOG.md"),
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::entries must not be empty/);
  });
});

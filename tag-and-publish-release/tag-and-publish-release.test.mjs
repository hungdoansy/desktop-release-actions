import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkAssets,
  commitAndTag,
  dryRunSummary,
  pushRelease,
  resolveAssets,
} from "./tag-and-publish-release.mjs";

// Keep a developer's git config, such as tag signing, out of the tests.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "tag-and-publish-release.mjs");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "publish-release-"));
  dirs.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** A clone with one pushed commit, plus its bare remote. */
function setup() {
  const remote = tempDir();
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "feat: first");
  git(repo, "push", "-q", "origin", "main");
  return { remote, repo };
}

function refs(remote) {
  return git(remote, "for-each-ref", "--format=%(refname) %(objectname)");
}

function bump(repo) {
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## v1.2.0\n");
}

test("commits, tags and pushes both refs to the remote", () => {
  const { remote, repo } = setup();
  bump(repo);
  commitAndTag({ tag: "v1.2.0", paths: ["CHANGELOG.md"], cwd: repo });
  pushRelease({ tag: "v1.2.0", branch: "main", cwd: repo });

  assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "release: v1.2.0");
  assert.equal(git(remote, "log", "-1", "--format=%an", "main"), "github-actions[bot]");
  assert.equal(git(remote, "cat-file", "-t", "refs/tags/v1.2.0"), "tag");
  assert.equal(git(remote, "rev-parse", "v1.2.0^{commit}"), git(remote, "rev-parse", "main"));
});

test("commits only the listed paths", () => {
  const { repo } = setup();
  bump(repo);
  writeFileSync(join(repo, "other.txt"), "leave me\n");
  commitAndTag({ tag: "v1.2.0", paths: ["CHANGELOG.md"], cwd: repo });
  assert.equal(git(repo, "show", "--name-only", "--format=", "HEAD"), "CHANGELOG.md");
});

test("a remote that already has the tag leaves the branch unchanged", () => {
  const { remote, repo } = setup();
  git(repo, "tag", "v1.2.0");
  git(repo, "push", "-q", "origin", "v1.2.0");
  git(repo, "tag", "-d", "v1.2.0");
  const before = refs(remote);

  bump(repo);
  commitAndTag({ tag: "v1.2.0", paths: ["CHANGELOG.md"], cwd: repo });
  assert.throws(() => pushRelease({ tag: "v1.2.0", branch: "main", cwd: repo }));
  assert.equal(refs(remote), before);
});

test("a remote branch that moved ahead rejects both refs", () => {
  const { remote, repo } = setup();
  const other = join(tempDir(), "other");
  git(tempDir(), "clone", "-q", remote, other);
  git(other, "commit", "-q", "--allow-empty", "-m", "feat: newer");
  git(other, "push", "-q", "origin", "main");
  const before = refs(remote);

  bump(repo);
  commitAndTag({ tag: "v1.2.0", paths: ["CHANGELOG.md"], cwd: repo });
  assert.throws(() => pushRelease({ tag: "v1.2.0", branch: "main", cwd: repo }));
  assert.equal(refs(remote), before);
});

test("no staged changes fails", () => {
  const { repo } = setup();
  assert.throws(
    () => commitAndTag({ tag: "v1.2.0", paths: ["CHANGELOG.md"], cwd: repo }),
    /Nothing to commit in: CHANGELOG\.md/,
  );
});

test("a path that does not exist fails and names it", () => {
  const { repo } = setup();
  assert.throws(
    () => commitAndTag({ tag: "v1.2.0", paths: ["missing.json"], cwd: repo }),
    /Path does not exist: missing\.json/,
  );
});

test("an empty path list fails", () => {
  const { repo } = setup();
  assert.throws(() => commitAndTag({ tag: "v1.2.0", paths: [], cwd: repo }), /at least one file/);
});

test("branch pushes HEAD to that branch", () => {
  const { remote, repo } = setup();
  bump(repo);
  commitAndTag({ tag: "v1.2.0", paths: ["CHANGELOG.md"], cwd: repo });
  pushRelease({ tag: "v1.2.0", branch: "develop", cwd: repo });
  assert.equal(git(remote, "log", "-1", "--format=%s", "develop"), "release: v1.2.0");
  assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "feat: first");
});

function assetDir() {
  const dir = tempDir();
  mkdirSync(join(dir, "artifacts", "nested"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "app.dmg"), "12345");
  writeFileSync(join(dir, "artifacts", "nested", "app.deb"), "123");
  return dir;
}

test("resolveAssets expands globs and records sizes", () => {
  const assets = resolveAssets(["artifacts/**/*.dmg", "artifacts/**/*.deb"], assetDir());
  assert.deepEqual(
    assets.matched.map(({ file, bytes }) => [file.replaceAll("\\", "/"), bytes]),
    [
      ["artifacts/app.dmg", 5],
      ["artifacts/nested/app.deb", 3],
    ],
  );
  assert.deepEqual(assets.unmatched, []);
});

test("resolveAssets records a glob that matches nothing", () => {
  const assets = resolveAssets(["artifacts/**/*.dmg", "artifacts/**/*.exe"], assetDir());
  assert.equal(assets.matched.length, 1);
  assert.deepEqual(assets.unmatched, ["artifacts/**/*.exe"]);
});

test("checkAssets fails on an unmatched glob when told to, and names it", () => {
  const patterns = ["a.dmg", "dist/latest-mac.yml"];
  const assets = { matched: [{ file: "a.dmg", bytes: 1 }], unmatched: ["dist/latest-mac.yml"] };
  assert.throws(() => checkAssets(assets, patterns, true), /No files match: dist\/latest-mac\.yml/);
});

test("checkAssets allows an unmatched glob otherwise", () => {
  const patterns = ["a.dmg", "b.exe"];
  const assets = { matched: [{ file: "a.dmg", bytes: 1 }], unmatched: ["b.exe"] };
  assert.doesNotThrow(() => checkAssets(assets, patterns, false));
});

test("checkAssets fails when no glob matches anything", () => {
  assert.throws(
    () => checkAssets({ matched: [], unmatched: ["a.dmg"] }, ["a.dmg"], false),
    /No release assets found/,
  );
});

test("checkAssets allows a release with no assets configured", () => {
  assert.doesNotThrow(() => checkAssets({ matched: [], unmatched: [] }, [], false));
});

test("dryRunSummary shows assets, notes and the commit patch", () => {
  const summary = dryRunSummary({
    tag: "v1.2.0",
    branch: "main",
    notes: "- new",
    assets: { matched: [{ file: "a.dmg", bytes: 7 }], unmatched: ["b.exe"] },
    patch: "+## v1.2.0 (2026-11-04)",
  });
  assert.match(summary, /`a\.dmg` \(7 bytes\)/);
  assert.match(summary, /`b\.exe` matched nothing/);
  assert.match(summary, /- new/);
  assert.match(summary, /\+## v1\.2\.0 \(2026-11-04\)/);
});

test("dryRunSummary clips a very large patch", () => {
  const summary = dryRunSummary({
    tag: "v1.2.0",
    branch: "main",
    notes: "",
    assets: { matched: [], unmatched: [] },
    patch: "x".repeat(70_000),
  });
  assert.ok(summary.length < 61_000);
  assert.match(summary, /\(clipped\)/);
});

function runCli(cwd, env) {
  const summaryFile = join(tempDir(), "summary");
  writeFileSync(summaryFile, "");
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      TAG: "v1.2.0",
      COMMIT_PATHS: "CHANGELOG.md\n",
      GITHUB_STEP_SUMMARY: summaryFile,
      ...env,
    },
  });
  return { ...result, summary: readFileSync(summaryFile, "utf8") };
}

test("the CLI dry run leaves the remote alone and fills the summary", () => {
  const { remote, repo } = setup();
  const before = refs(remote);
  bump(repo);
  mkdirSync(join(repo, "dist"));
  writeFileSync(join(repo, "dist", "app.dmg"), "1");

  const result = runCli(repo, { DRY_RUN: "true", CHANGELOG: "- new", ASSET_FILES: "dist/*.dmg\n" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(refs(remote), before);
  assert.equal(git(repo, "rev-parse", "--verify", "-q", "refs/tags/v1.2.0").length > 0, true);
  assert.match(result.summary, /## Dry run for v1\.2\.0/);
  assert.match(result.summary, /app\.dmg/);
  assert.match(result.summary, /- new/);
  assert.match(result.summary, /\+## v1\.2\.0/);
});

test("the CLI real run pushes and writes no dry-run summary", () => {
  const { remote, repo } = setup();
  bump(repo);
  const result = runCli(repo, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "release: v1.2.0");
  assert.equal(result.summary, "");
});

test("the CLI stops on a bad glob before committing or pushing", () => {
  const { remote, repo } = setup();
  const before = refs(remote);
  const head = git(repo, "rev-parse", "HEAD");
  bump(repo);

  const result = runCli(repo, { ASSET_FILES: "dist/latest-mac.yml", FAIL_ON_UNMATCHED: "true" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::No files match: dist\/latest-mac\.yml/);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(refs(remote), before);
});

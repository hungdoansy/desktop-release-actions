import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectSubjects,
  draftNotes,
  filterSubjects,
  polishWithGemini,
  takeApiKey,
  validateRelease,
  writeOutput,
} from "./validate-and-draft-notes.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "validate-and-draft-notes.mjs");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "draft-notes-"));
  dirs.push(dir);
  return dir;
}

// Keep a developer's git config, such as tag signing, out of the tests. An empty file
// stands in for it, because git on Windows cannot read the null device as a config.
process.env.GIT_CONFIG_GLOBAL = join(tempDir(), "gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function repoWith(subjects) {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  for (const subject of subjects) git(dir, "commit", "-q", "--allow-empty", "-m", subject);
  return dir;
}

test("validateRelease returns the tag for a new version", () => {
  assert.equal(validateRelease("1.2.0", repoWith(["feat: a"])), "v1.2.0");
});

test("validateRelease rejects anything but X.Y.Z, and names the value", () => {
  const repo = repoWith(["feat: a"]);
  for (const version of ["v1.2.0", "1.2", "1.2.0-beta", "", undefined]) {
    assert.throws(() => validateRelease(version, repo), /X\.Y\.Z format/);
  }
  assert.throws(() => validateRelease("1.2", repo), /got: 1\.2/);
});

test("validateRelease rejects a version whose tag exists", () => {
  const repo = repoWith(["feat: a"]);
  git(repo, "tag", "v1.2.0");
  assert.throws(() => validateRelease("1.2.0", repo), /Tag v1\.2\.0 already exists/);
});

test("validateRelease rejects a shallow clone", () => {
  const source = repoWith(["feat: a", "feat: b"]);
  const clone = join(tempDir(), "clone");
  git(tempDir(), "clone", "-q", "--depth", "1", pathToFileURL(source).href, clone);
  assert.throws(() => validateRelease("1.2.0", clone), /fetch-depth: 0/);
});

test("filterSubjects keeps user-facing commits and strips their bookkeeping", () => {
  assert.deepEqual(
    filterSubjects([
      "fix(links): unfurl the brand-only providers (UNIT-3.7)",
      "feat: open card links in the browser (UNIT-9.4) (#9)",
      "fix(e2e-free): repair drift (#8)",
      "feat(ui): add thing (UNIT-P11)",
      "feat: tracked elsewhere (ABC-123)",
      "a commit with no type",
      "Bump Electron to 43 (#22)",
    ]),
    [
      "- unfurl the brand-only providers",
      "- open card links in the browser",
      "- repair drift",
      "- add thing",
      "- tracked elsewhere",
      "- a commit with no type",
      "- Bump Electron to 43",
    ],
  );
});

test("filterSubjects strips ticket lists and free-form ticket suffixes", () => {
  assert.deepEqual(filterSubjects(["feat(io): x (UNIT-21, UNIT-22) (#11)"]), ["- x"]);
  assert.deepEqual(filterSubjects(["feat: y (UNIT-10 batch)"]), ["- y"]);
});

test("filterSubjects keeps parentheses that are not tickets", () => {
  assert.deepEqual(filterSubjects(["fix: keep this (security review)"]), [
    "- keep this (security review)",
  ]);
  assert.deepEqual(filterSubjects(["feat: move it (packages/commands)"]), [
    "- move it (packages/commands)",
  ]);
  assert.deepEqual(filterSubjects(["feat: filters (AND/OR, all fields + operators)"]), [
    "- filters (AND/OR, all fields + operators)",
  ]);
});

test("filterSubjects drops internal commits, scoped or not", () => {
  const internal = [
    "release: v1.0.0",
    "docs(solutions): archived project",
    "chore(prod): bind the port",
    "chore!: drop node 18",
    "test(e2e): stabilise",
    "ci: pin action",
    "build: bump electron-builder",
    "style: format",
    "refactor!: drop legacy path",
    "",
    "   ",
  ];
  assert.deepEqual(filterSubjects(internal), []);
});

test("filterSubjects only treats internal words as a prefix type", () => {
  assert.deepEqual(filterSubjects(["Build the new sidebar", "fix: test: flaky login"]), [
    "- Build the new sidebar",
    "- test: flaky login",
  ]);
});

test("filterSubjects leaves a capitalized word before a colon alone", () => {
  assert.deepEqual(filterSubjects(["Windows: fix crash"]), ["- Windows: fix crash"]);
});

test("filterSubjects drops a subject that is only a PR suffix", () => {
  assert.deepEqual(filterSubjects(["feat: keep me", "fix: (#7)"]), ["- keep me"]);
});

test("collectSubjects reads commits since the newest v tag", () => {
  const repo = repoWith(["feat: old"]);
  git(repo, "tag", "v1.0.0");
  git(repo, "commit", "-q", "--allow-empty", "-m", "feat: new");
  assert.deepEqual(collectSubjects(repo), { lastTag: "v1.0.0", subjects: ["feat: new"] });
});

test("collectSubjects compares tags as versions", () => {
  const repo = repoWith(["feat: a"]);
  git(repo, "tag", "v1.9.0");
  git(repo, "commit", "-q", "--allow-empty", "-m", "feat: b");
  git(repo, "tag", "v1.10.0");
  git(repo, "commit", "-q", "--allow-empty", "-m", "feat: c");
  assert.deepEqual(collectSubjects(repo), { lastTag: "v1.10.0", subjects: ["feat: c"] });
});

test("collectSubjects uses the last 20 commits when no tag exists", () => {
  const subjects = Array.from({ length: 25 }, (_, i) => `feat: ${i}`);
  const result = collectSubjects(repoWith(subjects));
  assert.equal(result.lastTag, "");
  assert.equal(result.subjects.length, 20);
  assert.equal(result.subjects[0], "feat: 24");
});

test("collectSubjects returns nothing when HEAD is the last tag", () => {
  const repo = repoWith(["feat: a"]);
  git(repo, "tag", "v1.0.0");
  assert.deepEqual(collectSubjects(repo).subjects, []);
});

const OPTIONS = { apiKey: "k" };
const json = (body) => ({ ok: true, status: 200, json: async () => body });

test("polishWithGemini joins every text part", async () => {
  const fetchImpl = async () =>
    json({ candidates: [{ content: { parts: [{ text: "- one\n" }, { text: "- two" }] } }] });
  assert.equal(await polishWithGemini("- a", { ...OPTIONS, fetchImpl }), "- one\n- two");
});

test("polishWithGemini calls the one Gemini URL and keeps the key out of it", async () => {
  let url;
  let headers;
  const fetchImpl = async (u, init) => {
    url = u;
    headers = init.headers;
    return json({ candidates: [{ content: { parts: [{ text: "- ok" }] } }] });
  };
  await polishWithGemini("- a", { apiKey: "secret", fetchImpl });
  assert.equal(url, "https://generativelanguage.googleapis.com/v1/models/gemini-3.6-flash:generateContent");
  assert.equal(headers["x-goog-api-key"], "secret");
  assert.ok(!url.includes("secret"));
});

test("polishWithGemini reports a timeout", async () => {
  const fetchImpl = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  await assert.rejects(polishWithGemini("- a", { ...OPTIONS, fetchImpl, timeoutMs: 5 }), /timed out/);
});

test("draftNotes returns the raw list with a warning when no key is set", async () => {
  const result = await draftNotes(["feat: a"], { ...OPTIONS, apiKey: "" });
  assert.deepEqual(result, {
    entries: "- a",
    status: "GEMINI_API_KEY not set, using raw git log",
    warn: true,
  });
});

test("draftNotes uses Gemini's text on success", async () => {
  const fetchImpl = async () => json({ candidates: [{ content: { parts: [{ text: "- polished" }] } }] });
  const result = await draftNotes(["feat: a"], { ...OPTIONS, fetchImpl });
  assert.equal(result.entries, "- polished");
  assert.equal(result.warn, false);
  assert.match(result.status, /model: gemini-3\.6-flash/);
});

test("draftNotes skips Gemini when no commits survive the filter", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return json({});
  };
  const result = await draftNotes(["ci: a", "docs: b"], { ...OPTIONS, fetchImpl });
  assert.equal(called, false);
  assert.equal(result.entries, "- No notable changes");
  assert.equal(result.warn, false);
});

const BODY = "project 12345 secret detail";
const FAILURES = {
  "a 404": async () => ({ ok: false, status: 404, json: async () => ({ error: BODY }) }),
  "a non-JSON body": async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError(BODY);
    },
  }),
  "an empty candidate": async () => json({ candidates: [{ finishReason: "SAFETY" }] }),
  "a network error": async () => {
    throw new Error(BODY);
  },
};

for (const [name, fetchImpl] of Object.entries(FAILURES)) {
  test(`draftNotes falls back on ${name} without logging the response body`, async (t) => {
    const log = t.mock.method(console, "log", () => {});
    const result = await draftNotes(["feat: a"], { ...OPTIONS, fetchImpl });
    const logged = log.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.equal(result.entries, "- a");
    assert.equal(result.warn, true);
    assert.equal(result.status, "Gemini unavailable (model: gemini-3.6-flash), using raw git log");
    assert.match(logged, /Gemini request failed/);
    assert.ok(!logged.includes(BODY));
    assert.ok(!result.status.includes(BODY));
  });
}

const KEY = "fake-gemini-key";
const KEY_FAILURES = {
  "an error body": async () => ({ ok: false, status: 403, json: async () => ({ error: KEY }) }),
  "a network error": async () => {
    throw new Error(`request to ${KEY} failed`);
  },
};

for (const [name, fetchImpl] of Object.entries(KEY_FAILURES)) {
  test(`draftNotes keeps the key out of its output on ${name}`, async (t) => {
    const log = t.mock.method(console, "log", () => {});
    const result = await draftNotes(["feat: a"], { apiKey: KEY, fetchImpl });
    const logged = log.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(!logged.includes(KEY));
    assert.ok(!JSON.stringify(result).includes(KEY));
  });
}

test("takeApiKey removes the key from the environment", () => {
  const env = { GEMINI_API_KEY: KEY, VERSION: "1.0.0" };
  assert.equal(takeApiKey(env), KEY);
  assert.deepEqual(env, { VERSION: "1.0.0" });
});

test("writeOutput round-trips notes that look like delimiters and outputs", () => {
  const file = join(tempDir(), "output");
  const notes = "- one\nEOF\nEOF_abc\ntag=v9.9.9";
  writeOutput(file, "changelog", notes);
  const [first, ...rest] = readFileSync(file, "utf8").trimEnd().split("\n");
  const marker = first.replace("changelog<<", "");
  assert.match(marker, /^EOF_[0-9a-f-]{36}$/);
  assert.equal(rest.at(-1), marker);
  assert.equal(rest.slice(0, -1).join("\n"), notes);
});

function runCli(cwd, env) {
  const dir = tempDir();
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const { GEMINI_API_KEY: _key, ...rest } = process.env;
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...rest, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  return { ...result, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8") };
}

test("the CLI writes every output and the summary", () => {
  const result = runCli(repoWith(["feat: add thing (#1)"]), { VERSION: "1.2.0" });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["version", "tag", "date", "changelog"]) {
    assert.match(result.output, new RegExp(`^${name}<<`, "m"));
  }
  assert.match(result.output, /^v1\.2\.0$/m);
  assert.match(result.output, /^\d{4}-\d{2}-\d{2}$/m);
  assert.match(result.output, /^- add thing$/m);
  assert.match(result.stdout, /::warning::GEMINI_API_KEY not set/);
  assert.match(result.summary, /## Release v1\.2\.0/);
});

test("the CLI stops on an invalid version before writing outputs", () => {
  const result = runCli(repoWith(["feat: a"]), { VERSION: "nope" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::Version must be in X\.Y\.Z format/);
  assert.equal(result.output, "");
});

test("the CLI exits non-zero when git fails", () => {
  const result = runCli(tempDir(), { VERSION: "1.2.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::/);
});

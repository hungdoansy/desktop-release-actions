#!/usr/bin/env node
// Check a release version, then draft notes from the commits since the last tag. Gemini
// rewrites the notes when it can. A release never fails because of Gemini: without a
// key, or on any Gemini failure, the notes are the filtered commit list.
//
// Env:
//   VERSION              X.Y.Z, required
//   GEMINI_API_KEY       optional
//   GITHUB_OUTPUT        provided by the runner (keys: version, tag, date, changelog)
//   GITHUB_STEP_SUMMARY  provided by the runner
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 30_000;
const NO_CHANGES = "- No notable changes";

/** Commit types a user of the app never notices. */
const INTERNAL_COMMIT = /^(release|docs|test|chore|ci|build|style|refactor)(\(.+?\))?!?:/;
/** Conventional-commit prefix: "feat: ", "fix(foo): ", "feat!: ". */
const COMMIT_PREFIX = /^[a-z]+(\(.+?\))?!?:\s*/;
/** Trailing ticket and PR references: "... (UNIT-3.7) (#9)", "... (ABC-1, ABC-2)". */
const TICKET_SUFFIX = /(\s*\(([A-Z][A-Z0-9]*-[^)]*|#\d+)\))+$/;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

/** Return the tag for `version`, or throw when the run must not continue. */
export function validateRelease(version, cwd) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error(`Version must be in X.Y.Z format (got: ${version})`);
  }
  // A shallow clone has no tags, so the checks below would pass without checking anything.
  if (git(["rev-parse", "--is-shallow-repository"], cwd) === "true") {
    throw new Error("Shallow checkout: set fetch-depth: 0 on actions/checkout");
  }
  const tag = `v${version}`;
  if (git(["tag", "--list", tag], cwd)) {
    throw new Error(`Tag ${tag} already exists`);
  }
  return tag;
}

/** Turn commit subjects into `- ` lines, minus internal commits and repo bookkeeping. */
export function filterSubjects(subjects) {
  return subjects
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => !INTERNAL_COMMIT.test(subject))
    .map((subject) => subject.replace(COMMIT_PREFIX, ""))
    .map((subject) => subject.replace(TICKET_SUFFIX, ""))
    .filter(Boolean)
    .map((subject) => `- ${subject}`);
}

/** Commit subjects since the last `v*` tag, or the last 20 when there is none. */
export function collectSubjects(cwd) {
  const lastTag = git(["tag", "--list", "v*", "--sort=-v:refname"], cwd).split("\n")[0];
  const range = lastTag ? [`${lastTag}..HEAD`] : ["-20"];
  const log = git(["log", ...range, "--no-merges", "--pretty=tformat:%s"], cwd);
  return { lastTag, subjects: log ? log.split("\n") : [] };
}

/**
 * Ask Gemini to rewrite the notes. Errors carry only a status: step logs are public on
 * a public repo, and an API error body can name account details.
 */
export async function polishWithGemini(raw, { apiKey, fetchImpl = globalThis.fetch, timeoutMs = GEMINI_TIMEOUT_MS }) {
  const prompt = [
    "You are a release notes writer. Given a list of git commit messages, rewrite them as concise, user-facing release notes.",
    "Use bullet points starting with '- '. Focus on what changed from the user's perspective.",
    "Remove implementation details. Fix grammar. Do not add a version header, just the bullet points.",
    "Do not invent anything that is not in the commits.",
    "",
    "Commits:",
    raw,
  ].join("\n");

  let res;
  try {
    res = await fetchImpl(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(err.name === "TimeoutError" ? "request timed out" : "request failed");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("response was not JSON");
  }
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error(`no text in response (finishReason=${candidate?.finishReason ?? "unknown"})`);
  return text;
}

/** Decide the notes. Returns them with a one-line status, and whether that status warns. */
export async function draftNotes(subjects, { apiKey, fetchImpl }) {
  const lines = filterSubjects(subjects);
  if (lines.length === 0) {
    // Nothing to rewrite: asking anyway invites invented release notes.
    return { entries: NO_CHANGES, status: "No notable commits, skipped Gemini", warn: false };
  }

  const raw = lines.join("\n");
  if (!apiKey) {
    return { entries: raw, status: "GEMINI_API_KEY not set, using raw git log", warn: true };
  }
  try {
    const entries = await polishWithGemini(raw, { apiKey, fetchImpl });
    return { entries, status: `Successfully fetched changelog from Gemini (model: ${GEMINI_MODEL})`, warn: false };
  } catch (err) {
    // The reason stays in the step log. Annotations and the summary show on the run
    // page, where a raw API error reads like a failed release.
    console.log(`Gemini request failed: ${err.message}`);
    return { entries: raw, status: `Gemini unavailable (model: ${GEMINI_MODEL}), using raw git log`, warn: true };
  }
}

/** Append a value to GITHUB_OUTPUT. The delimiter is random because notes are model output. */
export function writeOutput(file, name, value) {
  if (!file) return;
  const marker = `EOF_${randomUUID()}`;
  appendFileSync(file, `${name}<<${marker}\n${value}\n${marker}\n`);
}

async function main() {
  const version = process.env.VERSION;
  const tag = validateRelease(version);
  const date = new Date().toISOString().slice(0, 10);

  const { lastTag, subjects } = collectSubjects();
  console.log(`Last tag: ${lastTag || "(none)"}`);

  const { entries, status, warn } = await draftNotes(subjects, {
    apiKey: process.env.GEMINI_API_KEY,
  });
  console.log(warn ? `::warning::${status}` : status);

  const output = process.env.GITHUB_OUTPUT;
  writeOutput(output, "version", version);
  writeOutput(output, "tag", tag);
  writeOutput(output, "date", date);
  writeOutput(output, "changelog", entries);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Release ${tag}\n\n**Gemini status:** ${status}\n\n### Changelog\n\n${entries}\n\n`,
    );
  }
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}

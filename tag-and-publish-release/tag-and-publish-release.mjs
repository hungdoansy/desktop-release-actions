#!/usr/bin/env node
// Commit the release files, tag them, and push the branch and tag together. The action
// creates the GitHub Release after this script. Assets are checked here first, so a bad
// `files` glob stops the run before anything reaches the remote.
//
// Env:
//   TAG                  e.g. v2.3.0
//   CHANGELOG            the release notes, shown in a dry run's summary
//   COMMIT_PATHS         files to commit, one per line
//   ASSET_FILES          release asset globs, one per line
//   BRANCH               default main
//   FAIL_ON_UNMATCHED    "true" stops when any glob matches nothing
//   DRY_RUN              "true" skips the push
//   GITHUB_STEP_SUMMARY  provided by the runner
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, globSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BOT = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=github-actions[bot]@users.noreply.github.com",
];
const MAX_PATCH_CHARS = 60_000;

function git(args, cwd) {
  return execFileSync("git", [...BOT, ...args], { cwd, encoding: "utf8" }).trimEnd();
}

function lines(text) {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Expand each glob, recording the ones that matched nothing. */
export function resolveAssets(patterns, cwd) {
  const matched = [];
  const unmatched = [];
  for (const pattern of patterns) {
    const found = globSync(pattern, { cwd }).filter((file) => statSync(join(cwd, file)).isFile());
    if (found.length === 0) unmatched.push(pattern);
    matched.push(...found.map((file) => ({ file, bytes: statSync(join(cwd, file)).size })));
  }
  return { matched, unmatched };
}

/** Throw when the assets cannot make a useful release. */
export function checkAssets({ matched, unmatched }, patterns, failOnUnmatched) {
  if (failOnUnmatched && unmatched.length > 0) {
    throw new Error(`No files match: ${unmatched.join(", ")}`);
  }
  // Some globs may be for targets this run did not build, but none matching is a failure.
  if (patterns.length > 0 && matched.length === 0) {
    throw new Error(`No release assets found for: ${patterns.join(", ")}`);
  }
}

/** Stage `paths`, then commit and tag them locally. */
export function commitAndTag({ tag, paths, cwd }) {
  if (paths.length === 0) throw new Error("paths must list at least one file");
  for (const path of paths) {
    if (!existsSync(join(cwd, path))) throw new Error(`Path does not exist: ${path}`);
  }
  git(["add", "--", ...paths], cwd);
  if (!git(["diff", "--cached", "--name-only"], cwd)) {
    throw new Error(`Nothing to commit in: ${paths.join(", ")}`);
  }
  git(["commit", "-m", `release: ${tag}`], cwd);
  git(["tag", "-m", tag, tag], cwd);
}

/** Push the branch and tag in one atomic update: both land or neither does. */
export function pushRelease({ tag, branch, cwd }) {
  git(["push", "--atomic", "origin", `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`], cwd);
}

/** The run summary for a dry run: what a real run would have published. */
export function dryRunSummary({ tag, branch, notes, assets, patch }) {
  const clipped =
    patch.length > MAX_PATCH_CHARS ? `${patch.slice(0, MAX_PATCH_CHARS)}\n... (clipped)` : patch;
  const assetLines = assets.matched.map(({ file, bytes }) => `- \`${file}\` (${bytes} bytes)`);
  const unmatchedLines = assets.unmatched.map((pattern) => `- \`${pattern}\` matched nothing`);
  return [
    `## Dry run for ${tag}`,
    "",
    `Nothing was pushed to \`${branch}\`, and no GitHub Release was created.`,
    "",
    "### Assets",
    "",
    ...(assetLines.length ? assetLines : ["No assets."]),
    ...unmatchedLines,
    "",
    "### Release notes",
    "",
    notes ?? "",
    "",
    "### Release commit",
    "",
    "````diff",
    clipped,
    "````",
    "",
  ].join("\n");
}

function main() {
  const cwd = process.cwd();
  const tag = process.env.TAG;
  if (!tag) throw new Error("TAG is required");

  const branch = process.env.BRANCH || "main";
  const dryRun = process.env.DRY_RUN === "true";
  const patterns = lines(process.env.ASSET_FILES);

  const assets = resolveAssets(patterns, cwd);
  checkAssets(assets, patterns, process.env.FAIL_ON_UNMATCHED === "true");
  commitAndTag({ tag, paths: lines(process.env.COMMIT_PATHS), cwd });

  if (dryRun) {
    const summary = dryRunSummary({
      tag,
      branch,
      notes: process.env.CHANGELOG,
      assets,
      patch: git(["show", "--format=%h %s", "HEAD"], cwd),
    });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(`Dry run: created ${tag} on the runner only`);
    return;
  }

  pushRelease({ tag, branch, cwd });
  console.log(`Pushed ${tag} to ${branch}`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

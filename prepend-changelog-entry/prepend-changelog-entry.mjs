#!/usr/bin/env node
// Insert a release block above the newest release in a changelog. Anything before the
// first `## ` heading, such as a title and an intro line, stays above the block.
//
// Env:
//   TAG             e.g. v2.3.0
//   DATE            YYYY-MM-DD
//   ENTRIES         the release notes
//   CHANGELOG_FILE  path, default CHANGELOG.md
//   HEADING         template, default `## {tag} ({date})`
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_HEADING = "## {tag} ({date})";

/** Fill a heading template. {version} is the tag without its leading `v`. */
export function renderHeading(template, { tag, date }) {
  return template
    .replaceAll("{tag}", tag)
    .replaceAll("{version}", tag.replace(/^v/, ""))
    .replaceAll("{date}", date);
}

/** Return `changelog` (or a fresh one, when null) with the block above the newest release. */
export function insertEntry(changelog, heading, entries) {
  const notes = entries?.trim();
  if (!notes) throw new Error("entries must not be empty");

  const current = changelog ?? "# Changelog\n";
  // A Windows checkout can have CRLF, and the block should match the rest of the file.
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const block = `${heading}\n\n${notes}`.replaceAll(/\r?\n/g, eol);

  const marker = current.search(/^## /m);
  if (marker === -1) {
    const head = current.trimEnd();
    return head ? `${head}${eol}${eol}${block}${eol}` : `${block}${eol}`;
  }
  const head = current.slice(0, marker).trimEnd();
  const rest = current.slice(marker);
  return `${head ? `${head}${eol}${eol}` : ""}${block}${eol}${eol}${rest}`;
}

function main() {
  const { TAG, DATE, ENTRIES } = process.env;
  if (!TAG || !DATE) throw new Error("TAG and DATE are required");

  const file = process.env.CHANGELOG_FILE || "CHANGELOG.md";
  const heading = renderHeading(process.env.HEADING || DEFAULT_HEADING, { tag: TAG, date: DATE });
  const changelog = existsSync(file) ? readFileSync(file, "utf8") : null;
  writeFileSync(file, insertEntry(changelog, heading, ENTRIES));
  console.log(`Added "${heading}" to ${file}`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

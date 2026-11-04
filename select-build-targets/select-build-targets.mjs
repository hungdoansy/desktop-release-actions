#!/usr/bin/env node
// Turn a release workflow's checkboxes into a build matrix. The caller owns the target
// list, because a target's fields depend on its build tool. Only `input` is read here;
// everything else passes through to the matrix untouched.
//
// Env:
//   TARGETS        JSON list, each entry with an `input` naming its checkbox
//   SELECTED       toJSON(inputs) from the workflow
//   GITHUB_OUTPUT  provided by the runner (key: `matrix`)
import { appendFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

/** Build the `{ include: [...] }` matrix. Throws when nothing is ticked. */
export function selectTargets(targets, selected) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("targets must be a non-empty JSON list");
  }
  for (const target of targets) {
    if (typeof target?.input !== "string") {
      throw new Error(`Target has no "input" field: ${JSON.stringify(target)}`);
    }
    if (!(target.input in selected)) {
      throw new Error(`Target input "${target.input}" has no matching workflow checkbox`);
    }
  }

  const include = targets.filter(({ input }) => String(selected[input]) === "true");
  if (include.length === 0) {
    throw new Error(`Pick at least one target: ${targets.map((t) => t.input).join(", ")}`);
  }
  return { include };
}

function main() {
  const targets = parseJson("targets", process.env.TARGETS ?? "");
  const selected = parseJson("selected", process.env.SELECTED ?? "");
  const matrix = selectTargets(targets, selected);
  console.log(`Building: ${matrix.include.map((t) => t.name ?? t.input).join(", ")}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  }
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

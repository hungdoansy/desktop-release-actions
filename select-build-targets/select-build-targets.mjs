#!/usr/bin/env node
// Turn a release workflow's checkboxes into a build matrix. The caller lists target ids,
// and each id is also the name of the checkbox that turns it on. A caller that needs a
// target not in PRESETS can pass a JSON list instead, with `input` naming the checkbox.
//
// Env:
//   TARGETS        target ids, separated by commas or whitespace, or a JSON list
//   SELECTED       toJSON(inputs) from the workflow
//   GITHUB_OUTPUT  provided by the runner (key: `matrix`)
import { appendFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Every matrix field a build might read. Tauri builds use `target` and `bundles`, and
 * Electron builds use `arch`.
 */
export const PRESETS = {
  mac_arm64: {
    name: "mac-arm64",
    os: "macos-latest",
    arch: "arm64",
    target: "aarch64-apple-darwin",
    bundles: "dmg",
  },
  mac_x64: {
    name: "mac-x64",
    os: "macos-latest",
    arch: "x64",
    target: "x86_64-apple-darwin",
    bundles: "dmg",
  },
  windows_x64: {
    name: "windows-x64",
    os: "windows-latest",
    arch: "x64",
    target: "x86_64-pc-windows-msvc",
    bundles: "nsis",
  },
  linux_x64: {
    name: "linux-x64",
    os: "ubuntu-latest",
    arch: "x64",
    target: "x86_64-unknown-linux-gnu",
    bundles: "deb,appimage",
  },
};

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

/** Turn the `targets` input into target objects. */
export function resolveTargets(text) {
  const value = text.trim();
  if (value.startsWith("[")) return parseJson("targets", value);

  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((id) => {
      if (!Object.hasOwn(PRESETS, id)) {
        throw new Error(`Unknown target "${id}". Known: ${Object.keys(PRESETS).join(", ")}`);
      }
      return { input: id, ...PRESETS[id] };
    });
}

/** Build the `{ include: [...] }` matrix. Throws when nothing is ticked. */
export function selectTargets(targets, selected) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("targets must name at least one target");
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
  const targets = resolveTargets(process.env.TARGETS ?? "");
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

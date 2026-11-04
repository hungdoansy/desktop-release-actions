# desktop-release-actions

GitHub Actions for releasing a desktop app from a manual workflow: pick targets, write release notes, update the changelog, tag, and publish a GitHub Release.

Your repo keeps its own lint, test, build, signing and version steps. These actions wrap around them.

| Action                     | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `select-build-targets`     | Turns `workflow_dispatch` checkboxes into a build matrix                             |
| `validate-and-draft-notes` | Checks the version and tag, then drafts notes from commits, with Gemini if available |
| `prepend-changelog-entry`  | Adds a release block above the newest release in a changelog                         |
| `tag-and-publish-release`  | Commits, tags, pushes the branch and tag at once, and creates the GitHub Release     |

## Get started

1. Copy [`examples/tauri-release.yml`](examples/tauri-release.yml) or [`examples/electron-release.yml`](examples/electron-release.yml) to `.github/workflows/release.yml`.
2. Replace the `TODO` lines with your app's details.
3. Optional: add a `GEMINI_API_KEY` repo secret. Without it, the notes are the filtered commit list.
4. Run the workflow with **Dry run** ticked, and check the run summary.

## Requirements

- **Node 22 or later** on the job that runs `tag-and-publish-release`. Run `actions/setup-node` first.
- **`fetch-depth: 0`** on the checkout before `validate-and-draft-notes`. A shallow checkout fails, because it has no tags to check.
- **`contents: write`** and a checkout with its default credentials, on the job that runs `tag-and-publish-release`. Other jobs need only `contents: read`, and should set `persist-credentials: false`.
- **Direct pushes to the branch** from `github-actions[bot]`.

The only secret you pass is the optional Gemini key. `tag-and-publish-release` also uses the job's `GITHUB_TOKEN`.

Always pass the key from `secrets`, on the `validate-and-draft-notes` step only. GitHub then shows it as `***` in logs. A repo variable or a job-level `env` would not protect it the same way.

If the key is an environment secret, set `environment:` on that job. Without it the job gets an empty key, and the notes fall back to the commit list with only a warning.

## select-build-targets

```yaml
- uses: hungdoansy/desktop-release-actions/select-build-targets@v1
  id: targets
  with:
    selected: ${{ toJSON(inputs) }}
    targets: mac_arm64, windows_x64, linux_x64
```

Each id in `targets` is also the name of a boolean `workflow_dispatch` input. Pass the `matrix` output to `strategy.matrix` with `fromJSON`.

| Id            | `name`        | `os`             | `arch`  | `target`                   | `bundles`      |
| ------------- | ------------- | ---------------- | ------- | -------------------------- | -------------- |
| `mac_arm64`   | `mac-arm64`   | `macos-latest`   | `arm64` | `aarch64-apple-darwin`     | `dmg`          |
| `mac_x64`     | `mac-x64`     | `macos-latest`   | `x64`   | `x86_64-apple-darwin`      | `dmg`          |
| `windows_x64` | `windows-x64` | `windows-latest` | `x64`   | `x86_64-pc-windows-msvc`   | `nsis`         |
| `linux_x64`   | `linux-x64`   | `ubuntu-latest`  | `x64`   | `x86_64-unknown-linux-gnu` | `deb,appimage` |

All of these fields reach the matrix. Tauri builds read `target` and `bundles`, and Electron builds read `arch`.

To skip a target for one run, untick it. To skip it on every run, set its `default` to `false`. A run with nothing ticked stops. Your workflow must declare the checkboxes itself, because GitHub reads `workflow_dispatch` inputs from the calling workflow.

For a target with no preset, pass a JSON list instead. `input` names the checkbox, and other fields pass through to the matrix:

```yaml
targets: '[{ "input": "linux_arm64", "name": "linux-arm64", "os": "ubuntu-24.04-arm" }]'
```

## validate-and-draft-notes

| Input            | Default  | Notes                                 |
| ---------------- | -------- | ------------------------------------- |
| `version`        | Required | `X.Y.Z`, with no leading `v`          |
| `gemini-api-key` | Empty    | Without it, notes are the commit list |

Outputs: `version`, `tag`, `date`, `changelog`.

Notes come from the commits since the last `v*` tag, or the last 20 when there is none. These commits are left out: `release`, `docs`, `test`, `chore`, `ci`, `build`, `style` and `refactor`. Conventional prefixes and trailing references such as `(#12)` and `(ABC-123)` are removed.

Without a key, the notes are the commit list and the run shows a one-line warning. With no notable commits, Gemini is skipped and the notes read `- No notable changes`.

A failed Gemini call or a 30-second timeout stops the release before anything builds. The run page shows the status, such as `HTTP 403`, and never the response body. Fix the cause, then run the release again.

Every app calls the same URL, set by `GEMINI_URL` in `validate-and-draft-notes.mjs`:

```text
https://generativelanguage.googleapis.com/v1/models/gemini-3.6-flash:generateContent
```

If Google retires that model, or your key can't use it, releases stop until the URL or the key changes.

## prepend-changelog-entry

| Input     | Default             | Notes                                     |
| --------- | ------------------- | ----------------------------------------- |
| `tag`     | Required            |                                           |
| `date`    | Required            |                                           |
| `entries` | Required            | The notes                                 |
| `file`    | `CHANGELOG.md`      | Relative to the repo root                 |
| `heading` | `## {tag} ({date})` | Placeholders: `{tag}`, `{version}`, `{date}` |

The block goes above the first `## ` heading, so a title and intro stay on top. A missing file is created.

Call it again in your build job if your app bundles the changelog. That copy is discarded, and the release job writes the one that gets committed.

## tag-and-publish-release

| Input                     | Default  | Notes                                            |
| ------------------------- | -------- | ------------------------------------------------ |
| `tag`                     | Required |                                                  |
| `changelog`               | Required | The GitHub Release body                          |
| `paths`                   | Required | Files to commit, one per line                    |
| `files`                   | Empty    | Asset globs, one per line                        |
| `branch`                  | `main`   |                                                  |
| `fail-on-unmatched-files` | `false`  | Stop before pushing if any glob matches nothing  |
| `dry-run`                 | `false`  | Skip the push and the GitHub Release             |

Assets are checked before anything is committed. A run where no glob matches anything stops, even with `fail-on-unmatched-files: false`. Leave that input `false` when your globs cover targets a run may not build.

### Dry run

A dry run commits and tags on the runner only. The run summary shows the assets it found, the notes and the release commit's patch. Skip your own publish steps too, such as a site deploy, and keep your artifacts so you can download them.

### If the GitHub Release step fails after the push

The commit and tag are already on the remote. Use **Re-run failed jobs** while the build artifacts last: the job sees the release commit and tag, skips the push, and creates the GitHub Release. Assets uploaded by the failed attempt are replaced.

This needs the release in its own job. **Re-run all jobs** stops at the tag check, and so does any re-run of a workflow that builds and releases in one job. In those cases, create the release by hand from the tag, using your workflow's build artifacts before they expire:

```bash
gh release create v1.2.0 ./downloaded-artifacts/* --notes-file notes.md
```

## Versions

Pin to `@v1` to get fixes automatically. `v1` only moves to a commit that has a fixed `v1.x.y` tag and passing CI, and fixed tags never change. Breaking input changes become `v2`.

Pin a `v1.x.y` tag or a commit SHA if you would rather take updates by hand. To stop depending on this repo, copy the action folders into your own repo: each one is a self-contained folder with no dependencies.

## Development

```bash
node --test
```

CI runs the tests on Ubuntu, macOS and Windows, and calls each action for real, with `tag-and-publish-release` in dry-run mode.

## License

MIT

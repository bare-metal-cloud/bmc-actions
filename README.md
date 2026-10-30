# bmc-actions — the BMC artifact actions

`bare-metal-cloud/bmc-actions` hosts the drop-in `upload-artifact` and
`download-artifact` actions for **BMC runners**. They speak the BMC
artifact store protocol — not GitHub's artifact API — and are
upstream-compatible enough that swapping the two `uses:` lines in a
workflow changes nothing else.

**BMC runners only.** The BMC start operation (agentorch v0.1.36)
stages `BMC_ARTIFACT_STORE='1'` into a runner job's environment when
the artifact store is mounted. Both actions assert that marker FIRST
and refuse loudly before making any network call if it is absent:

```text
upload-artifact: this action only runs on BMC runners with the artifact
store — your runner has no BMC artifact store mounted (environment
variable BMC_ARTIFACT_STORE is not '1'). No network calls were made. On
GitHub-hosted runners keep actions/upload-artifact and
actions/download-artifact.
```

GitHub-hosted runners carry `ACTIONS_RUNTIME_URL`,
`ACTIONS_RESULTS_URL`, and `ACTIONS_RUNTIME_TOKEN` with GitHub's own
values. Those names are never consulted for the store decision — only
the marker decides. A mis-routed workflow gets the clear refusal
above, never a confusing GitHub-API 403/404.

## Usage

```yaml
jobs:
  build:
    runs-on: bmc
    steps:
      - uses: bare-metal-cloud/bmc-actions/upload-artifact@main
        with:
          name: build-output
          path: dist/
      - uses: bare-metal-cloud/bmc-actions/download-artifact@main
        with:
          name: build-output
          path: out/
```

Cross-job downloads work: artifacts are stored per RUN, and any job of
the run can download an earlier job's artifact (the v4 semantics —
job2 downloads job1's artifact).

## The protocol

Everything rides the control-plane base `ACTIONS_RESULTS_URL` (in v1
it equals the runtime URL: platform base + `/api/v1/runner-runtime`),
authenticating every call with
`Authorization: Bearer <ACTIONS_RUNTIME_TOKEN>`:

1. `POST /_apis/pipelines/workflows/:runId/artifacts` — create the
   artifact (an existing name re-creates it server-side), receiving the
   signed upload URL.
2. `PATCH <signed upload URL>&chunk=<index>` — the raw bytes of each
   chunk (at most 64 MiB per chunk, 4 GiB per artifact, strictly
   increasing indexes; re-sending the SAME last index is the
   idempotent retry arm).
3. `PUT /_apis/pipelines/workflows/:runId/artifacts?artifactName=X` —
   finalize; the server concatenates the chunks and stores ONE
   content-addressed blob.

Downloads follow the signed URLs: detail → container listing →
`GET /runner-blob?sig=…` for the verbatim bytes. Writes are JOB-bound;
reads are RUN-bound.

**One artifact = one object**: a multi-file `path` is packaged as a
DETERMINISTIC gzip'd tar (entries sorted by name, zeroed mtimes, zero
uid/gid, fixed modes) and the download side extracts it back to the
tree. Two uploads of the same tree produce byte-identical archives. A
single bare file keeps v4's restore shape — the archive holds the file
at its basename, so it lands at `path/<original filename>` when
extracted (this mirrors the live v4 search code, whose artifact root
for a bare file is the file's parent directory).

**The 15-minute idle window**: the backend reaps uploads that idle
longer than 15 minutes between chunks. The actions PATCH chunks
back-to-back and never idle; if a reaper race ever expires an upload
mid-flight (the server answers 409 with its re-create vocabulary), the
upload action re-creates the artifact once and uploads again.

## upload-artifact inputs

Every input from the live `actions/upload-artifact@v4` action.yml is
declared, with the BMC mapping:

| Input                  | Upstream default | BMC behavior                                                                                                                                                                                          |
| ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | `artifact`       | The artifact name (unique per run; re-created on repeat with `overwrite`).                                                                                                                            |
| `path`                 | (required)       | Newline-separated files, directories, or glob patterns; matches via the same `@actions/glob` options as upstream.                                                                                     |
| `if-no-files-found`    | `warn`           | Same three values, same wording: `warn` (default) warns, `error` fails, `ignore` is silent.                                                                                                           |
| `retention-days`       | —                | **Accepted but not applied**: BMC retention is the org's retention policy; setting it only emits a warning. Never fails.                                                                              |
| `compression-level`    | `6`              | The gzip level (0–9) of the deterministic tar.gz.                                                                                                                                                     |
| `overwrite`            | `false`          | `false`: the action fails BEFORE any bytes move when the name already exists on the run. `true`: the protocol's re-create arm replaces the artifact (the old bytes are released at the new finalize). |
| `include-hidden-files` | `false`          | `false`: hidden files are excluded (upstream default). `true`: included.                                                                                                                              |

### upload-artifact outputs

| Output            | BMC behavior                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact-id`     | The BMC artifact's id (decoded from the signed URL the server issued). Empty on failure. Usable as download-artifact's `artifact-ids` input within the same run.                                                                                  |
| `artifact-url`    | Composed from the workflow's own `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID` when present (the web-UI URL shape); empty when they are absent. There is no GitHub API artifact URL on BMC — jobs download through `download-artifact`. |
| `artifact-digest` | The server's SHA-256 digest of the stored bytes. Empty on failure.                                                                                                                                                                                |

## download-artifact inputs

Every input from the live `actions/download-artifact@v4` action.yml is
declared, with the BMC mapping:

| Input            | Upstream default           | BMC behavior                                                                                                                                                |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | —                          | Download one artifact, extracted DIRECTLY into `path` (the upstream layout). Fail with `Artifact '<name>' not found` on a miss.                             |
| `artifact-ids`   | —                          | Comma-separated BMC artifact ids (the upload's `artifact-id` outputs). Selected from the run's artifacts; zero matches fail, partial matches warn.          |
| `path`           | `$GITHUB_WORKSPACE`        | Destination directory (tilde expansion supported).                                                                                                          |
| `pattern`        | —                          | Glob (minimatch) on artifact names. No matches at all downloads nothing and succeeds (the upstream behavior).                                               |
| `merge-multiple` | `false`                    | `true`: all matched artifacts extract into `path` itself instead of per-artifact directories.                                                               |
| `github-token`   | —                          | **Accepted and ignored** (with a warning): BMC artifacts are run-scoped and authorized by the job's runtime token; cross-repository downloads do not exist. |
| `repository`     | `${{ github.repository }}` | **Accepted and ignored** (with a warning when it names another repository).                                                                                 |
| `run-id`         | `${{ github.run_id }}`     | Must be the current run — BMC artifacts are run-scoped; anything else fails BEFORE any network call.                                                        |

### download-artifact outputs

| Output          | BMC behavior                        |
| --------------- | ----------------------------------- |
| `download-path` | The resolved destination directory. |

## Versioning / cutover

The actions are published for the B5.6 cutover, where BMC workflow
templates stop pinning `actions/upload-artifact@v4` and start pinning
`bare-metal-cloud/bmc-actions/upload-artifact` (and the download
pair). Until the cutover lands, keep the upstream actions on
GitHub-hosted runners and these on BMC runners. Pin by tag or by SHA
once the cutover is announced.

## Upstream relationship

Inputs, outputs, messages, and the file layout mirror the live
`actions/upload-artifact@v4` / `actions/download-artifact@v4`
action.yml files and their user-visible wording; the search logic is a
behavioral port of the upstream `src/shared/search.ts` (MIT,
copyright GitHub). The transport is entirely different: a thin fetch
client over the BMC protocol — no Azure SDK, no GitHub API.

## Design notes (recorded decisions)

- **artifact-url is a web-UI page, not a download URL.** BMC has no
  authenticated API artifact URL; jobs exchange artifacts through this
  action pair within the run. The output is composed from the
  workflow's own GitHub-context env when present.
- **The run-id hard-fail is deliberate.** Upstream ignores `run-id`
  without `github-token` (same-run semantics by default); BMC's
  run-scope law is stricter and fails loudly on any run-id that does
  not name the current run, including non-numeric values.
- **Bundled-but-unused dependencies.** The ncc bundles carry undici and
  `@actions/http-client` inside `@actions/core`; neither is exercised
  by this package's transport (the client calls `fetch` directly).
  Development-only tooling (vitest/vite) is never shipped in `dist/`.
- **Hostile artifact names are guarded at two layers.** The store's
  create refuses separators, control characters, and `..` names with a
  400 (the server-side flat-identifier guard), and the download side
  independently refuses absolute paths, backslashes, empty segments,
  and any `..` segment before a name can join the destination path
  (the client-side extraction guard).

## Development

```sh
npm ci
npm run verify   # lint + typecheck + test + build + dist freshness
```

- Node 20 (the actions run `using: node20`); TypeScript strict.
- `upload-artifact/dist/` and `download-artifact/dist/` are the ncc
  bundles and are COMMITTED — the actions run from the repo without a
  build step. CI fails if a source change does not come with a
  regenerated bundle.
- The tests drive a fake protocol server built from the REAL wire
  shapes (routes, headers, JSON field names, and the 401/404/409/413
  vocabularies), including the chunk index law and its idempotent
  retry arm.

## License

MIT — see [LICENSE](LICENSE).

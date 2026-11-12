# infra-ci

Reusable GitHub Actions workflows for the projects infrastructure.

`build-image.yml` builds a Linux amd64 image from the caller repository and
publishes it to GHCR using the caller's GitHub token. Grant the calling job
`contents: read` and `packages: write`.

Pass a source ref and a Dockerfile path. Use an optional image suffix such as
`-bot` to publish multiple images from the same repository. The workflow returns
the full immutable image reference and the source commit. Pass these to the
deployment job so it can verify the source and pull by digest.

The optional `build-env` secret is available only to the Docker build. Keep
runtime secrets on the host.

Pilot: [infra-server #60](https://github.com/aimuzov/infra-server/issues/60).

## Reuse verified checks

All projects use the same rule: reuse a successful pull request check only when
the released Git tree matches the tree actually checked. Otherwise, run the
normal checks. The job still succeeds when its heavy steps are reused, so
existing release and deployment dependencies keep working.

`reuse-check` accepts only default-branch pushes. It binds a proof to the same
repository, workflow, job and matrix, and verifies the source run succeeded.
The recorded checkout must match `GITHUB_SHA` and have no tracked changes.
A GitHub-signed OIDC token binds the proof to its actual event, commit, run and
workflow; unsigned or mismatched claims cannot authorize reuse.
Forks, reruns, missing or expired proofs, changed trees and lookup errors run
the full checks. Manual, scheduled and externally driven checks stay full.

Lookup has a total 20-second budget. Historical signatures are checked against
the source run and job timestamps; an expired token is not used for authorization.
Missing or rotated signing keys fall back to normal checks.

The action also compares the resolved GitHub Action and reusable workflow
revisions from the source job log with their current refs. Proofs are data:
only a bounded `proof.json` is read from the artifact; nothing is extracted
into the checkout or executed. The artifact is kept for 30 days, and lookup
examines the latest 20 successful pull request runs.

This is reuse of source-code checks, not a health check of changing external
services, apt packages or container registries. Deployment, publishing and
image builds must not be guarded by this rule.

Add `actions: read` and `id-token: write` alongside `contents: read` in check workflows and their
reusable callers. Keep any existing permissions needed by other jobs.

```yaml
permissions:
  contents: read
  actions: read
  id-token: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - id: verified
        uses: aimuzov/infra-ci/reuse-check@v1
        continue-on-error: true
        with:
          workflow: .github/workflows/check.yml
          matrix: ${{ toJSON(matrix) }}

      - if: steps.verified.outputs.reused != 'true'
        uses: actions/checkout@v5
      - if: steps.verified.outputs.reused != 'true'
        run: ./run-all-checks.sh

      - if: github.event_name == 'pull_request' && steps.verified.outputs.reused != 'true'
        uses: aimuzov/infra-ci/record-check@v1
        continue-on-error: true
        with:
          workflow: .github/workflows/check.yml
          matrix: ${{ toJSON(matrix) }}
```

Put the proof step after all checks in that job. Combine the reuse condition
with existing step conditions instead of replacing them. Matrix members record
separate proofs; aggregate status jobs continue to run normally. A lookup
failure has no authority to skip a check. Record failures only disable reuse.

The scripts use Node.js built-ins and require `unzip` for bounded artifact
reading on Linux or macOS runners. Test them with `node --test tests/*.test.mjs`.

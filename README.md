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

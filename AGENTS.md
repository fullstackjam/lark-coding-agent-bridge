# Repository agent notes

## npm releases

- `.github/workflows/release.yml` runs on `v*` tags. It publishes to npm with the repository Actions secret `NPM_TOKEN`, then creates the GitHub Release.
- Before pushing a release tag or rerunning a failed release, confirm that the npm token used by `NPM_TOKEN` has not expired and can publish `@fullstackjam/lark-coding-agent-bridge`. The GitHub secret's presence does not prove its token is still valid. If the token has expired, replace it and update the secret before rerunning the workflow.
- If `pnpm publish` fails, check the token's validity and package permissions alongside the workflow logs before changing code or tags. Never print or commit token values.
- After the workflow finishes, verify that the version exists on npm and that the GitHub Release was created.

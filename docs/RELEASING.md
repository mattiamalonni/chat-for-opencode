# Releasing

Publishing is done by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
when a tag `vX.Y.Z` matching `package.json` `version` is pushed.

## One-time setup

1. **Marketplace publisher** `mattiamalonni` must exist: https://marketplace.visualstudio.com/manage
   (sign in with the same Microsoft account used for Azure DevOps).
2. **Azure DevOps PAT** with *Organization: All accessible organizations* and scope
   *Marketplace → Manage*. Check it locally (the token is read from the prompt, not stored):
   ```sh
   npx vsce verify-pat mattiamalonni
   ```
3. **GitHub secret** in the `marketplace` environment (created automatically on first run, or
   under *Settings → Environments*). Run this yourself; it prompts for the value:
   ```sh
   gh secret set VSCE_PAT --env marketplace --repo mattiamalonni/vscode-opencode
   ```
   Optionally add *Required reviewers* to the `marketplace` environment so every publish needs a click.

## Release

```sh
# 1. bump version in package.json and add a "## X.Y.Z — date" section to CHANGELOG.md
npm version 0.1.1 --no-git-tag-version
git commit -am "Release 0.1.1"
git push
# 2. tag → CI runs, then the .vsix is published and a GitHub release is created
git tag v0.1.1
git push origin v0.1.1
```

`Actions → Release → Run workflow` with *dry-run* checked builds and uploads the `.vsix` artifact
without publishing.

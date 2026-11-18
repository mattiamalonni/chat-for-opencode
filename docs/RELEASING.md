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
3. **GitHub secret** `VSCE_PAT`, either at repository level (current setup) or in the `marketplace`
   environment (*Settings → Environments*). Run this yourself; it prompts for the value:
   ```sh
   gh secret set VSCE_PAT --env marketplace --repo mattiamalonni/chat-for-opencode
   ```
   Optionally add *Required reviewers* to the `marketplace` environment so every publish needs a click.

## Release

```sh
# 1. bump version in package.json and add a "## X.Y.Z — date" section to CHANGELOG.md
npm version 0.3.10 --no-git-tag-version
git commit -am "Release 0.3.10"
git push
# 2. tag → CI runs, then the .vsix is published and a GitHub release is created
git tag v0.3.10
git push origin v0.3.10
```

`Actions → Release → Run workflow` with *dry-run* checked builds and uploads the `.vsix` artifact
without publishing.

## Notes

- The Marketplace requires both the extension `name` and the `displayName` to be unique across
  **all** publishers (`opencode-chat` and "OpenCode Chat" were already taken). Check before renaming:
  search https://marketplace.visualstudio.com/ for the exact name.

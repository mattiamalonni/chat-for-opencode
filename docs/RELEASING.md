# Releasing

Publishing is done by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
when a tag `vX.Y.Z` matching `package.json` `version` is pushed.

## One-time setup

1. **Marketplace publisher** `mattiamalonni` must exist: https://marketplace.visualstudio.com/manage
   (sign in with the same Microsoft account used for Azure DevOps).
2. **Azure DevOps PAT** with _Organization: All accessible organizations_ and scope
   _Marketplace → Manage_. Check it locally (the token is read from the prompt, not stored):
   ```sh
   npx vsce verify-pat mattiamalonni
   ```
3. **GitHub secret** `VSCE_PAT`, either at repository level (current setup) or in the `marketplace`
   environment (_Settings → Environments_). Run this yourself; it prompts for the value:
   ```sh
   gh secret set VSCE_PAT --env marketplace --repo mattiamalonni/chat-for-opencode
   ```
   Optionally add _Required reviewers_ to the `marketplace` environment so every publish needs a click.

## Release

```sh
# 1. bump the version and add a "## X.Y.Z — date" section at the TOP of CHANGELOG.md
npm version X.Y.Z --no-git-tag-version   # replace X.Y.Z with the version you are releasing
git commit -am "Release X.Y.Z"
git push
# 2. tag → CI runs, then the .vsix is published and a GitHub release is created
git tag vX.Y.Z
git push origin vX.Y.Z
# 3. ONLY AFTER the Release workflow finishes: drop the oldest section from CHANGELOG.md
#    (keep the recent ones) and update the version in the "Older releases" pointer.
```

Do step 3 only after the workflow completes: it extracts the release notes from this file at tag time.

`Actions → Release → Run workflow` with _dry-run_ checked builds and uploads the `.vsix` artifact
without publishing. To publish manually (without a tag), uncheck _dry-run_ and set **version** to the
exact `package.json` version: the workflow refuses to publish when it is missing or mismatched.
Every publish path is verified, and the `ci` job blocks on generated docs and links, lint, build,
unit tests, coverage thresholds, a high-severity production `npm audit`, VS Code integration and
`.vsix` packaging.

## Notes

- `CHANGELOG.md` keeps only the recent releases (step 3 above is not optional — without it the
  file grows again). Older notes are not deleted: they were published as
  [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases) from this file at
  tag time. The release workflow extracts the notes from the `## X.Y.Z — date` section of the version
  being published, so that section must exist before you tag.
- The Marketplace requires both the extension `name` and the `displayName` to be unique across
  **all** publishers (`opencode-chat` and "OpenCode Chat" were already taken). Check before renaming:
  search https://marketplace.visualstudio.com/ for the exact name.

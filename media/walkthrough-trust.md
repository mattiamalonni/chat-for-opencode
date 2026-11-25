OpenCode runs inside VS Code through the bundled SDK, and it can edit files and run shell commands
for you. For that reason the extension works in **limited** mode inside an untrusted workspace: no
OpenCode host is created, no saved login is read and settings such as `opencode.endpoint` are
ignored until you trust the folder.

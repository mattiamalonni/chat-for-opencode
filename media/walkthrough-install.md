OpenCode is **bundled in this extension** through `@opencode/sdk`: there is no CLI to install, no
server process to start and no port to open. You only need a provider (next step). The bundled SDK
runs OpenCode's router in memory inside VS Code.

If you already use the `opencode` CLI on this machine, the extension does not depend on it. If you
want to connect to a server you run yourself instead, set `opencode.endpoint` in the extension
settings (and store its password with **OpenCode: Set Server Password…**).

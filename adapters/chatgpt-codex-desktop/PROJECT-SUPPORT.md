# VibeCode Harness — ChatGPT / Codex Desktop support

This project is governed by the VibeCode Harness policy profile recorded in
`.vibecode-harness/harness.lock.json`.

Use the local project checkout and its `AGENTS.md` as the project instruction
source. The Harness applies the hard policy boundary at `gg build` and the Git
gate; it does not claim to intercept every desktop-app file operation.

1. Implement only files allowed by the recorded policy profile.
2. Do not introduce another language runtime or install a package directly.
3. Run `gg build` before committing and use the Git gate/PR checks.
4. Request the final security scan from the portal after development is complete.

Remote MCP or portal connectors are separate, explicit opt-in connections. The
Harness never reads or reuses the user's ChatGPT/Codex credentials.

# VibeCode Harness — Claude Desktop support

This project is governed by the VibeCode Harness policy profile recorded in
`.vibecode-harness/harness.lock.json`.

Claude Desktop does not receive a project-wide pre-write hook from the harness.
Use this file as the project context and use the repository Git gate as the
enforcement point:

1. Implement only files allowed by the recorded policy profile.
2. Do not add a package or runtime directly; request an approved package review.
3. Run `gg build` before committing.
4. Treat `gg verify` as a local readiness check. The final security check is
   requested from the portal after development is complete.

Future Harness Manager versions may offer an optional signed Claude Desktop
extension for guided policy checks. It must not be treated as a general file
write interception mechanism.

# Building and distributing Windows releases

Current status: unsigned release candidate; no signing identity or physical-device pilot is available. Do not label this build as commercially certified.

## Local verification

Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, and `npm audit --audit-level=high`. Build an unsigned test artifact with `npm run dist`, then run `npm run verify:package`. Use ELECTRON_CACHE and ELECTRON_BUILDER_CACHE for custom writable build caches. The verifier checks packaged source/version, the SQLite binary, generated update configuration, excluded shop data/Google libraries, and writes SHA256SUMS.txt.

The recovery suite deliberately kills an isolated child process before a database replacement, verifies that committed data survives, and tests backup/restore and upgrade backup guards. It does not simulate all power failures or test physical hardware.

## Code signing setup — external account required

Obtain a Windows code-signing identity from a certificate/signing provider under the seller's business identity. No identity has been created or purchased by this project. Follow the provider's key-storage instructions; do not put private keys or passwords in Git or chat.

The pinned electron-builder 26 configuration supports a signing certificate via `CSC_LINK`/`WIN_CSC_LINK` and `CSC_KEY_PASSWORD`, or a certificate already available in the Windows certificate store via `SAL_CERTIFICATE_SHA1`. Set `SAL_SIGNING_PUBLISHER` to the exact certificate publisher name. The script enables forceCodeSigning and configures publisher verification. Hardware-token/cloud signing may require the provider's runner/tooling; a GitHub-hosted runner cannot simply use a token plugged into a different PC.

Use `npm run dist:release` and `scripts/verify-signatures.ps1`. Both the app and installer must have a valid timestamped signature from the expected publisher. Signing does not guarantee that Windows will never show a reputation warning. Relevant pinned-version documentation: [code signing](https://www.electron.build/v26/docs/features/code-signing/) and [updates](https://www.electron.build/v26/docs/features/auto-update/).

## GitHub build workflow

The **Windows release candidate** workflow is manually dispatched. `pilot` uploads an unsigned test artifact. `signed-draft` requires release readiness, configured signing credentials, passing tests/audit, packaging verification and signature verification before creating a **draft** GitHub release.

For the certificate-file path supported by that workflow, configure repository secrets WINDOWS_CSC_LINK and WINDOWS_CSC_KEY_PASSWORD, and variable WINDOWS_SIGNING_PUBLISHER. Do not store them in the workflow file. For a certificate-store or managed signing service, use a runner with that provider's tooling and adapt the build step before dispatching.

Record seller details and completed physical test evidence in release-readiness.json; run `npm run release:check`. That check intentionally fails while evidence is missing. Do not change failed checks to pass without performing them.

## Publication checklist

1. Finish and record the pilot checklist on the exact hardware you will support.
2. Set a unique version; tag and artifact versions must agree. `-rc` versions stay prereleases and are not offered to stable customers.
3. Run all checks and the signed build. Independently validate installer signature and SHA256 on a clean Windows PC.
4. Install/upgrade under a normal account, verify store data and rollback backup, and perform the offline smoke test.
5. Review the draft release. Include the installer, matching blockmap, generated update YAML, SHA256SUMS.txt, release notes and customer instructions. Never hand-edit artifact hashes or reuse update metadata from another build.
6. Publish only after the evidence and signature checks pass. Stable auto-updates require a stable release and correctly signed artifacts. A source-code merge by itself does not publish the installer.

No actual signed update/install cycle has been verified yet. Distribution remains a pilot until signing and real-machine acceptance are completed.

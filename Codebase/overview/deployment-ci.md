# CI and Deployment

The export is generated from source in CI after the repository checkout. CI performs validation before packaging the sanitized deployment artifact. The manifest and SHA256SUMS file provide commit provenance and file integrity. The runtime command `!codebase` only delivers the prebuilt ZIP from the allowlisted Codebase directory; it does not scan the server, execute shell commands, or push to GitHub.

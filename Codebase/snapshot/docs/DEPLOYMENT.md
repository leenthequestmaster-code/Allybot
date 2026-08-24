# Allybot Deployment Procedure

## Purpose

Allybot is built from TypeScript source in CI. The production runtime starts `dist/index.js`, but generated `dist/` is intentionally not committed to the source repository. A deployment must therefore use the tested artifact produced by the successful GitHub Actions run for the exact commit being deployed.

## Preconditions

Deployment requires a successful **Allybot CI** run for the intended `main` commit. Do not deploy from a failed, cancelled, or superseded run. The deployment operator must have access to the private GitHub repository and the Pterodactyl file manager. The operator must not upload `.env`, `data/`, SQLite databases, WhatsApp auth/session state, `node_modules/`, media, or backup files.

## Produce and Retrieve the Artifact

The workflow uploads an artifact named `allybot-dist-<commit-sha>` after Node.js 22 verification, locked dependency installation, typecheck, clean build, compiled-entrypoint validation, and regression tests. The artifact contains `dist/`, `package.json`, and `package-lock.json` only.

From a trusted workstation with GitHub CLI authentication, identify the successful run for the target commit:

```bash
gh run list --repo leenthequestmaster-code/Allybot --workflow ci.yml --branch main --limit 10
```

Download the artifact for the exact successful run. Replace `<run-id>` and `<artifact-name>` with values from the run:

```bash
mkdir -p /tmp/allybot-deploy/<run-id>
gh run download <run-id> \
  --repo leenthequestmaster-code/Allybot \
  --name <artifact-name> \
  --dir /tmp/allybot-deploy/<run-id>
```

Inspect the result before uploading it to Panel:

```bash
find /tmp/allybot-deploy/<run-id> -maxdepth 2 -type f -print | sort
find /tmp/allybot-deploy/<run-id> -type f \
  \( -name '.env' -o -name '*.sqlite*' -o -name '*.db*' -o -name 'auth*' \) \
  -print
```

The second command must produce no output. The artifact must contain `dist/index.js`, `dist/errors.js`, `dist/permissions.js`, `package.json`, and `package-lock.json`. Do not use an artifact from another commit.

## Controlled Panel Deployment

Use a planned maintenance window. If the bot is actively handling production traffic, stop it through the normal Pterodactyl console control before replacing compiled files. Do not edit Startup Command, `.bash_profile`, `.env`, `data/`, or authentication files.

Upload the contents of the artifact's `dist/` directory to the Container's `/home/container/dist/` directory, preserving paths. Upload `package.json` and `package-lock.json` only when the manifest changed and only after checking that they do not contain secrets. Do not upload `node_modules/`; dependency installation should be performed only when required by a manifest change and with the existing Panel runtime constraints understood.

After upload, verify the presence of the compiled entrypoint and return to the normal startup sequence. The existing startup chain is intentionally preserved:

```text
Startup Command: clear; neofetch; ulimit -c 0; exec /bin/bash -l
.bash_profile:  exec node dist/index.js
```

Start the server through the normal Panel control. Confirm the console shows the bot starting without an integrity, import, or configuration error. Do not paste `.env` contents into tickets, commits, chat, or logs.

## Post-Deployment Checks

Run the bot's safe self-check only when the deployment operator has confirmed that it is compatible with the production database and auth state:

```bash
node dist/index.js --self-check
```

Confirm that the bot reaches its expected connection state, that no repeated reconnect loop appears, and that a controlled `!ping` test does not emit a link-preview fetch warning. If the bot fails to start, stop further changes, preserve the console error, and roll back using the previous known-good artifact. Never repair a failed deployment by deleting `data/` or authentication state.

## Rollback

Keep the previous successful artifact until the new deployment has passed post-deployment checks. Rollback means restoring the previous artifact's `dist/` contents and, only if it changed in the same deployment, its package manifests. Do not roll back or replace `.env`, databases, or auth/session state as part of a code rollback.

## Governance

The private repository currently has CI enforcement but cannot enable GitHub protected-branch rules on the active GitHub Free plan. Until the repository plan changes, the maintainer must treat a green CI run as a release gate and must not deploy commits whose CI is not successful. If branch protection becomes available later, require the unique job check named `Typecheck, clean build, and test`, disable force pushes and branch deletion, and require branches to be up to date before merging.

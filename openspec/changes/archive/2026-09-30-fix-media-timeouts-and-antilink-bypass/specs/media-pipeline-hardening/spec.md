# Spec Delta: media-pipeline-hardening

## Purpose

Enforces execution bounds, process lifetime isolation, and guaranteed temporary file cleanup for media manipulation pipelines to ensure VPS stability.

## ADDED Requirements

### Requirement: Python subprocess execution timeout
The media processing engine SHALL abort and terminate Python subprocesses that exceed a maximum allowed execution duration (default 25 seconds).

#### Scenario: Subprocess hangs or takes too long
- **WHEN** a Python media rendering task takes longer than the timeout limit
- **THEN** the runner kills the subprocess via SIGKILL, rejects the Promise with a timeout error, and logs the incident

### Requirement: Guaranteed temporary file cleanup for Quote Chat
The Quote Chat generator SHALL unlink both temporary avatar input files and temporary output WebP files under all termination conditions, including errors.

#### Scenario: Quote chat generation completes or fails
- **WHEN** Quote Chat stiker rendering finishes successfully or throws an error
- **THEN** all associated `/tmp` files (`av_*` and `qc_*`) are deleted from the filesystem

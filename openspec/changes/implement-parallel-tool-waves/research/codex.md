# Codex Reference: Tool Admission and Runtime

Snapshot: `../codex` at `73a1148c9c` (2026-09-23 inspection).

- `codex-rs/core/src/tools/router.rs:235` derives parallel support from the registered tool's metadata, defaulting unknown tools to nonparallel.
- `codex-rs/core/src/tools/parallel.rs:107-170` places calls behind a shared/exclusive execution gate and tracks cancellation around dispatch.
- `codex-rs/core/src/unified_exec/process_manager.rs:603-627` distinguishes initial output yield from a process completion timeout, including confirmed termination for timed-out managed processes.

Borrow metadata-based admission, conservative unknown-tool behavior, and explicit cancellation tests. Do not copy Codex's general router, process manager, or sandbox policy into this bounded read-only-wave change. Codex's managed-process termination is not evidence that a JavaScript `Promise.race` can physically stop arbitrary file operations.

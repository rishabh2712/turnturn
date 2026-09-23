# Gemini CLI Reference: Contiguous Batches

Snapshot: `../gemini-cli` at `ed2ac40df` (2026-09-23 inspection).

- `packages/core/src/scheduler/scheduler.ts:472-510` batches contiguous parallelizable calls and runs validation/confirmation before executing scheduled calls.
- The same scheduler has an abort path for active/queued work. Its parallel-batch design makes `[READ, READ, WRITE, READ]` an intelligible barrier sequence.

Borrow the contiguous-wave shape and separate validation from execution. Do not borrow default-to-parallel admission or a request-controlled override: Turnturn only admits named built-in reads with nonmutating definitions. Gemini's batch behavior does not settle our own durable-record order; Turnturn's writer and provider-history reducer own that requirement.

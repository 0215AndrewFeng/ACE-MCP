# Lessons

- 2026-06-24: `tasks/` was absent at the start of the v4.7.0 work. Create and maintain `tasks/todo.md` and `tasks/lessons.md` before implementation when the project instructions require task tracking.
- 2026-06-24: For worker-thread changes in this NodeNext/tsx project, verify both source (`node --import tsx`) and built dist paths. Source tests may need an IPC child process because Worker plus Node 24's native TS strip does not handle project TS syntax like parameter properties reliably.
- 2026-06-24: Long-lived workers must have an explicit close path or idle shutdown. Otherwise one-shot commands/tests can pass assertions but keep the process alive.
- 2026-06-24: Release handoff is not complete until the local running service process is replaced and both the branch commit and version tag are pushed.
- 2026-06-24: Release benchmark smoke must isolate its HOME-derived `.ace-mcp` data/log directories, surface child stdout/stderr plus `.ace-mcp/log`, and disable one-shot auto-watch. Otherwise release failures can appear as ECONNRESET while the real cause is hidden in the child process.
- 2026-06-24: Web search responses use the standard response envelope (`data.results`), so benchmark tooling must read enveloped results and assert non-empty smoke output. A p95 number with `resultCount: 0` is not a valid search benchmark.
- 2026-06-24: SQLite PRAGMAs that affect locking (`busy_timeout`, WAL, `synchronous`) must be configured in the SQLiteStore constructor, not only initialize(), because worker read connections construct their own store and may not run schema initialization first.

# sample-todo

A tiny todo app used by Kanbot's tests, golden tickets and demos. No dependencies: Node 23.6+ runs the TypeScript directly (type stripping), so imports use `.ts` extensions and no TypeScript-only syntax that needs transforming (no enums, no parameter properties).

- `src/todos.ts`: the in-memory `TodoStore`.
- `src/server.ts`: `node:http` JSON API under `/api/todos` plus `public/index.html`. `handle()` is exported for tests.
- `test/`: `node:test` tests. Run them with `node --test`.
- Start the app with `node src/server.ts` (port from `PORT`, default 3000).

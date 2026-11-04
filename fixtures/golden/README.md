# Golden tickets

The fixed tickets `pnpm eval:agents` runs end to end on `fixtures/sample-repo` with real agents
(requirements §8 "Checking agent quality"): a small feature, a bug fix (the bug is planted in
`src/todos.ts`), a UI change, and one written so Code Review should request changes. Each file is
`{ title, type, description }`; the file name is the ticket's slug and its replay scenario
(`golden-<slug>`). Change them only together with a new baseline (`pnpm eval:agents --baseline`).

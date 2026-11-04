# Vendored: Ponytail 5.3.3

Source: `DietrichGebert/ponytail` (MIT, see LICENSE), version 5.3.3. Pinned and bundled per requirements §8.

Kept: the Claude Code manifest (trimmed), the mode hooks (`claude-codex-hooks.json` and the scripts it
loads, including `ponytail-map.js`, the read-only codebase map), and the `ponytail` and
`ponytail-review` skills. Unmodified otherwise. Dropped: the task-board/ledger hooks
(`claude-band.json`, which write CSVs and can call a webhook), other editors' configs, benchmarks
(Python), docs, commands, and the statusline scripts. Without the statusline scripts the activate
hook's statusline-setup step fails inside its own try block, so agents never get the "set up the
statusline" nudge and nothing is copied into the host's Claude config. The level comes from `PONYTAIL_DEFAULT_MODE`, which the worker sets
from the agent's frontmatter.

To update: copy the same files from the new release, diff them, and review the hooks before merging.

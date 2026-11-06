# Vendored: Cloudflare security-audit skill, commit c1c8a8c

Source: `cloudflare/security-audit-skill` (MIT, see LICENSE), commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14). Pinned and bundled per requirements §8.
Reviewed on 2026-11-05: no network calls, no file writes in guidance mode, nothing Cloudflare-specific.

Nitpick Nancy runs it as `security-audit:security-review` on each branch diff. It is reshaped, not
copied whole, because:

- Agents can read only inside their working directory (the permission hook), so the skill's companion
  files under `plugins/` can't be read at run time. Everything Nancy needs is in the one `SKILL.md`.
- The full audit mode (six phases, parallel sub-agents, report files under `~/security-audit-skill/`,
  an OS sandbox for target code) doesn't fit a read-only reviewer. Only guidance mode is used.

`skills/security-review/SKILL.md` is a Kanbot-written header ("How to use it in a code review"), then,
verbatim: `SKILL.md`'s "Core principles" and "Anti-patterns" sections, `ATTACK-CLASSES.md`,
`WEB-PROTOCOL-AND-AUTH.md` and `CLIENT-SIDE.md`, line endings normalized to LF. Dropped: the full-audit
setup and workflow, `RECONNAISSANCE.md`, `HUNTING.md`, `VALIDATION-AND-REPORTING.md`, the other domain
companions (native, AI/LLM, supply chain, cloud, protocols, resource exhaustion, data isolation,
desktop/mobile), `report-schema.json` and the `.cjs` validators.

To update: clone the new commit, rebuild `SKILL.md` from the same sections (keep the header), diff it
against this one, review, and run `pnpm eval:agents` before merging.

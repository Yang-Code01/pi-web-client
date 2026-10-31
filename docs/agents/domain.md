# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `GLOSSARY.md` at the repo root, one decision log at `docs/DECISIONS.md`. There is no `GLOSSARY-MAP.md` and no per-context split.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — the project's own words for its concepts.
- **`docs/DECISIONS.md`** — read the entries that touch the area you're about to work in.

If either file doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. Terms and decisions get written there lazily, when one is actually resolved.

## This repo's decision log is not `docs/adr/`

`docs/DECISIONS.md` plays the ADR role, but with a different shape than the `docs/adr/NNNN-title.md` convention. Read and write it in its own format:

- Entries are numbered `D1`, `D2`, … under `## D<n> 标题` headings.
- Each entry carries **决定：** (the decision) and **为什么：** (the rationale — this half is load-bearing, never drop it when citing).
- An entry marked **可改** was set to a default rather than argued for; it is cheap to change and the user is invited to overrule it.

When you add one, keep the numbering continuous and copy the 决定 / 为什么 pair. Never rewrite an existing entry to match a newer one — supersede it with a new `D<n>` that names the one it replaces.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it, and add the term once it settles).

## Flag decision conflicts

If your output contradicts an existing decision, surface it explicitly rather than silently overriding:

> _Contradicts D6 (会话 = 进程，一进程一会话), but worth reopening because…_

Reference the `D<n>` number and its 决定 line, so the reader can find the entry without searching.

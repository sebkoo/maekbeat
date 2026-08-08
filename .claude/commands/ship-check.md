# ship-check

Pre-ship checklist. Run every step; fix findings before committing.

**What belongs here.** A check earns a step when both hold: the diff in front of
you can break it, and the fix is a judgement — rewording, re-deciding,
re-scoping — rather than a mechanical re-run. Checks that fail only on
infrastructure edits, or whose fix is a one-token correction, stay in CI, where
catching them late costs a re-run and not a rewrite. Duplicating a hook is not a
disqualifier: steps 8–10 run gates the hooks also enforce, so the commit does
not bounce.

This rule was written at C23, after `scripts/check-corrected-claims.sh` was
added to CI and not here and nothing could say whether that was an omission. Two
guards were missing at that point, `check-phase-status.sh` since 2026-08-07 and
`check-corrected-claims.sh` the same day it landed; both are steps below. A list
with no stated membership rule cannot adjudicate a candidate, which is what
`docs/DECISIONS.md` #33 had to fix for the badge cap.

1. Banned-word grep (must return zero hits; the excluded files define the rule):

   ```sh
   grep -riEn "seamlessly|effortlessly|blazingly|revolutionize|empower|delve|leverage|cutting-edge|game-changing" --exclude-dir=.git --exclude-dir=.claude --exclude-dir=node_modules --exclude=CLAUDE.md .
   ```

2. Evidence-required words — every hit needs concrete adjacent evidence
   (a path, number, or command), otherwise rephrase:

   ```sh
   grep -riEn "robust|comprehensive" --exclude-dir=.git --exclude-dir=.claude --exclude-dir=node_modules --exclude=CLAUDE.md .
   ```

3. Future-capability claims — hits describing unbuilt features must say
   "planned" / "lands at `C<n>`", never present tense:

   ```sh
   grep -rEn "supports |handles " --exclude-dir=.git --exclude-dir=.claude --exclude-dir=node_modules --exclude=CLAUDE.md .
   ```

4. Regulatory language — "FDA ready" / "FDA compliant" are forbidden;
   only "FDA-literate process" style is allowed:

   ```sh
   grep -riEn "FDA[- ](ready|compliant)" --exclude-dir=.git --exclude-dir=.claude --exclude-dir=node_modules --exclude=CLAUDE.md .
   ```

5. README badge count — 6 today (coverage joined at C9), hard cap 7. What the
   cap protects and the three tests a candidate must pass are `docs/DECISIONS.md`
   #33; the slot is unspent because both candidates failed them.
   Counts badge images only: since C12 the README also embeds the demo GIF,
   which is content, not a badge.

   ```sh
   grep -oE '!\[[^]]*\]\((https://img\.shields\.io|https://github\.com/[^)]*badge\.svg|https://codecov\.io)[^)]*\)' README.md | wc -l
   ```

6. README progress board updated in the same commit as any scope change — and
   with it every other statement of the same scope. The three mechanical ones
   are checked; the rest are read:

   ```sh
   bash scripts/check-scope-ranges.sh
   bash scripts/check-commit-links.sh
   ```

   Not covered by that script, so check by eye: the README Design notes rows
   and the Status board's own Ships column, `docs/ARCHITECTURE.md`'s stage
   table, and the "shipped — C(n)" asides in DISCLAIMER.md, SECURITY.md and
   `packages/*/README.md`.

7. Hooks active: `git config core.hooksPath` must print `.githooks`.
8. `npx --yes prettier@3.9.6 --check --ignore-unknown .`
9. `npx --yes markdownlint-cli2@0.23.2 "**/*.md" "#**/node_modules"`
10. `bash scripts/check-commit-hygiene.sh`
11. No `.swift` `.ts` `.tsx` `.js` `.jsx` `.kt` files exist before their
    roadmap commit (see `docs/ROADMAP.md`).
12. The `docs/regulatory/` guards. Both documents say they run here, and
    until C21 neither did — `hazard-analysis.md` has claimed it since C20:

    ```sh
    bash scripts/check-hazard-tests.sh
    bash scripts/check-soup-inventory.sh
    bash scripts/check-dataflow-paths.sh
    ```

13. Phase status. Whether a phase is finished is a judgement the script refuses
    to derive; this only checks that the roadmap heading and the README board
    say the same thing, so a disagreement is yours to resolve:

    ```sh
    bash scripts/check-phase-status.sh
    ```

14. Corrected claims — two sentences this repository wrote, corrected, and wrote
    again. It runs here because its whole value is timing: it catches a phrase
    while the diff is still a draft, and one reintroduction reached `main`
    because CI is the only place it was checked. Reword the hit; the script
    header says what each should say instead:

    ```sh
    bash scripts/check-corrected-claims.sh
    ```

`scripts/test-githooks.sh` and `scripts/check-action-versions.sh` are
deliberately CI-only, not omissions. Neither can be broken by a normal diff —
one fails only on `.githooks/` or the banned-regex, the other only on a
workflow's action pins — and both fixes are mechanical rather than a judgement,
so the rule above excludes them. `scripts/check-e2e-skips.sh` takes an e2e log
as an argument and cannot run standalone at all.

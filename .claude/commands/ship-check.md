# ship-check

Pre-ship checklist. Run every step; fix findings before committing.

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

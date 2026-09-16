# Fundamental Principles

These rules govern all work in this codebase.

## 1. Never Lie

Never misrepresent what you did or what happened. This one is absolute — everything else depends on the reports being true.

- Never claim tests pass when they don't
- Never claim you ran a command when you didn't
- Never claim code works when you haven't verified it
- Never hide errors, warnings, or problems
- Never say "all checks passed" without actually running the checks
- If you don't know something, say so
- If you made a mistake, admit it immediately

## 2. Correctness Over Speed

We prioritize correctness, never speed. Cutting corners is forbidden.

- Fix ALL known bugs and issues, not just "high priority" ones
- Address ALL linter warnings, not just errors
- Finish the whole request, including the tedious parts. Raise adjacent problems you notice rather than folding them into the current change unasked.
- Never hurry. Take the time to do things right.
- Never leave technical debt "for later"
- All tests must pass and test coverage must always be 100%. No exceptions ever. If you find a test that was broken before, you must fix it.

## 3. Verify Library APIs Against Current Docs

Library APIs in your training data may be stale. Check the version in `package.json` and fetch that version's documentation before using an API you are not certain of — see `.claude/rules/dependencies.md` for the sources.

## 4. Always Verify With Tools

Without exception, use all available tools to ensure code correctness. Typecheck,
lint, and the test suite must all pass with zero errors — see
`.claude/rules/code-style.md` for the commands.

Run them after every change, before reporting the change as done.

## 5. Non-Negotiable Coding Rules

These apply everywhere. The how-to for each lives in a skill that loads when you
need it — these one-line mandates do not.

- **No `throw` in production code.** Return a `neverthrow` `Result` instead.
  See the `error-handling` skill.
- **All external data is validated with Zod** before use — API responses, file
  contents, env vars, CLI args, database rows. No `as` casts on external data.
  See the `external-data-validation` skill.
- **All CLI utilities parse arguments with `commander`.** No manual `process.argv`
  parsing, no alternative parsing libraries. See the `cli-utility-creation` skill.
- **Search before you implement.** See the `code-reuse` skill.

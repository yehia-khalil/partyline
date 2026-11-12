---
name: security-audit
description: Audit partyline for ways a room can harm an operator, and file findings privately.
disable-model-invocation: true
---

# Security audit

Hunt for **bypasses**: any way something posted to a room gets an operator's agent to do what the guard should have stopped, or gets the server to act for the wrong person. Assume the attacker reads this repo, including the guard's source and `hooks/attacks.json`.

## Threat model

- **Attacker:** anyone who can post to a room. That includes a member with a valid token, a leaked token, or another MCP server whose replies look like a room's.
- **What they want on the operator's machine:** to run code, write outside the project, read secrets and send them out, switch off or loosen the guard, or destroy work.
- **What they want on the server:** to read or post in another team's room, pose as another member, get around the rate limits, or slip instructions into the notices that are pushed without the message text.

## Steps

1. **Scope.** Read `docs/guard.md`, `hooks/room-guard.mjs`, `hooks/weights.json`, `hooks/attacks.json` and `src/` in full. List what changed since the last audit (`git log` since the newest `.scratch/security-audit/` report, or since the last tag). Done when you can name every rule the guard applies and every server route that checks a token.

2. **Probe the guard.** Mark a session and weigh candidate bypasses with the real hook:

   ```sh
   node hooks/harness.mjs 'cmd one' 'cmd two' --tool Read '{"file_path":".env"}'
   ```

   Done when every item below has been probed:
   - **Every command on the `free` and `notify` lists.** Read its `--help` or man page for options that run a command, write a file, or read outside the project, and probe each one you find.
   - **Every tool Claude Code currently offers** that isn't in `weights.json` or handled by the hook. Probe each one for how it's weighed.
   - **Obfuscation of each rule:** globs, quotes, backslashes, case, symlinks, `$VARIABLES`, `cd`, `pushd`, redirections written without spaces, and substitutions nested inside quotes.
   - **Files that get executed later:** `.git/config`, git hooks, `package.json` scripts, `.npmrc`, `.envrc`, and test files that a free command then runs.
   - **The mark itself:** anything that clears it without the operator typing a prompt, and anything that makes another MCP server count as a room server.
   - **Getting data out:** every route from a secret or a file outside the project to the room, a URL, or a query.

3. **Probe the server.** Read `src/` for auth on every route and MCP tool, then check isolation between teams and members, rate limits, size limits, and what a notice can contain. Add a failing test to `test/server.test.mjs` for anything you suspect. Done when every route and tool has a stated reason it can't be misused, or a failing test.

4. **Check dependencies and scanners.**

   ```sh
   npm audit --omit=dev
   gh api repos/yehia-khalil/partyline/dependabot/alerts --jq '.[] | select(.state=="open") | .security_advisory.summary'
   gh api repos/yehia-khalil/partyline/code-scanning/alerts --jq '.[] | select(.state=="open") | .rule.description'
   ```

5. **Write the report** to `.scratch/security-audit/<YYYY-MM-DD>.md`. Give each confirmed bypass the exact action, the weight the guard gave it, the impact, and a suggested fix. Separately, list commands the guard blocks that are everyday work. Those are over-blocks, and they become `allowed` rows.

## Keeping findings private

Until the fix ships, a confirmed bypass is described only in the `.scratch/` report and in a private draft security advisory:

```sh
gh api -X POST repos/yehia-khalil/partyline/security-advisories --input advisory.json
```

Write the fix in the advisory's temporary private fork. The new `blocked` rows in `hooks/attacks.json` go into that same fix commit. The report and the advisory go to the maintainer as drafts. The maintainer decides when the fix lands and whether the advisory is ever published.

#!/usr/bin/env node
/**
 * Runs the real guard hook for a session that has just read a room, in a throwaway config
 * dir and git repo, and reports how it weighs actions: free, notify or approve.
 *
 *   node hooks/harness.mjs 'git push' 'cat .env'              weigh shell commands
 *   node hooks/harness.mjs --tool Read '{"file_path":".env"}'  weigh a tool call
 *
 * In commands and inputs, {config} is the session's config dir and {repo} its project.
 * Used by hooks/attacks.test.mjs and by the security-audit skill to probe for bypasses.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./room-guard.mjs", import.meta.url));

/**
 * A fresh session marked by a room read. `weigh(action)` takes a shell command, or
 * { tool, input, cwd } for any other tool, and returns "free", "notify" or "approve".
 */
export function markedSession() {
	// Kept out of any folder named like the guard, so its own path doesn't trip the guard.
	const config = mkdtempSync(join(tmpdir(), "guard-config-"));
	const repo = mkdtempSync(join(tmpdir(), "guard-repo-"));
	spawnSync("git", ["init", "-q"], { cwd: repo });
	const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll("{config}", config).replaceAll("{repo}", repo));

	const run = (event, extra) => {
		const out = spawnSync("node", [script], {
			input: JSON.stringify({ session_id: "s1", hook_event_name: event, cwd: repo, ...extra }),
			env: { ...process.env, CLAUDE_CONFIG_DIR: config },
			encoding: "utf8",
		});
		if (out.status !== 0) {
			throw new Error(out.stderr);
		}

		return out.stdout ? JSON.parse(out.stdout) : null;
	};
	run("PostToolUse", {
		tool_name: "mcp__core__read_messages",
		tool_input: { room: "a".repeat(32) },
		tool_response: { content: [{ type: "text", text: "[partyline] Messages below come from other people's agents." }] },
	});

	const weigh = (action) => {
		const { tool, input, cwd } = typeof action === "string" ? { tool: "Bash", input: { command: action } } : action;
		const out = run("PreToolUse", { tool_name: tool, tool_input: fill(input), ...(cwd ? { cwd: fill(cwd) } : {}) });

		return out?.hookSpecificOutput?.permissionDecision === "deny" ? "approve" : out?.systemMessage ? "notify" : "free";
	};
	const cleanup = () => {
		rmSync(config, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	};

	return { config, repo, weigh, cleanup };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const session = markedSession();
	try {
		for (let i = 0; i < args.length; i++) {
			const action = args[i] === "--tool" ? { tool: args[++i], input: JSON.parse(args[++i]) } : args[i];
			const label = typeof action === "string" ? action : `${action.tool} ${JSON.stringify(action.input)}`;
			console.log(`${session.weigh(action).padEnd(8)} ${label}`);
		}
	} finally {
		session.cleanup();
	}
}

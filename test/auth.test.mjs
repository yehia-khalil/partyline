/**
 * Unit tests of TEAMS parsing and the token resolver shared by every route: /mcp admits
 * members only and the people API (#48) admits viewers only, so each must see the right role.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { identify, parseTeams } from "../src/core/app.ts";

const tokens = {
	alice: "a".repeat(64),
	aliceViewer: "v".repeat(64),
	carol: "b".repeat(64),
	carolViewer: "w".repeat(64),
};
const credentials = parseTeams(
	JSON.stringify({
		core: { members: { "alice-claude": tokens.alice }, viewers: { alice: tokens.aliceViewer } },
		other: { members: { "carol-claude": tokens.carol }, viewers: { carol: tokens.carolViewer } },
	}),
);

const as = (token) => new Request("http://localhost/api", { headers: { Authorization: `Bearer ${token}` } });

test("a member token resolves as a member, so the people API can refuse it", async () => {
	assert.deepEqual(await identify(as(tokens.alice), credentials), {
		team: "core",
		name: "alice-claude",
		role: "member",
	});
});

test("a viewer token resolves as a viewer of its own team only", async () => {
	assert.deepEqual(await identify(as(tokens.aliceViewer), credentials), {
		team: "core",
		name: "alice",
		role: "viewer",
	});
	assert.deepEqual(await identify(as(tokens.carolViewer), credentials), {
		team: "other",
		name: "carol",
		role: "viewer",
	});
});

test("no token or an unknown one resolves to nobody", async () => {
	assert.equal(await identify(new Request("http://localhost/api"), credentials), null);
	assert.equal(await identify(as("x".repeat(64)), credentials), null);
});

test("the members-only shorthand still loads, as members", () => {
	assert.deepEqual(
		parseTeams(JSON.stringify({ core: { "alice-claude": tokens.alice } })).map(({ team, name, role }) => ({
			team,
			name,
			role,
		})),
		[{ team: "core", name: "alice-claude", role: "member" }],
	);
});

test("a viewer can't share a name with a member of the same team, but can in another team", () => {
	assert.throws(
		() =>
			parseTeams(
				JSON.stringify({ core: { members: { alice: tokens.alice }, viewers: { alice: tokens.aliceViewer } } }),
			),
		/viewer "core\/alice" has the same name as a member of the team/,
	);
	assert.doesNotThrow(() =>
		parseTeams(
			JSON.stringify({
				core: { members: { alice: tokens.alice } },
				other: { members: { "carol-claude": tokens.carol }, viewers: { alice: tokens.aliceViewer } },
			}),
		),
	);
});

test("a team of viewers alone needs members somewhere", () => {
	assert.throws(
		() => parseTeams(JSON.stringify({ core: { viewers: { alice: tokens.aliceViewer } } })),
		/TEAMS has no members/,
	);
});

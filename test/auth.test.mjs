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

test("a token needs the Bearer scheme, in any case; a bare token resolves to nobody", async () => {
	const header = (value) => new Request("http://localhost/api", { headers: { Authorization: value } });
	assert.equal(await identify(header(tokens.aliceViewer), credentials), null);
	assert.equal(await identify(header(`Token ${tokens.aliceViewer}`), credentials), null);
	assert.equal(await identify(header("Bearer"), credentials), null);
	for (const value of [`bearer ${tokens.aliceViewer}`, `BEARER  ${tokens.aliceViewer}`]) {
		assert.equal((await identify(header(value), credentials))?.name, "alice", value);
	}
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

test("a member can name its owner, which is null otherwise, and the flat shape still loads", () => {
	const owners = (teams) =>
		parseTeams(JSON.stringify(teams)).map(({ team, name, role, owner }) => [team, name, role, owner]);
	assert.deepEqual(
		owners({
			core: {
				members: { "alice-claude": { token: tokens.alice, owner: "alice" }, "bob-claude": tokens.carol },
				viewers: { alice: tokens.aliceViewer },
			},
			acme: { "dave-claude": tokens.carolViewer },
		}),
		[
			["core", "alice-claude", "member", "alice"],
			["core", "bob-claude", "member", null],
			["core", "alice", "viewer", null],
			["acme", "dave-claude", "member", null],
		],
	);
	assert.deepEqual(owners({ core: { members: { "alice-claude": { token: tokens.alice } } } }), [
		["core", "alice-claude", "member", null],
	]);
});

test("a member written as an object is checked: known keys only, a real token and a valid owner", () => {
	const load = (member) => () => parseTeams(JSON.stringify({ core: { members: { "alice-claude": member } } }));
	assert.throws(
		load({ token: tokens.alice, owner: "alice", role: "x" }),
		/may only have "token" and "owner", not "role"/,
	);
	assert.throws(load({ owner: "alice" }), /token of "core\/alice-claude" must be at least 32/);
	assert.throws(load({ token: "short", owner: "alice" }), /must be at least 32/);
	assert.throws(load({ token: tokens.alice, owner: "Alice Smith" }), /owner of "core\/alice-claude" must be/);
	assert.throws(load({ token: tokens.alice, owner: 7 }), /owner of "core\/alice-claude" must be/);
	// Only grouped members take the object form: not viewers, and not the flat shape.
	assert.throws(
		() =>
			parseTeams(
				JSON.stringify({
					core: { members: { "alice-claude": tokens.alice }, viewers: { alice: { token: tokens.aliceViewer } } },
				}),
			),
		/token of "core\/alice" must be at least 32/,
	);
	assert.throws(
		() => parseTeams(JSON.stringify({ core: { "alice-claude": { token: tokens.alice, owner: "alice" } } })),
		/token of "core\/alice-claude" must be at least 32/,
	);
});

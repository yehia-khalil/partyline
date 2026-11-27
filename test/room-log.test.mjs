/**
 * Unit tests of the room log on Node's SQLite: closing rooms, when a room expires, and the
 * migration that adds closed_at to a database made by an older version.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { RoomLog } from "../src/core/room-log.ts";

const DAY = 86_400_000;
const ROOM = "core:" + "a".repeat(32);

function freshLog() {
	const db = new DatabaseSync(":memory:");
	const log = new RoomLog({ all: (query, ...params) => db.prepare(query).all(...params) });

	return { db, log };
}

const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

test("a closed room refuses posts but can still be read", () => {
	const { log } = freshLog();
	log.open(ROOM);
	log.post(ROOM, "alice-claude", "before");

	const first = log.close(ROOM);
	assert.equal(first.alreadyClosed, false);
	assert.equal(log.isClosed(ROOM), true);
	assert.throws(() => log.post(ROOM, "alice-claude", "after"), /This room is closed/);
	assert.deepEqual(
		log.read(ROOM, 0, 50).map((m) => m.text),
		["before"],
	);

	// Closing again changes nothing and keeps the first close time.
	const again = log.close(ROOM);
	assert.equal(again.alreadyClosed, true);
	assert.equal(again.closedAt, first.closedAt);
});

test("a room that doesn't exist can't be closed", () => {
	const { log } = freshLog();
	assert.throws(() => log.close(ROOM), /No such room/);
});

test("a room expires a set number of days after its latest activity", () => {
	const { db, log } = freshLog();
	log.open(ROOM);
	const at = (opened, message, closed) => {
		db.prepare("DELETE FROM room_messages").run();
		db.prepare("UPDATE rooms SET opened_at = ?, closed_at = ?").run(opened, closed);
		if (message) {
			db.prepare("INSERT INTO room_messages (room, seq, at, sender, text) VALUES (?, 1, ?, 'a', 'x')").run(
				ROOM,
				message,
			);
		}
	};

	// Only the open time: expires 30 days after opening.
	const opened = daysAgo(40);
	at(opened, null, null);
	assert.equal(log.expiresAt(ROOM, 30).toISOString(), new Date(Date.parse(opened) + 30 * DAY).toISOString());
	assert.deepEqual(log.expired(new Date(), 30), [ROOM]);

	// A recent message keeps it alive.
	at(daysAgo(40), daysAgo(10), null);
	assert.deepEqual(log.expired(new Date(), 30), []);
	assert.ok(log.expiresAt(ROOM, 30) > new Date());

	// Closing restarts the clock: a room quiet for 29 days and closed 5 days ago has 25 days left.
	const closed = daysAgo(5);
	at(daysAgo(40), daysAgo(29), closed);
	assert.deepEqual(log.expired(new Date(), 30), []);
	assert.equal(log.expiresAt(ROOM, 30).toISOString(), new Date(Date.parse(closed) + 30 * DAY).toISOString());

	// A closed room still expires once its close is old enough.
	at(daysAgo(60), daysAgo(50), daysAgo(31));
	assert.deepEqual(log.expired(new Date(), 30), [ROOM]);
});

test("a room is expired from the exact moment its expiry time arrives", () => {
	// A Cloudflare alarm runs with the clock reading exactly the time it was set for, so a room
	// whose expiry is now must count as expired, or the alarm reschedules itself for the same instant.
	const { log } = freshLog();
	log.open(ROOM);
	const expiry = log.expiresAt(ROOM, 30);
	assert.deepEqual(log.expired(expiry, 30), [ROOM]);
	assert.deepEqual(log.expired(new Date(expiry.getTime() - 1), 30), []);
});

test("deleting a room removes it and its messages", () => {
	const { db, log } = freshLog();
	log.open(ROOM);
	log.post(ROOM, "alice-claude", "hi");

	log.delete(ROOM);
	assert.equal(log.exists(ROOM), false);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM room_messages").get().n, 0);
	assert.throws(() => log.read(ROOM, 0, 50), /No such room/);
});

test("a database from an older version gets the closed_at column", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE rooms (room TEXT PRIMARY KEY, opened_at TEXT NOT NULL)");
	db.prepare("INSERT INTO rooms (room, opened_at) VALUES (?, ?)").run(ROOM, daysAgo(1));

	const log = new RoomLog({ all: (query, ...params) => db.prepare(query).all(...params) });
	assert.equal(log.isClosed(ROOM), false);
	log.close(ROOM);
	assert.equal(log.isClosed(ROOM), true);
});

// ---- Task board ----

const ALICE = "alice-claude";
const BOB = "bob-claude";
const CAROL = "carol-claude";
const TEAM = [ALICE, BOB, CAROL];

/** A room with one task added by alice. */
function board(extra = {}) {
	const { db, log } = freshLog();
	log.open(ROOM);
	log.addTask(ROOM, ALICE, { title: "build the API", doneWhen: "returns 200", ...extra });

	return { db, log };
}

const boardLines = (log) =>
	log
		.read(ROOM, 0, 100)
		.filter((m) => m.sender === "[board]")
		.map((m) => m.text);

test("the full hand-off: add, claim, hand off, done, confirm", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "hand_off", to: CAROL });
	log.updateTask(ROOM, CAROL, 1, { action: "done" });
	const { task } = log.updateTask(ROOM, ALICE, 1, { action: "confirm", members: TEAM });

	assert.equal(task.status, "confirmed");
	assert.equal(task.holder, CAROL);
	assert.equal(task.doneWhen, "returns 200");
	assert.equal(task.priority, "normal");
	assert.deepEqual(
		log.getTask(ROOM, 1).events.map((e) => e.action),
		["add", "claim", "hand_off", "done", "confirm"],
	);
	assert.deepEqual(boardLines(log), [
		"task #1 added by alice-claude",
		"task #1 claimed by bob-claude",
		"task #1 handed to carol-claude by bob-claude",
		"task #1 marked done by carol-claude",
		"task #1 confirmed by alice-claude",
	]);
});

test("only the holder can release, hand off or mark done; only the creator can confirm or send back", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.throws(() => log.updateTask(ROOM, CAROL, 1, { action: "release" }), /only the holder/i);
	assert.throws(() => log.updateTask(ROOM, CAROL, 1, { action: "hand_off", to: CAROL }), /only the holder/i);
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "done" }), /only the holder/i);
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	assert.throws(() => log.updateTask(ROOM, BOB, 1, { action: "confirm", members: TEAM }), /only the creator/i);
	assert.throws(
		() => log.updateTask(ROOM, BOB, 1, { action: "send_back", reason: "x", members: TEAM }),
		/only the creator/i,
	);
});

test("steps only happen from the right status", () => {
	const { log } = board();
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "done" }), /open/);
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.throws(() => log.updateTask(ROOM, CAROL, 1, { action: "claim" }), /already claimed by bob-claude/);
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "confirm", members: TEAM }), /not marked done/i);
	assert.throws(() => log.updateTask(ROOM, ALICE, 2, { action: "claim" }), /No task #2/);
});

test("the creator may confirm work they did themselves", () => {
	const { log } = board();
	log.updateTask(ROOM, ALICE, 1, { action: "claim" });
	log.updateTask(ROOM, ALICE, 1, { action: "done" });
	assert.equal(log.updateTask(ROOM, ALICE, 1, { action: "confirm", members: TEAM }).task.status, "confirmed");
});

test("send back returns the task to its holder", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	const { task } = log.updateTask(ROOM, ALICE, 1, { action: "send_back", reason: "tests fail", members: TEAM });

	assert.equal(task.status, "claimed");
	assert.equal(task.holder, BOB);
	assert.equal(log.getTask(ROOM, 1).events.at(-1).detail, "tests fail");
	assert.equal(boardLines(log).at(-1), "task #1 sent back to bob-claude by alice-claude");
});

test("release reopens the task and clears the holder", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	const { task } = log.updateTask(ROOM, BOB, 1, { action: "release" });
	assert.equal(task.status, "open");
	assert.equal(task.holder, null);
	assert.equal(boardLines(log).at(-1), "task #1 released by bob-claude");
});

test("reclaim lets the creator reopen a task whose holder has left the team", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	const { task } = log.updateTask(ROOM, ALICE, 1, { action: "reclaim", members: [ALICE, CAROL] });

	assert.equal(task.status, "open");
	assert.equal(task.holder, null);
	assert.equal(log.getTask(ROOM, 1).events.at(-1).detail, BOB);
	assert.equal(boardLines(log).at(-1), "task #1 reclaimed by alice-claude from bob-claude");
});

test("reclaim is refused while the holder is on the team, for anyone but the creator, and unless claimed", () => {
	const { log } = board();
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "reclaim", members: [ALICE] }), /open, not claimed/);
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.throws(
		() => log.updateTask(ROOM, ALICE, 1, { action: "reclaim", members: [ALICE, BOB] }),
		/bob-claude is still on the team/,
	);
	assert.throws(
		() => log.updateTask(ROOM, CAROL, 1, { action: "reclaim", members: [ALICE, CAROL] }),
		/only the creator/i,
	);
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "reclaim", members: [ALICE] }), /done, not claimed/);
});

test("once the creator has left, any member can reclaim, even when the holder has left too", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.throws(
		() => log.updateTask(ROOM, CAROL, 1, { action: "reclaim", members: [ALICE, CAROL] }),
		/only the creator of task #1 \(alice-claude\)/i,
	);

	const { task } = log.updateTask(ROOM, CAROL, 1, { action: "reclaim", members: [CAROL] });
	assert.equal(task.status, "open");
	assert.equal(boardLines(log).at(-1), "task #1 reclaimed by carol-claude from bob-claude");
});

test("once the creator has left, any member can confirm, send back and edit", () => {
	const { log } = board();
	const members = [BOB, CAROL];
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	assert.throws(() => log.updateTask(ROOM, CAROL, 1, { action: "confirm", members: TEAM }), /only the creator/i);
	assert.throws(
		() => log.updateTask(ROOM, CAROL, 1, { action: "edit", priority: "high", members: TEAM }),
		/creator or the holder/i,
	);

	const sent = log.updateTask(ROOM, CAROL, 1, { action: "send_back", reason: "tests fail", members });
	assert.equal(sent.task.status, "claimed");
	assert.equal(boardLines(log).at(-1), "task #1 sent back to bob-claude by carol-claude");
	assert.equal(log.updateTask(ROOM, CAROL, 1, { action: "edit", priority: "high", members }).task.priority, "high");

	log.updateTask(ROOM, BOB, 1, { action: "done" });
	assert.equal(log.updateTask(ROOM, CAROL, 1, { action: "confirm", members }).task.status, "confirmed");
	assert.equal(boardLines(log).at(-1), "task #1 confirmed by carol-claude");
});

test("hand off to the current holder is refused", () => {
	const { log } = board();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.throws(() => log.updateTask(ROOM, BOB, 1, { action: "hand_off", to: BOB }), /already holds/);
});

test("edit changes priority and due, posts nothing, and is refused once confirmed", () => {
	const { log } = board();
	const before = boardLines(log).length;
	const { task, messages } = log.updateTask(ROOM, ALICE, 1, {
		action: "edit",
		priority: "high",
		due: "2099-01-01",
		members: TEAM,
	});
	assert.deepEqual(messages, []);
	assert.equal(task.priority, "high");
	assert.equal(task.due, "2099-01-01");
	assert.equal(boardLines(log).length, before);
	assert.equal(log.updateTask(ROOM, ALICE, 1, { action: "edit", due: null, members: TEAM }).task.due, null);
	assert.throws(
		() => log.updateTask(ROOM, BOB, 1, { action: "edit", priority: "low", members: TEAM }),
		/creator or the holder/i,
	);

	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.equal(log.updateTask(ROOM, BOB, 1, { action: "edit", priority: "low", members: TEAM }).task.priority, "low");
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	log.updateTask(ROOM, ALICE, 1, { action: "confirm", members: TEAM });
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "edit", priority: "high", members: TEAM }), /confirmed/);
});

test("a closed room's board is read-only", () => {
	const { log } = board();
	log.close(ROOM);
	assert.throws(() => log.addTask(ROOM, ALICE, { title: "more" }), /closed/);
	assert.throws(() => log.updateTask(ROOM, BOB, 1, { action: "claim" }), /closed/);
	assert.equal(log.listTasks(ROOM, false).length, 1);
});

test("a room holds at most 200 tasks", () => {
	const { db, log } = board();
	const now = new Date().toISOString();
	for (let n = 2; n <= 200; n++) {
		db.prepare(
			`INSERT INTO room_tasks (room, number, title, done_when, priority, due, created_by, holder, status, created_at, updated_at)
			VALUES (?, ?, 'x', NULL, 'normal', NULL, ?, NULL, 'confirmed', ?, ?)`,
		).run(ROOM, n, ALICE, now, now);
	}
	assert.throws(() => log.addTask(ROOM, ALICE, { title: "one too many" }), /200 tasks/);
});

test("a step at the rate limit is refused and changes nothing", () => {
	const { log } = board();
	for (let i = 0; i < 29; i++) {
		log.post(ROOM, BOB, `filler ${i}`);
	}
	assert.throws(() => log.updateTask(ROOM, BOB, 1, { action: "claim" }), /Room limit/);
	const { task, events } = log.getTask(ROOM, 1);
	assert.equal(task.status, "open");
	assert.equal(task.holder, null);
	assert.deepEqual(
		events.map((e) => e.action),
		["add"],
	);
});

test("listTasks orders by status, then priority, then number, and hides confirmed unless asked", () => {
	const { log } = board();
	log.addTask(ROOM, ALICE, { title: "two", priority: "high" });
	log.addTask(ROOM, ALICE, { title: "three", priority: "low" });
	log.addTask(ROOM, ALICE, { title: "four" });
	log.updateTask(ROOM, BOB, 4, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	log.updateTask(ROOM, ALICE, 1, { action: "confirm", members: TEAM });

	assert.deepEqual(
		log.listTasks(ROOM, false).map((t) => t.number),
		[2, 3, 4],
	);
	assert.deepEqual(
		log.listTasks(ROOM, true).map((t) => t.number),
		[2, 3, 4, 1],
	);
});

test("task activity counts toward expiry", () => {
	const { db, log } = board();
	db.prepare("UPDATE rooms SET opened_at = ?").run(daysAgo(40));
	db.prepare("UPDATE room_messages SET at = ?").run(daysAgo(40));
	db.prepare("UPDATE room_task_events SET at = ?").run(daysAgo(1));
	assert.deepEqual(log.expired(new Date(), 30), []);
});

test("deleting a room removes its tasks and history", () => {
	const { db, log } = board();
	log.delete(ROOM);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM room_tasks").get().n, 0);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM room_task_events").get().n, 0);
});

test("edits count toward the room's rate limit", () => {
	const { log } = board();
	for (let i = 0; i < 29; i++) {
		log.updateTask(ROOM, ALICE, 1, { action: "edit", priority: i % 2 ? "high" : "low", members: TEAM });
	}
	assert.throws(
		() => log.updateTask(ROOM, ALICE, 1, { action: "edit", priority: "normal", members: TEAM }),
		/Room limit/,
	);
	assert.throws(() => log.post(ROOM, BOB, "and messages too"), /Room limit/);
});

test("a task's history shows its last 50 steps and counts the rest", () => {
	const { db, log } = board();
	const now = new Date().toISOString();
	for (let seq = 2; seq <= 80; seq++) {
		db.prepare(
			"INSERT INTO room_task_events (room, number, seq, at, actor, action, detail) VALUES (?, 1, ?, ?, ?, 'edit', NULL)",
		).run(ROOM, seq, now, ALICE);
	}
	const { events, earlier } = log.getTask(ROOM, 1);
	assert.equal(events.length, 50);
	assert.equal(events[0].seq, 31);
	assert.equal(events.at(-1).seq, 80);
	assert.equal(earlier, 30);
});

// ---- Tasks that wait for other tasks ----

/** A room with tasks #1 and #2 by alice, and #3 by alice waiting for both. */
function waitingBoard() {
	const { db, log } = freshLog();
	log.open(ROOM);
	log.addTask(ROOM, ALICE, { title: "schema" });
	log.addTask(ROOM, ALICE, { title: "api" });
	log.addTask(ROOM, ALICE, { title: "client", waitsFor: [2, 1, 2] });

	return { db, log };
}

const finish = (log, number) => {
	log.updateTask(ROOM, BOB, number, { action: "claim" });
	log.updateTask(ROOM, BOB, number, { action: "done" });
	return log.updateTask(ROOM, ALICE, number, { action: "confirm", members: TEAM });
};

test("a task that waits for others shows as blocked until they are all confirmed", () => {
	const { log } = waitingBoard();
	const { task } = log.getTask(ROOM, 3);
	assert.deepEqual(task.waitsFor, [1, 2]);
	assert.equal(task.blocked, true);
	assert.equal(log.getTask(ROOM, 1).task.blocked, false);
	assert.deepEqual(log.getTask(ROOM, 1).task.waitsFor, []);

	finish(log, 1);
	assert.equal(log.getTask(ROOM, 3).task.blocked, true);
	// Done is not enough: the wait ends only when the task is confirmed.
	log.updateTask(ROOM, BOB, 2, { action: "claim" });
	log.updateTask(ROOM, BOB, 2, { action: "done" });
	assert.equal(log.listTasks(ROOM, false).find((t) => t.number === 3).blocked, true);
	log.updateTask(ROOM, ALICE, 2, { action: "confirm", members: TEAM });
	assert.equal(log.getTask(ROOM, 3).task.blocked, false);
});

test("a task can only wait for tasks on the same board", () => {
	const { log } = waitingBoard();
	const other = "core:" + "b".repeat(32);
	log.open(other);
	assert.throws(() => log.addTask(other, ALICE, { title: "x", waitsFor: [1] }), /No task #1 in this room/);
	assert.throws(() => log.addTask(ROOM, ALICE, { title: "x", waitsFor: [9] }), /No task #9 in this room/);
	assert.throws(
		() => log.updateTask(ROOM, ALICE, 1, { action: "edit", waitsFor: [9], members: TEAM }),
		/No task #9 in this room/,
	);
	assert.equal(log.listTasks(ROOM, true).length, 3);
	assert.deepEqual(log.getTask(ROOM, 1).task.waitsFor, []);
});

test("waiting loops are refused, including a task waiting for itself", () => {
	const { log } = waitingBoard();
	assert.throws(
		() => log.updateTask(ROOM, ALICE, 1, { action: "edit", waitsFor: [1], members: TEAM }),
		/can't wait for itself/,
	);
	// #3 waits for #1, so #1 waiting for #3 would be a loop.
	assert.throws(
		() => log.updateTask(ROOM, ALICE, 1, { action: "edit", waitsFor: [3], members: TEAM }),
		/would make a loop/,
	);
	// An indirect loop: #4 waits for #3, which waits for #1.
	log.addTask(ROOM, ALICE, { title: "release", waitsFor: [3] });
	assert.throws(
		() => log.updateTask(ROOM, ALICE, 1, { action: "edit", waitsFor: [4], members: TEAM }),
		/would make a loop/,
	);
	assert.deepEqual(log.getTask(ROOM, 1).task.waitsFor, []);
	// Waiting for a task that waits for something else is not a loop.
	log.updateTask(ROOM, ALICE, 2, { action: "edit", waitsFor: [1], members: TEAM });
	assert.deepEqual(log.getTask(ROOM, 2).task.waitsFor, [1]);
});

test("a task waits for at most 10 others", () => {
	const { log } = freshLog();
	log.open(ROOM);
	for (let i = 1; i <= 11; i++) {
		log.addTask(ROOM, ALICE, { title: `t${i}` });
	}
	const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
	assert.throws(() => log.addTask(ROOM, ALICE, { title: "x", waitsFor: eleven }), /at most 10/);
	log.addTask(ROOM, ALICE, { title: "ten", waitsFor: eleven.slice(0, 10) });
	assert.equal(log.getTask(ROOM, 12).task.waitsFor.length, 10);
});

test("a blocked task can be claimed early but not marked done", () => {
	const { log } = waitingBoard();
	const { task } = log.updateTask(ROOM, BOB, 3, { action: "claim" });
	assert.equal(task.status, "claimed");
	assert.equal(task.blocked, true);
	assert.throws(() => log.updateTask(ROOM, BOB, 3, { action: "done" }), /blocked: it waits for #1, #2/);
	assert.equal(log.getTask(ROOM, 3).task.status, "claimed");

	finish(log, 1);
	assert.throws(() => log.updateTask(ROOM, BOB, 3, { action: "done" }), /blocked: it waits for #2,/);
	finish(log, 2);
	assert.equal(log.updateTask(ROOM, BOB, 3, { action: "done" }).task.status, "done");
});

test("confirming the last task waited for posts an unblocked line", () => {
	const { log } = waitingBoard();
	log.addTask(ROOM, ALICE, { title: "docs", waitsFor: [2] });
	assert.deepEqual(
		finish(log, 1).messages.map((m) => m.text),
		["task #1 confirmed by alice-claude"],
	);

	const { messages } = finish(log, 2);
	assert.deepEqual(
		messages.map((m) => [m.sender, m.text]),
		[
			["[board]", "task #2 confirmed by alice-claude"],
			["[board]", "task #3 unblocked"],
			["[board]", "task #4 unblocked"],
		],
	);
	assert.deepEqual(
		boardLines(log).slice(-3),
		messages.map((m) => m.text),
	);
	assert.equal(log.getTask(ROOM, 3).events.at(-1).action, "unblocked");
});

test("an unblocked line is not posted for a task already confirmed or that waits for nothing unconfirmed", () => {
	const { log } = waitingBoard();
	finish(log, 1);
	// Clearing the waits unblocks #3 by edit, which posts nothing; confirming #2 later says nothing about #3.
	log.updateTask(ROOM, ALICE, 3, { action: "edit", waitsFor: [], members: TEAM });
	assert.equal(log.getTask(ROOM, 3).task.blocked, false);
	assert.deepEqual(finish(log, 2).messages.length, 1);
});

test("a confirm that would push its unblocked lines over the rate limit is refused and changes nothing", () => {
	const { log } = waitingBoard();
	log.addTask(ROOM, ALICE, { title: "docs", waitsFor: [1] });
	log.updateTask(ROOM, ALICE, 3, { action: "edit", waitsFor: [1], members: TEAM });
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	// 4 adds, claim, done and edit make 7; 22 more leave room for the confirm but not its two unblocked lines.
	for (let i = 0; i < 22; i++) {
		log.post(ROOM, BOB, `filler ${i}`);
	}
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "confirm", members: TEAM }), /Room limit/);
	assert.equal(log.getTask(ROOM, 1).task.status, "done");
	assert.equal(log.getTask(ROOM, 3).task.blocked, true);
});

test("what a task waits for can't change once it is marked done", () => {
	const { log } = waitingBoard();
	log.updateTask(ROOM, BOB, 1, { action: "claim" });
	log.updateTask(ROOM, BOB, 1, { action: "done" });
	assert.throws(() => log.updateTask(ROOM, ALICE, 1, { action: "edit", waitsFor: [2], members: TEAM }), /marked done/);
});

test("a room made before tasks could wait still loads, with tasks that wait for nothing", () => {
	const { db, log } = freshLog();
	log.open(ROOM);
	log.addTask(ROOM, ALICE, { title: "old task" });
	db.exec("DROP TABLE room_task_waits");

	const reopened = new RoomLog({ all: (query, ...params) => db.prepare(query).all(...params) });
	const [task] = reopened.listTasks(ROOM, true);
	assert.deepEqual(task.waitsFor, []);
	assert.equal(task.blocked, false);
	reopened.updateTask(ROOM, BOB, 1, { action: "claim" });
	assert.equal(reopened.updateTask(ROOM, BOB, 1, { action: "done" }).task.status, "done");
});

test("deleting a room removes what its tasks wait for", () => {
	const { db, log } = waitingBoard();
	log.delete(ROOM);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM room_task_waits").get().n, 0);
});

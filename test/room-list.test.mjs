/**
 * Unit tests of listing a team's rooms: the Node listing straight from the room log, and the
 * Cloudflare team index kept up to date by each room, both on Node's SQLite.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { listTeamRooms, roomKey, roomList } from "../src/core/app.ts";
import { RoomIndex } from "../src/core/room-index.ts";
import { RoomLog } from "../src/core/room-log.ts";

const DAY = 86_400_000;
const ALICE = "alice-claude";
const BOB = "bob-codex";
const TEAM = [ALICE, BOB];
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function sqlite() {
	const db = new DatabaseSync(":memory:");

	return { db, sql: { all: (query, ...params) => db.prepare(query).all(...params) } };
}

function freshLog() {
	const { db, sql } = sqlite();

	return { db, log: new RoomLog(sql) };
}

const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

/** What a Cloudflare Room does after each change: write its summary to the index, or remove itself once gone. */
function sync(log, index, key) {
	const id = key.split(":")[1];
	if (log.exists(key)) {
		index.put(id, log.summary(key));
	} else {
		index.remove(id);
	}
}

test("a team's list holds only its own rooms", () => {
	const { log } = freshLog();
	log.open(roomKey("core", A));
	log.open(roomKey("core", B));
	log.open(roomKey("other", C));
	log.open(roomKey("core-two", C));

	assert.deepEqual(
		listTeamRooms(log, "core", 30)
			.map((room) => room.id)
			.sort(),
		[A, B],
	);
	assert.deepEqual(
		listTeamRooms(log, "other", 30).map((room) => room.id),
		[C],
	);
	assert.deepEqual(listTeamRooms(log, "nobody", 30), []);
});

test("an entry has the room's times and latest seq, and a closed room shows when it closed", () => {
	const { log } = freshLog();
	const key = roomKey("core", A);
	log.open(key);
	log.post(key, ALICE, "hello");
	log.post(key, BOB, "hi");

	const [open] = listTeamRooms(log, "core", 30);
	assert.equal(open.id, A);
	assert.equal(open.closed, null);
	assert.equal(open.lastSeq, 2);
	assert.ok(open.opened <= open.lastActivity);

	const { closedAt } = log.close(key);
	const [closed] = listTeamRooms(log, "core", 30);
	assert.equal(closed.closed, closedAt);
	assert.equal(closed.lastActivity, closedAt);
});

test("an expired room is not listed, even before it is deleted", () => {
	const { db, log } = freshLog();
	log.open(roomKey("core", A));
	log.open(roomKey("core", B));
	db.prepare("UPDATE rooms SET opened_at = ? WHERE room = ?").run(
		new Date(Date.now() - 31 * DAY).toISOString(),
		roomKey("core", B),
	);

	assert.deepEqual(
		listTeamRooms(log, "core", 30).map((room) => room.id),
		[A],
	);
});

test("rooms are listed latest activity first", () => {
	const { db, log } = freshLog();
	log.open(roomKey("core", A));
	log.open(roomKey("core", B));
	db.prepare("UPDATE rooms SET opened_at = ? WHERE room = ?").run(
		new Date(Date.now() - DAY).toISOString(),
		roomKey("core", A),
	);
	db.prepare("UPDATE rooms SET opened_at = ? WHERE room = ?").run(
		new Date(Date.now() - 2 * DAY).toISOString(),
		roomKey("core", B),
	);
	log.post(roomKey("core", B), ALICE, "back again");

	assert.deepEqual(
		listTeamRooms(log, "core", 30).map((room) => room.id),
		[B, A],
	);
});

test("task counts match the board, and overdue is worked out on the day the list is read", () => {
	const { log } = freshLog();
	const key = roomKey("core", A);
	log.open(key);
	log.addTask(key, ALICE, { title: "overdue", due: day(-1) }); // #1 open, overdue
	log.addTask(key, ALICE, { title: "waits", waitsFor: [1] }); // #2 claimed, blocked
	log.updateTask(key, BOB, 2, { action: "claim" });
	log.addTask(key, ALICE, { title: "done late", due: day(-1) }); // #3 done: never overdue
	log.updateTask(key, BOB, 3, { action: "claim" });
	log.updateTask(key, BOB, 3, { action: "done" });
	log.addTask(key, ALICE, { title: "confirmed" }); // #4 confirmed
	log.updateTask(key, BOB, 4, { action: "claim" });
	log.updateTask(key, BOB, 4, { action: "done" });
	log.updateTask(key, ALICE, 4, { action: "confirm", members: TEAM });
	log.addTask(key, ALICE, { title: "due tomorrow", due: day(1) }); // #5 open, not overdue yet

	const [room] = listTeamRooms(log, "core", 30);
	assert.deepEqual(room.tasks, { open: 2, claimed: 1, done: 1, confirmed: 1, overdue: 1, blocked: 1 });

	// The same counts as the board itself.
	const today = new Date().toISOString().slice(0, 10);
	const tasks = log.listTasks(key, true);
	assert.equal(room.tasks.blocked, tasks.filter((task) => task.blocked).length);
	assert.equal(room.tasks.open, tasks.filter((task) => task.status === "open").length);
	assert.equal(
		room.tasks.overdue,
		tasks.filter((task) => task.due && task.due < today && ["open", "claimed"].includes(task.status)).length,
	);

	// Two days on, with nothing written since, #5 is overdue too.
	const later = new Date(Date.now() + 2 * DAY);
	const [stored] = roomList([{ id: A, summary: log.summary(key) }], 30, later);
	assert.equal(stored.tasks.overdue, 2);
});

test("the team index follows each room through open, post, task changes, close and expiry", () => {
	const { db, log } = freshLog();
	const index = new RoomIndex(sqlite().sql);
	const key = roomKey("core", A);
	const listed = () => roomList(index.entries(), 30);
	const fromLog = () => listTeamRooms(log, "core", 30);

	log.open(key);
	sync(log, index, key);
	assert.deepEqual(listed(), fromLog());
	assert.equal(listed()[0].lastSeq, 0);

	log.post(key, ALICE, "hello");
	sync(log, index, key);
	assert.equal(listed()[0].lastSeq, 1);

	log.addTask(key, ALICE, { title: "build it" });
	sync(log, index, key);
	assert.equal(listed()[0].tasks.open, 1);

	log.updateTask(key, BOB, 1, { action: "claim" });
	sync(log, index, key);
	assert.deepEqual(listed()[0].tasks, { open: 0, claimed: 1, done: 0, confirmed: 0, overdue: 0, blocked: 0 });
	assert.deepEqual(listed(), fromLog());

	log.close(key);
	sync(log, index, key);
	assert.notEqual(listed()[0].closed, null);
	assert.deepEqual(listed(), fromLog());

	// Expiry: the room's alarm deletes it, then removes it from the index.
	db.prepare("UPDATE rooms SET opened_at = ?, closed_at = ?").run(
		new Date(Date.now() - 40 * DAY).toISOString(),
		new Date(Date.now() - 31 * DAY).toISOString(),
	);
	db.prepare("UPDATE room_messages SET at = ?").run(new Date(Date.now() - 35 * DAY).toISOString());
	db.prepare("UPDATE room_task_events SET at = ?").run(new Date(Date.now() - 35 * DAY).toISOString());
	// Even before the alarm runs, the index no longer lists it.
	index.put(A, log.summary(key));
	assert.deepEqual(listed(), []);
	for (const room of log.expired(new Date(), 30)) {
		log.delete(room);
		sync(log, index, room);
	}
	assert.deepEqual(index.entries(), []);
});

test("a missed index update is repaired by the room's next write", () => {
	const index = new RoomIndex(sqlite().sql);
	const { log } = freshLog();
	const key = roomKey("core", A);
	log.open(key);
	sync(log, index, key);

	log.post(key, ALICE, "this update never reaches the index");
	assert.equal(roomList(index.entries(), 30)[0].lastSeq, 0);

	log.post(key, ALICE, "this one does");
	sync(log, index, key);
	assert.equal(roomList(index.entries(), 30)[0].lastSeq, 2);
});

test("the team index stores no message or task text", () => {
	const { db, sql } = sqlite();
	const index = new RoomIndex(sql);
	const { log } = freshLog();
	const key = roomKey("core", A);
	log.open(key);
	log.post(key, ALICE, "secret message");
	log.addTask(key, ALICE, { title: "secret title", doneWhen: "secret condition", due: day(3) });
	sync(log, index, key);

	const stored = JSON.stringify(db.prepare("SELECT * FROM team_rooms").all());
	assert.doesNotMatch(stored, /secret|alice/);
});

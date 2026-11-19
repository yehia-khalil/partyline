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
	at(daysAgo(40), null, null);
	assert.equal(log.expiresAt(ROOM, 30).toISOString(), new Date(Date.parse(daysAgo(40)) + 30 * DAY).toISOString());
	assert.deepEqual(log.expired(new Date(), 30), [ROOM]);

	// A recent message keeps it alive.
	at(daysAgo(40), daysAgo(10), null);
	assert.deepEqual(log.expired(new Date(), 30), []);
	assert.ok(log.expiresAt(ROOM, 30) > new Date());

	// Closing restarts the clock: a room quiet for 29 days and closed 5 days ago has 25 days left.
	at(daysAgo(40), daysAgo(29), daysAgo(5));
	assert.deepEqual(log.expired(new Date(), 30), []);
	assert.equal(log.expiresAt(ROOM, 30).toISOString(), new Date(Date.parse(daysAgo(5)) + 30 * DAY).toISOString());

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

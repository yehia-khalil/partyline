/**
 * A room's message log, written once against a minimal SQL interface so the same
 * logic runs on a Durable Object's SQLite and on Node's built-in SQLite.
 */

export type Message = { seq: number; at: string; sender: string; text: string };

export type SqlValue = string | number | null;

export interface Sql {
	/** Runs one statement and returns its rows (an empty array when it returns none). */
	all<Row>(query: string, ...params: SqlValue[]): Row[];
}

export const MAX_MESSAGES_PER_MINUTE = 30;
export const KEPT_MESSAGES = 1000;
export const MAX_TASKS = 200;
export const MAX_WAITS_FOR = 10;

/** The sender of the messages a room's board posts. Member names can't contain brackets, so no one can post as it. */
export const BOARD_SENDER = "[board]";

export type TaskStatus = "open" | "claimed" | "done" | "confirmed";
export type Priority = "low" | "normal" | "high";
export type Task = {
	number: number;
	title: string;
	doneWhen: string | null;
	priority: Priority;
	due: string | null;
	createdBy: string;
	holder: string | null;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
	/** The tasks this one waits for, by number. */
	waitsFor: number[];
	/** True while any task it waits for is not confirmed. A blocked task can be claimed, not marked done. */
	blocked: boolean;
};
export type TaskEvent = { seq: number; at: string; actor: string; action: string; detail: string | null };
export type NewTask = { title: string; doneWhen?: string; priority?: Priority; due?: string; waitsFor?: number[] };
export type TaskChange =
	| { action: "claim" }
	| { action: "release" }
	| { action: "done" }
	/**
	 * members: the team as it is now. The creator's steps (confirm, send_back, reclaim, edit) are open
	 * to every member once the creator is no longer one of them, and reclaim is refused while the
	 * holder still is.
	 */
	| { action: "confirm"; members: string[] }
	| { action: "hand_off"; to: string }
	| { action: "send_back"; reason: string; members: string[] }
	| { action: "reclaim"; members: string[] }
	/** waitsFor replaces the list of tasks this one waits for; [] clears it. */
	| { action: "edit"; priority?: Priority; due?: string | null; waitsFor?: number[]; members: string[] };

const TASK_COLUMNS = `number, title, done_when AS doneWhen, priority, due, created_by AS createdBy, holder, status,
	created_at AS createdAt, updated_at AS updatedAt`;

const DAY_MS = 86_400_000;

/**
 * A room's latest activity: the latest of when it opened, closed, got its last message, or had a task step.
 * Timestamps are all ISO strings in UTC, so they compare as text. MAX() returns NULL if any
 * argument is NULL, hence the empty-string fallbacks.
 */
const LAST_ACTIVITY = `MAX(
	r.opened_at,
	COALESCE(r.closed_at, ''),
	COALESCE((SELECT MAX(m.at) FROM room_messages m WHERE m.room = r.room), ''),
	COALESCE((SELECT MAX(e.at) FROM room_task_events e WHERE e.room = r.room), '')
)`;

export class RoomError extends Error {}

export class RoomLog {
	private readonly sql: Sql;

	constructor(sql: Sql) {
		this.sql = sql;
		this.sql.all("CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT)");
		// Databases made before rooms could be closed lack the column. Adding it is safe to roll
		// back from: older versions never read it.
		if (!this.sql.all<{ name: string }>("PRAGMA table_info(rooms)").some((column) => column.name === "closed_at")) {
			this.sql.all("ALTER TABLE rooms ADD COLUMN closed_at TEXT");
		}
		this.sql.all(
			`CREATE TABLE IF NOT EXISTS room_messages (
				room TEXT NOT NULL,
				seq INTEGER NOT NULL,
				at TEXT NOT NULL,
				sender TEXT NOT NULL,
				text TEXT NOT NULL,
				PRIMARY KEY (room, seq)
			)`,
		);
		this.sql.all(
			`CREATE TABLE IF NOT EXISTS room_tasks (
				room TEXT NOT NULL,
				number INTEGER NOT NULL,
				title TEXT NOT NULL,
				done_when TEXT,
				priority TEXT NOT NULL,
				due TEXT,
				created_by TEXT NOT NULL,
				holder TEXT,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (room, number)
			)`,
		);
		this.sql.all(
			`CREATE TABLE IF NOT EXISTS room_task_events (
				room TEXT NOT NULL,
				number INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				at TEXT NOT NULL,
				actor TEXT NOT NULL,
				action TEXT NOT NULL,
				detail TEXT,
				PRIMARY KEY (room, number, seq)
			)`,
		);
		// Which task waits for which. Rooms made before dependencies have no rows here, so their
		// tasks wait for nothing; older versions never read the table, so rolling back is safe.
		this.sql.all(
			`CREATE TABLE IF NOT EXISTS room_task_waits (
				room TEXT NOT NULL,
				number INTEGER NOT NULL,
				waits_for INTEGER NOT NULL,
				PRIMARY KEY (room, number, waits_for)
			)`,
		);
	}

	open(room: string): void {
		this.sql.all("INSERT OR IGNORE INTO rooms (room, opened_at) VALUES (?, ?)", room, new Date().toISOString());
	}

	exists(room: string): boolean {
		return this.sql.all("SELECT 1 FROM rooms WHERE room = ?", room).length > 0;
	}

	isClosed(room: string): boolean {
		this.assertExists(room);
		const [{ closed_at }] = this.sql.all<{ closed_at: string | null }>(
			"SELECT closed_at FROM rooms WHERE room = ?",
			room,
		);

		return closed_at !== null;
	}

	/** Closes a room for posting. Closing it again keeps the first close time. */
	close(room: string): { closedAt: string; alreadyClosed: boolean } {
		this.assertExists(room);
		const alreadyClosed = this.isClosed(room);
		this.sql.all("UPDATE rooms SET closed_at = COALESCE(closed_at, ?) WHERE room = ?", new Date().toISOString(), room);
		const [{ closed_at }] = this.sql.all<{ closed_at: string }>("SELECT closed_at FROM rooms WHERE room = ?", room);

		return { closedAt: closed_at, alreadyClosed };
	}

	/** When the room expires: `days` after its latest activity (opened, closed or last message). */
	expiresAt(room: string, days: number): Date {
		this.assertExists(room);
		const [{ last }] = this.sql.all<{ last: string }>(
			`SELECT ${LAST_ACTIVITY} AS last FROM rooms r WHERE r.room = ?`,
			room,
		);

		return new Date(Date.parse(last) + days * DAY_MS);
	}

	/** Every room whose expiry time (`days` after its latest activity) is `now` or earlier. */
	expired(now: Date, days: number): string[] {
		const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();

		return this.sql
			.all<{ room: string }>(`SELECT r.room FROM rooms r WHERE ${LAST_ACTIVITY} <= ?`, cutoff)
			.map((row) => row.room);
	}

	/** Every room in this log. A Cloudflare room object holds exactly one. */
	rooms(): string[] {
		return this.sql.all<{ room: string }>("SELECT room FROM rooms").map((row) => row.room);
	}

	/** Removes a room, its messages and its board. */
	delete(room: string): void {
		this.sql.all("DELETE FROM room_task_waits WHERE room = ?", room);
		this.sql.all("DELETE FROM room_task_events WHERE room = ?", room);
		this.sql.all("DELETE FROM room_tasks WHERE room = ?", room);
		this.sql.all("DELETE FROM room_messages WHERE room = ?", room);
		this.sql.all("DELETE FROM rooms WHERE room = ?", room);
	}

	post(room: string, sender: string, text: string): Message {
		if (this.isClosed(room)) {
			throw new RoomError("This room is closed. It can still be read, but no new messages can be posted.");
		}

		this.assertRate(room);

		const [message] = this.sql.all<Message>(
			`INSERT INTO room_messages (room, seq, at, sender, text)
			VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM room_messages WHERE room = ?), ?, ?, ?)
			RETURNING seq, at, sender, text`,
			room,
			room,
			new Date().toISOString(),
			sender,
			text,
		);
		this.sql.all("DELETE FROM room_messages WHERE room = ? AND seq <= ?", room, message.seq - KEPT_MESSAGES);

		return message;
	}

	/** The seq of the room's latest message, or 0 when it has none. */
	lastSeq(room: string): number {
		this.assertExists(room);
		const [{ seq }] = this.sql.all<{ seq: number }>(
			"SELECT COALESCE(MAX(seq), 0) AS seq FROM room_messages WHERE room = ?",
			room,
		);

		return seq;
	}

	read(room: string, since: number, limit: number): Message[] {
		this.assertExists(room);

		return this.sql.all<Message>(
			"SELECT seq, at, sender, text FROM room_messages WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?",
			room,
			since,
			limit,
		);
	}

	/** Puts a task on the room's board, open, and posts a board line saying so. */
	addTask(room: string, actor: string, task: NewTask): { task: Task; message: Message } {
		this.assertBoardWritable(room);
		const [{ count, next }] = this.sql.all<{ count: number; next: number }>(
			"SELECT COUNT(*) AS count, COALESCE(MAX(number), 0) + 1 AS next FROM room_tasks WHERE room = ?",
			room,
		);
		if (count >= MAX_TASKS) {
			throw new RoomError(`This room's board is full: a room holds at most ${MAX_TASKS} tasks.`);
		}
		const waitsFor = this.checkWaitsFor(room, next, task.waitsFor ?? []);

		const message = this.post(room, BOARD_SENDER, `task #${next} added by ${actor}`);
		this.sql.all(
			`INSERT INTO room_tasks (room, number, title, done_when, priority, due, created_by, holder, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?)`,
			room,
			next,
			task.title,
			task.doneWhen ?? null,
			task.priority ?? "normal",
			task.due ?? null,
			actor,
			message.at,
			message.at,
		);
		this.setWaitsFor(room, next, waitsFor);
		this.recordEvent(room, next, message.at, actor, "add", null);

		return { task: this.loadTask(room, next), message };
	}

	/**
	 * Applies one step to a task, if the actor may take it from the task's current status.
	 * Every step but edit posts a board line first, so a refused post (closed room, rate limit)
	 * leaves the task unchanged. A confirm also posts "task #n unblocked" for each task it was the
	 * last thing blocking; the room's rate limit is checked for all of those lines up front.
	 */
	updateTask(room: string, actor: string, number: number, change: TaskChange): { task: Task; messages: Message[] } {
		this.assertBoardWritable(room);
		const task = this.loadTask(room, number);
		const holderOnly = () => {
			if (task.status !== "claimed") {
				throw new RoomError(`Task #${number} is ${task.status}, not claimed.`);
			}
			if (task.holder !== actor) {
				throw new RoomError(`Only the holder of task #${number} (${task.holder}) can do that.`);
			}
		};
		// The creator's steps pass to the whole team once the creator has left it.
		const actsAsCreator = (members: string[]) => actor === task.createdBy || !members.includes(task.createdBy);
		const creatorOnly = (members: string[]) => {
			if (!actsAsCreator(members)) {
				throw new RoomError(`Only the creator of task #${number} (${task.createdBy}) can do that.`);
			}
		};
		const creatorOnDone = (members: string[]) => {
			creatorOnly(members);
			if (task.status !== "done") {
				throw new RoomError(`Task #${number} is not marked done yet.`);
			}
		};

		let next: { status: TaskStatus; holder: string | null };
		let line: string | null;
		let detail: string | null = null;
		let waitsFor: number[] | null = null;
		// Tasks this confirm unblocks: those still waiting whose only unconfirmed wait is this task.
		const unblocks = change.action === "confirm" ? this.unblockedByConfirming(room, number) : [];
		switch (change.action) {
			case "claim":
				if (task.status === "claimed") {
					throw new RoomError(`Task #${number} is already claimed by ${task.holder}.`);
				}
				if (task.status !== "open") {
					throw new RoomError(`Task #${number} is ${task.status}, not open.`);
				}
				next = { status: "claimed", holder: actor };
				line = `task #${number} claimed by ${actor}`;
				break;
			case "release":
				holderOnly();
				next = { status: "open", holder: null };
				line = `task #${number} released by ${actor}`;
				break;
			case "hand_off":
				holderOnly();
				if (change.to === actor) {
					throw new RoomError(`${actor} already holds task #${number}.`);
				}
				next = { status: "claimed", holder: change.to };
				line = `task #${number} handed to ${change.to} by ${actor}`;
				detail = change.to;
				break;
			case "done":
				holderOnly();
				if (task.blocked) {
					const pending = this.unconfirmedWaits(room, number).map((n) => `#${n}`);
					throw new RoomError(
						`Task #${number} is blocked: it waits for ${pending.join(", ")}, not confirmed yet. It can be marked done once they are.`,
					);
				}
				next = { status: "done", holder: actor };
				line = `task #${number} marked done by ${actor}`;
				break;
			case "confirm":
				creatorOnDone(change.members);
				next = { status: "confirmed", holder: task.holder };
				line = `task #${number} confirmed by ${actor}`;
				break;
			case "send_back":
				creatorOnDone(change.members);
				next = { status: "claimed", holder: task.holder };
				line = `task #${number} sent back to ${task.holder} by ${actor}`;
				detail = change.reason;
				break;
			case "reclaim":
				if (task.status !== "claimed") {
					throw new RoomError(`Task #${number} is ${task.status}, not claimed.`);
				}
				creatorOnly(change.members);
				if (task.holder !== null && change.members.includes(task.holder)) {
					throw new RoomError(
						`${task.holder} is still on the team: only they can release or hand off task #${number}.`,
					);
				}
				next = { status: "open", holder: null };
				line = `task #${number} reclaimed by ${actor} from ${task.holder}`;
				detail = task.holder;
				break;
			case "edit":
				if (task.status === "confirmed") {
					throw new RoomError(`Task #${number} is confirmed and can no longer be changed.`);
				}
				if (actor !== task.holder && !actsAsCreator(change.members)) {
					throw new RoomError(`Only the creator or the holder of task #${number} can change it.`);
				}
				if (change.waitsFor !== undefined) {
					if (task.status === "done") {
						throw new RoomError(`Task #${number} is marked done, so what it waits for can no longer change.`);
					}
					waitsFor = this.checkWaitsFor(room, number, change.waitsFor);
				}
				next = { status: task.status, holder: task.holder };
				line = null;
				break;
		}

		this.assertRate(room, 1 + unblocks.length);
		const message = line === null ? null : this.post(room, BOARD_SENDER, line);
		const at = message?.at ?? new Date().toISOString();
		const priority = change.action === "edit" && change.priority !== undefined ? change.priority : task.priority;
		const due = change.action === "edit" && change.due !== undefined ? change.due : task.due;
		this.sql.all(
			"UPDATE room_tasks SET status = ?, holder = ?, priority = ?, due = ?, updated_at = ? WHERE room = ? AND number = ?",
			next.status,
			next.holder,
			priority,
			due,
			at,
			room,
			number,
		);
		if (waitsFor !== null) {
			this.setWaitsFor(room, number, waitsFor);
		}
		this.recordEvent(room, number, at, actor, change.action, detail);

		const messages = message === null ? [] : [message];
		for (const unblocked of unblocks) {
			const line = this.post(room, BOARD_SENDER, `task #${unblocked} unblocked`);
			this.recordEvent(room, unblocked, line.at, actor, "unblocked", `#${number} confirmed`);
			messages.push(line);
		}

		return { task: this.loadTask(room, number), messages };
	}

	/** The board: open, claimed, done, then (if asked) confirmed; each by priority, high first, then number. */
	listTasks(room: string, includeConfirmed: boolean): Task[] {
		this.assertExists(room);

		const tasks = this.sql.all<Task>(
			`SELECT ${TASK_COLUMNS} FROM room_tasks WHERE room = ? ${includeConfirmed ? "" : "AND status != 'confirmed'"}
			ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
				CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
				number`,
			room,
		);

		return this.withWaits(room, tasks);
	}

	/** One task and its last `limit` steps, oldest first, with how many earlier steps are not included. */
	getTask(room: string, number: number, limit = 50): { task: Task; events: TaskEvent[]; earlier: number } {
		this.assertExists(room);
		const task = this.loadTask(room, number);
		const events = this.sql
			.all<TaskEvent>(
				"SELECT seq, at, actor, action, detail FROM room_task_events WHERE room = ? AND number = ? ORDER BY seq DESC LIMIT ?",
				room,
				number,
				limit,
			)
			.reverse();
		const [{ total }] = this.sql.all<{ total: number }>(
			"SELECT COUNT(*) AS total FROM room_task_events WHERE room = ? AND number = ?",
			room,
			number,
		);

		return { task, events, earlier: total - events.length };
	}

	private loadTask(room: string, number: number): Task {
		const [task] = this.sql.all<Task>(
			`SELECT ${TASK_COLUMNS} FROM room_tasks WHERE room = ? AND number = ?`,
			room,
			number,
		);
		if (!task) {
			throw new RoomError(`No task #${number} in this room.`);
		}

		return this.withWaits(room, [task])[0];
	}

	/** Fills in waitsFor and blocked, reading the room's waits once. */
	private withWaits(room: string, tasks: Task[]): Task[] {
		const rows = this.sql.all<{ number: number; waitsFor: number; status: TaskStatus }>(
			`SELECT w.number, w.waits_for AS waitsFor, t.status FROM room_task_waits w
			JOIN room_tasks t ON t.room = w.room AND t.number = w.waits_for
			WHERE w.room = ? ORDER BY w.number, w.waits_for`,
			room,
		);
		for (const task of tasks) {
			const waits = rows.filter((row) => row.number === task.number);
			task.waitsFor = waits.map((row) => row.waitsFor);
			task.blocked = waits.some((row) => row.status !== "confirmed");
		}

		return tasks;
	}

	/** The numbers of the tasks a task waits for that are not confirmed yet. */
	private unconfirmedWaits(room: string, number: number): number[] {
		return this.sql
			.all<{ waitsFor: number }>(
				`SELECT w.waits_for AS waitsFor FROM room_task_waits w
				JOIN room_tasks t ON t.room = w.room AND t.number = w.waits_for
				WHERE w.room = ? AND w.number = ? AND t.status != 'confirmed' ORDER BY w.waits_for`,
				room,
				number,
			)
			.map((row) => row.waitsFor);
	}

	/** The tasks that wait for `number` and for nothing else unconfirmed, so confirming it unblocks them. */
	private unblockedByConfirming(room: string, number: number): number[] {
		return this.sql
			.all<{ number: number }>(
				`SELECT w.number FROM room_task_waits w
				JOIN room_tasks t ON t.room = w.room AND t.number = w.number
				WHERE w.room = ? AND w.waits_for = ? AND t.status != 'confirmed'
				AND NOT EXISTS (
					SELECT 1 FROM room_task_waits o JOIN room_tasks ot ON ot.room = o.room AND ot.number = o.waits_for
					WHERE o.room = w.room AND o.number = w.number AND o.waits_for != ? AND ot.status != 'confirmed'
				)
				ORDER BY w.number`,
				room,
				number,
				number,
			)
			.map((row) => row.number);
	}

	/**
	 * Checks a list of tasks for `number` to wait for: at most MAX_WAITS_FOR, each one on this
	 * room's board, none of them the task itself, and none that already waits (directly or not)
	 * for this task, which would make a loop. Returns the list without repeats.
	 */
	private checkWaitsFor(room: string, number: number, waitsFor: number[]): number[] {
		const unique = [...new Set(waitsFor)].sort((a, b) => a - b);
		if (unique.length > MAX_WAITS_FOR) {
			throw new RoomError(`A task can wait for at most ${MAX_WAITS_FOR} other tasks.`);
		}
		const edges = this.sql.all<{ number: number; waitsFor: number }>(
			"SELECT number, waits_for AS waitsFor FROM room_task_waits WHERE room = ? AND number != ?",
			room,
			number,
		);
		for (const other of unique) {
			if (this.sql.all("SELECT 1 FROM room_tasks WHERE room = ? AND number = ?", room, other).length === 0) {
				throw new RoomError(`No task #${other} in this room: a task can only wait for tasks on the same board.`);
			}
			if (other === number) {
				throw new RoomError(`Task #${number} can't wait for itself.`);
			}
			// Walk what `other` waits for; reaching `number` means the new wait closes a loop.
			const seen = new Set<number>();
			const stack = [other];
			while (stack.length > 0) {
				const at = stack.pop()!;
				if (at === number) {
					throw new RoomError(
						`Task #${number} can't wait for #${other}: that would make a loop, as #${other} already waits for #${number}.`,
					);
				}
				if (!seen.has(at)) {
					seen.add(at);
					stack.push(...edges.filter((edge) => edge.number === at).map((edge) => edge.waitsFor));
				}
			}
		}

		return unique;
	}

	private setWaitsFor(room: string, number: number, waitsFor: number[]): void {
		this.sql.all("DELETE FROM room_task_waits WHERE room = ? AND number = ?", room, number);
		for (const other of waitsFor) {
			this.sql.all("INSERT INTO room_task_waits (room, number, waits_for) VALUES (?, ?, ?)", room, number, other);
		}
	}

	private recordEvent(
		room: string,
		number: number,
		at: string,
		actor: string,
		action: string,
		detail: string | null,
	): void {
		this.sql.all(
			`INSERT INTO room_task_events (room, number, seq, at, actor, action, detail)
			VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM room_task_events WHERE room = ? AND number = ?), ?, ?, ?, ?)`,
			room,
			number,
			room,
			number,
			at,
			actor,
			action,
			detail,
		);
	}

	/**
	 * Refuses when `count` more messages or edits would go over the room's per-minute limit.
	 * Messages (board lines included) and task edits share it.
	 */
	private assertRate(room: string, count = 1): void {
		const minuteAgo = new Date(Date.now() - 60_000).toISOString();
		const [{ n }] = this.sql.all<{ n: number }>(
			`SELECT (SELECT COUNT(*) FROM room_messages WHERE room = ? AND at > ?)
				+ (SELECT COUNT(*) FROM room_task_events WHERE room = ? AND action = 'edit' AND at > ?) AS n`,
			room,
			minuteAgo,
			room,
			minuteAgo,
		);
		if (n + count > MAX_MESSAGES_PER_MINUTE) {
			throw new RoomError(
				`Room limit reached: ${MAX_MESSAGES_PER_MINUTE} messages a minute. Wait, and check with your operator before continuing.`,
			);
		}
	}

	private assertBoardWritable(room: string): void {
		if (this.isClosed(room)) {
			throw new RoomError("This room is closed. Its board can still be read, but not changed.");
		}
	}

	private assertExists(room: string): void {
		if (!this.exists(room)) {
			throw new RoomError("No such room.");
		}
	}
}

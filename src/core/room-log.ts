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

const DAY_MS = 86_400_000;

/**
 * A room's latest activity: the later of when it opened, closed, or got its last message.
 * Timestamps are all ISO strings in UTC, so they compare as text. MAX() returns NULL if any
 * argument is NULL, hence the empty-string fallbacks.
 */
const LAST_ACTIVITY = `MAX(
	r.opened_at,
	COALESCE(r.closed_at, ''),
	COALESCE((SELECT MAX(m.at) FROM room_messages m WHERE m.room = r.room), '')
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

	/** Removes a room and all its messages. */
	delete(room: string): void {
		this.sql.all("DELETE FROM room_messages WHERE room = ?", room);
		this.sql.all("DELETE FROM rooms WHERE room = ?", room);
	}

	post(room: string, sender: string, text: string): Message {
		if (this.isClosed(room)) {
			throw new RoomError("This room is closed. It can still be read, but no new messages can be posted.");
		}

		const minuteAgo = new Date(Date.now() - 60_000).toISOString();
		const [{ n }] = this.sql.all<{ n: number }>(
			"SELECT COUNT(*) AS n FROM room_messages WHERE room = ? AND at > ?",
			room,
			minuteAgo,
		);
		if (n >= MAX_MESSAGES_PER_MINUTE) {
			throw new RoomError(
				`Room limit reached: ${MAX_MESSAGES_PER_MINUTE} messages a minute. Wait, and check with your operator before continuing.`,
			);
		}

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

	private assertExists(room: string): void {
		if (!this.exists(room)) {
			throw new RoomError("No such room.");
		}
	}
}

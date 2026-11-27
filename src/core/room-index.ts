/**
 * A team's list of rooms, for a host that cannot enumerate them (Cloudflare keeps each room in
 * its own Durable Object). Each room writes its whole summary on every change, so a missed write
 * is repaired by the next one. It holds room ids, times, seqs and task counts, never message or
 * task text.
 */
import type { RoomSummary, Sql } from "./room-log.ts";

export class RoomIndex {
	private readonly sql: Sql;

	constructor(sql: Sql) {
		this.sql = sql;
		this.sql.all("CREATE TABLE IF NOT EXISTS team_rooms (id TEXT PRIMARY KEY, summary TEXT NOT NULL)");
	}

	/** Records a room's latest summary, replacing whatever was there. */
	put(id: string, summary: RoomSummary): void {
		const { opened, closed, lastActivity, lastSeq, counts, dues } = summary;
		this.sql.all(
			"INSERT INTO team_rooms (id, summary) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary",
			id,
			JSON.stringify({ opened, closed, lastActivity, lastSeq, counts, dues }),
		);
	}

	remove(id: string): void {
		this.sql.all("DELETE FROM team_rooms WHERE id = ?", id);
	}

	entries(): { id: string; summary: RoomSummary }[] {
		return this.sql
			.all<{ id: string; summary: string }>("SELECT id, summary FROM team_rooms")
			.map((row) => ({ id: row.id, summary: JSON.parse(row.summary) as RoomSummary }));
	}
}

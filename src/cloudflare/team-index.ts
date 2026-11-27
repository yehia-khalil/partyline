import { DurableObject } from "cloudflare:workers";
import { parseExpiryDays, type RoomEntry, roomList } from "../core/app.ts";
import { RoomIndex } from "../core/room-index.ts";
import type { RoomSummary } from "../core/room-log.ts";

/**
 * One team's room list on Cloudflare, named by the team. Each Room writes its summary here when
 * it opens, gets a message or a task change, or closes, and removes itself when it expires.
 * Rooms made before the index existed join it the next time they are used.
 */
export class TeamIndex extends DurableObject<Env> {
	private readonly index: RoomIndex;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.index = new RoomIndex({
			all: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray() as never,
		});
	}

	async put(roomId: string, summary: RoomSummary): Promise<void> {
		this.index.put(roomId, summary);
	}

	async remove(roomId: string): Promise<void> {
		this.index.remove(roomId);
	}

	async list(): Promise<RoomEntry[]> {
		return roomList(this.index.entries(), parseExpiryDays(this.env.ROOM_EXPIRY_DAYS));
	}
}

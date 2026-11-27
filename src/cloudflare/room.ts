import { DurableObject } from "cloudflare:workers";
import { formatCatchUp, formatClosed, formatPush, matchSocketPath, parseExpiryDays } from "../core/app.ts";
import { type Message, type NewTask, RoomLog, type Task, type TaskChange, type TaskEvent } from "../core/room-log.ts";

/**
 * One room on Cloudflare. A single instance runs per team and room ID, so every message
 * lands here in order and is pushed to every open WebSocket. Its alarm is kept at the
 * room's expiry time (ROOM_EXPIRY_DAYS after its latest activity), when it deletes the room.
 */
export class Room extends DurableObject<Env> {
	private readonly log: RoomLog;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.log = new RoomLog({
			all: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray() as never,
		});
	}

	/** The object's name is the room key, "<team>:<room id>". */
	private get key(): string {
		return this.ctx.id.name ?? "";
	}

	private get roomId(): string {
		return this.key.split(":").at(-1) ?? "";
	}

	private get expiryDays(): number {
		return parseExpiryDays(this.env.ROOM_EXPIRY_DAYS);
	}

	/** Moves the alarm to the room's expiry time. Called whenever its latest activity changes. */
	private async scheduleExpiry(): Promise<void> {
		await this.ctx.storage.setAlarm(this.log.expiresAt(this.key, this.expiryDays).getTime());
	}

	/** Rooms made before expiry existed have no alarm: any room that is used gets one. */
	private async ensureExpiry(): Promise<void> {
		if (this.log.exists(this.key) && (await this.ctx.storage.getAlarm()) === null) {
			await this.scheduleExpiry();
		}
	}

	private send(frame: string): void {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(frame);
			} catch {
				// A socket that has gone away is cleaned up by the runtime.
			}
		}
	}

	private endStreams(reason: string): void {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.close(1000, reason);
			} catch {
				// Already closed.
			}
		}
	}

	async open(): Promise<void> {
		this.log.open(this.key);
		await this.scheduleExpiry();
	}

	async post(sender: string, text: string): Promise<Message> {
		const message = this.log.post(this.key, sender, text);
		this.send(formatPush(this.roomId, message));
		await this.scheduleExpiry();

		return message;
	}

	async read(since: number, limit: number): Promise<Message[]> {
		await this.ensureExpiry();

		return this.log.read(this.key, since, limit);
	}

	async lastSeq(): Promise<number> {
		await this.ensureExpiry();

		return this.log.lastSeq(this.key);
	}

	async isClosed(): Promise<boolean> {
		await this.ensureExpiry();

		return this.log.isClosed(this.key);
	}

	async addTask(actor: string, task: NewTask): Promise<Task> {
		const added = this.log.addTask(this.key, actor, task);
		this.send(formatPush(this.roomId, added.message));
		await this.scheduleExpiry();

		return added.task;
	}

	async updateTask(actor: string, number: number, change: TaskChange): Promise<Task> {
		const { task, messages } = this.log.updateTask(this.key, actor, number, change);
		for (const message of messages) {
			this.send(formatPush(this.roomId, message));
		}
		await this.scheduleExpiry();

		return task;
	}

	async listTasks(includeConfirmed: boolean): Promise<Task[]> {
		await this.ensureExpiry();

		return this.log.listTasks(this.key, includeConfirmed);
	}

	async getTask(number: number): Promise<{ task: Task; events: TaskEvent[]; earlier: number }> {
		await this.ensureExpiry();

		return this.log.getTask(this.key, number);
	}

	/** Named closeRoom, not close, to stay clear of any name the runtime gives special meaning. */
	async closeRoom(): Promise<{ expiresAt: string; alreadyClosed: boolean }> {
		const { alreadyClosed } = this.log.close(this.key);
		this.send(formatClosed(this.roomId));
		this.endStreams("room closed");
		await this.scheduleExpiry();

		return { expiresAt: this.log.expiresAt(this.key, this.expiryDays).toISOString(), alreadyClosed };
	}

	/**
	 * Deletes the room once it has expired, or moves the alarm if activity pushed expiry later.
	 * Reads the room from its own database rather than the object's name, which an alarm may not have.
	 */
	async alarm(): Promise<void> {
		const days = this.expiryDays;
		for (const room of this.log.expired(new Date(), days)) {
			this.endStreams("room expired");
			this.log.delete(room);
		}
		const next = this.log.rooms().map((room) => this.log.expiresAt(room, days).getTime());
		if (next.length > 0) {
			await this.ctx.storage.setAlarm(Math.min(...next));
		}
	}

	/** Accepts a read-only WebSocket that receives every new message, after a catch-up notice for any it missed. */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		}
		if (!this.log.exists(this.key)) {
			return new Response("No such room.", { status: 404 });
		}
		if (this.log.isClosed(this.key)) {
			return new Response("This room is closed.", { status: 410 });
		}
		await this.ensureExpiry();

		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		const since = matchSocketPath(new URL(request.url))?.since ?? null;
		const catchUp = formatCatchUp(this.roomId, since, this.log.lastSeq(this.key));
		if (catchUp) {
			server.send(catchUp);
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(): Promise<void> {
		// The stream is read-only: agents post through the MCP tools.
	}

	async webSocketClose(socket: WebSocket, code: number): Promise<void> {
		socket.close(code === 1005 ? 1000 : code, "closed");
	}
}

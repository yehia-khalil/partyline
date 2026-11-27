import { handleRequest, matchSocketPath, parseExpiryDays, type Rooms, roomKey } from "../core/app.ts";
import type { WebAssets } from "../core/web.ts";
import type { Room } from "./room.ts";
// Bundled as text by the rules in wrangler.jsonc.
import html from "../web/index.html";
import css from "../web/app.css";
import script from "../web/app.js";

const assets: WebAssets = { html, css, script };

export { Room } from "./room.ts";
export { TeamIndex } from "./team-index.ts";

function room(env: Env, team: string, roomId: string): DurableObjectStub<Room> {
	return env.ROOM.get(env.ROOM.idFromName(roomKey(team, roomId)));
}

function roomsOn(env: Env): Rooms {
	return {
		open: (team, roomId) => room(env, team, roomId).open(),
		post: (team, roomId, sender, text) => room(env, team, roomId).post(sender, text),
		read: (team, roomId, since, limit) => room(env, team, roomId).read(since, limit),
		lastSeq: (team, roomId) => room(env, team, roomId).lastSeq(),
		close: (team, roomId) => room(env, team, roomId).closeRoom(),
		isClosed: (team, roomId) => room(env, team, roomId).isClosed(),
		addTask: (team, roomId, actor, task) => room(env, team, roomId).addTask(actor, task),
		updateTask: (team, roomId, actor, number, change) => room(env, team, roomId).updateTask(actor, number, change),
		listTasks: (team, roomId, includeConfirmed) => room(env, team, roomId).listTasks(includeConfirmed),
		getTask: (team, roomId, number) => room(env, team, roomId).getTask(number),
		describeRoom: (team, roomId) => room(env, team, roomId).describe(),
		listRooms: (team) => env.TEAM_INDEX.get(env.TEAM_INDEX.idFromName(team)).list(),
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// A bad ROOM_EXPIRY_DAYS fails closed, like a bad TEAMS: every call is refused and logged.
		try {
			parseExpiryDays(env.ROOM_EXPIRY_DAYS);
		} catch (error) {
			console.error(`partyline: ${(error as Error).message}`);
			return new Response("Server misconfigured", { status: 500 });
		}

		// The room ID is the read capability: 128 random bits, shared only with the team.
		const socket = matchSocketPath(url);
		if (socket) {
			return room(env, socket.team, socket.roomId).fetch(request);
		}

		return (
			(await handleRequest(request, roomsOn(env), env.TEAMS, url.origin, assets)) ??
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;

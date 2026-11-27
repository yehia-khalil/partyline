/**
 * The people API, version 1: read-only JSON for viewers (people, not agents), documented in
 * docs/reference.md. Every route needs a viewer token; a member token is refused, so an agent's
 * token never has to reach a browser. Another team's room, like a missing one, answers 404.
 */
import { identify, type Credential, type Rooms } from "./app.ts";
import { isOverdue, type Task } from "./room-log.ts";

export const API_VERSION = 1;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;

const ROUTE = /^\/api\/t\/([a-z0-9-]{1,32})\/rooms(?:\/([0-9a-f]{32})(?:\/(messages|tasks)(?:\/([1-9]\d{0,8}))?)?)?$/;

const HEADERS = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};

/** A JSON reply. Text fields are plain JSON strings, never HTML. */
function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

export function apiError(status: number, error: string, extra: Record<string, string> = {}): Response {
	return json({ error }, status, extra);
}

const notFound = () => apiError(404, "No such room.");

/** A whole number from min to max written in digits, the default when absent, or null when malformed. */
function wholeNumber(value: string | null, fallback: number, min: number, max: number): number | null {
	if (value === null) {
		return fallback;
	}
	const number = /^\d{1,15}$/.test(value) ? Number(value) : NaN;

	return number >= min && number <= max ? number : null;
}

function withOverdue(task: Task, today: string): Task & { overdue: boolean } {
	return { ...task, overdue: isOverdue(task, today) };
}

export async function handleApi(
	request: Request,
	url: URL,
	rooms: Rooms,
	credentials: Credential[],
): Promise<Response> {
	const caller = await identify(request, credentials);
	if (!caller) {
		return apiError(401, "A viewer token is required.");
	}
	if (caller.role !== "viewer") {
		return apiError(403, "Member tokens can't use the people API, which takes viewer tokens.");
	}
	if (request.method !== "GET") {
		return apiError(405, "The people API is read-only: use GET.", { Allow: "GET" });
	}
	if (url.pathname === "/api") {
		return json({ version: API_VERSION });
	}

	const match = url.pathname.match(ROUTE);
	if (!match) {
		return apiError(404, "No such endpoint.");
	}
	const [, team, roomId, part, number] = match;
	// Another team's rooms are as unknown to this viewer as rooms that don't exist.
	if (team !== caller.team) {
		return notFound();
	}
	if (roomId === undefined) {
		return json({ rooms: await rooms.listRooms(team) });
	}

	const room = await rooms.describeRoom(team, roomId);
	if (!room) {
		return notFound();
	}
	const today = new Date().toISOString().slice(0, 10);

	if (part === undefined) {
		const ownerOf = (name: string) =>
			credentials.find((c) => c.team === team && c.role === "member" && c.name === name)?.owner ?? null;
		const participants = room.participants.map(({ name, firstSeen, lastSeen }) => ({
			name,
			owner: ownerOf(name),
			firstSeen,
			lastSeen,
		}));

		return json({ room: { ...room, participants } });
	}

	if (part === "messages") {
		const since = wholeNumber(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = wholeNumber(url.searchParams.get("limit"), DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
		if (since === null || limit === null) {
			return apiError(400, `since is a seq (0 or more) and limit a number from 1 to ${MAX_MESSAGE_LIMIT}.`);
		}
		const read = await rooms.read(team, roomId, since, limit + 1);

		return json({ messages: read.slice(0, limit), more: read.length > limit, closed: room.closed !== null });
	}

	if (number === undefined) {
		const include = url.searchParams.get("include_confirmed");
		if (include !== null && include !== "true" && include !== "false") {
			return apiError(400, "include_confirmed is true or false.");
		}
		const tasks = await rooms.listTasks(team, roomId, include === "true");

		return json({ tasks: tasks.map((task) => withOverdue(task, today)) });
	}

	// The room is known to exist, so a task missing from its whole board is the only 404 left.
	const board = await rooms.listTasks(team, roomId, true);
	if (!board.some((task) => task.number === Number(number))) {
		return apiError(404, "No such task.");
	}
	const { task, events, earlier } = await rooms.getTask(team, roomId, Number(number));

	return json({ task: withOverdue(task, today), events, earlier });
}

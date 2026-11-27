// The people API v1 as the page reads it, and where the viewer's token is kept.
// The token lives in this tab's sessionStorage only: never the URL, a cookie or localStorage.

export type Viewer = { team: string; token: string };

export type TaskCounts = Partial<Record<"open" | "claimed" | "done" | "confirmed" | "overdue" | "blocked", number>>;
export type RoomSummary = {
	id: string;
	closed: string | null;
	lastActivity: string;
	lastSeq: number;
	tasks?: TaskCounts;
};
export type Participant = { name: string; owner: string | null; lastSeen: string };
export type RoomDetail = {
	opened: string;
	closed: string | null;
	lastActivity: string;
	lastSeq: number;
	connectedCount: number;
	participants: Participant[];
};
export type Task = {
	number: number;
	title: string;
	doneWhen: string | null;
	priority: "low" | "normal" | "high";
	due: string | null;
	createdBy: string;
	holder: string | null;
	status: "open" | "claimed" | "done" | "confirmed";
	waitsFor: number[];
	blocked: boolean;
	overdue: boolean;
};
export type Message = { seq: number; sender: string; at: string; text: string };
export type MessagePage = { messages: Message[]; more: boolean };

const STORE_KEY = "partyline.viewer";
export const TEAM = /^[a-z0-9-]{1,32}$/;
export const ROOM_ID = /^[0-9a-f]{32}$/;

export function loadViewer(): Viewer | null {
	try {
		const viewer = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null");
		return viewer && TEAM.test(viewer.team) && typeof viewer.token === "string" ? viewer : null;
	} catch {
		return null;
	}
}

export function saveViewer(viewer: Viewer): void {
	try {
		sessionStorage.setItem(STORE_KEY, JSON.stringify(viewer));
	} catch {
		// Storage refused (private mode): the token lives in memory until the tab closes.
	}
}

export function clearViewer(): void {
	try {
		sessionStorage.removeItem(STORE_KEY);
	} catch {
		// Nothing stored.
	}
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** True when the server no longer takes this token, so the page must sign out. */
export const isRefused = (error: unknown) =>
	error instanceof ApiError && (error.status === 401 || error.status === 403);

export async function api<T>(viewer: Viewer, path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { Authorization: `Bearer ${viewer.token}`, Accept: "application/json" },
		cache: "no-store",
		credentials: "omit",
		referrerPolicy: "no-referrer",
	});
	let body: { error?: string } | null = null;
	try {
		body = await response.json();
	} catch {
		// Not JSON: the status says enough.
	}
	if (!response.ok) {
		throw new ApiError(response.status, body?.error ?? `HTTP ${response.status}`);
	}

	return body as T;
}

export const roomsPath = (viewer: Viewer) => `/api/t/${viewer.team}/rooms`;

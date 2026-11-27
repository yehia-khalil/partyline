// The Partyline people's page: a read-only view of a team's rooms over the people API v1.
// Room text is written by other people's agents, so it only ever reaches the page as text nodes
// (textContent, or strings passed to append), never as HTML.
"use strict";

const STORE_KEY = "partyline.viewer";
const POLL_MS = 10_000;
const PAGE = 50;
const TEAM = /^[a-z0-9-]{1,32}$/;
const ROOM_ID = /^[0-9a-f]{32}$/;
const COLUMNS = ["open", "claimed", "done", "confirmed"];

const $ = (id) => document.getElementById(id);

const present = (children) => children.filter((child) => child !== null && child !== undefined && child !== false);

/** Builds an element. Children are nodes or strings, and strings become text nodes. */
function el(tag, className, ...children) {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	node.append(...present(children));

	return node;
}

// The token lives in this tab's sessionStorage only: never the URL, a cookie or localStorage.
function loadViewer() {
	try {
		const viewer = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null");
		return viewer && TEAM.test(viewer.team) && typeof viewer.token === "string" ? viewer : null;
	} catch {
		return null;
	}
}

function saveViewer(viewer) {
	try {
		sessionStorage.setItem(STORE_KEY, JSON.stringify(viewer));
	} catch {
		// Storage refused (private mode): the token lives in memory until the tab closes.
	}
}

function clearViewer() {
	try {
		sessionStorage.removeItem(STORE_KEY);
	} catch {
		// Nothing stored.
	}
}

let viewer = loadViewer();

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

async function api(path) {
	const response = await fetch(path, {
		headers: { Authorization: `Bearer ${viewer.token}`, Accept: "application/json" },
		cache: "no-store",
		credentials: "omit",
		referrerPolicy: "no-referrer",
	});
	let body = null;
	try {
		body = await response.json();
	} catch {
		// Not JSON: the status says enough.
	}
	if (!response.ok) {
		throw new ApiError(response.status, body?.error ?? `HTTP ${response.status}`);
	}

	return body;
}

const teamPath = () => `/api/t/${viewer.team}/rooms`;

function when(iso) {
	if (!iso) {
		return "";
	}
	const date = new Date(iso);

	return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

function timeEl(iso) {
	const node = el("time", null, when(iso));
	node.dateTime = String(iso ?? "");

	return node;
}

function badge(text, kind) {
	return el("span", `badge ${kind}`, text);
}

// ---- Sign in and out ------------------------------------------------------------------------

function showSignedOut(message = "") {
	stopPolling();
	viewer = null;
	$("who").textContent = "";
	$("sign-out").hidden = true;
	$("view").replaceChildren();
	$("sign-in").hidden = false;
	$("sign-in-error").textContent = message;
}

function signOut(message = "") {
	clearViewer();
	$("sign-in").reset();
	showSignedOut(message);
}

async function signIn(event) {
	event.preventDefault();
	const form = event.currentTarget;
	const team = form.elements.team.value.trim();
	const token = form.elements.token.value.trim();
	if (!TEAM.test(team)) {
		$("sign-in-error").textContent = "A team name is a-z, 0-9 or dash, up to 32 characters.";
		return;
	}
	viewer = { team, token };
	try {
		await api(teamPath());
	} catch (error) {
		viewer = null;
		$("sign-in-error").textContent =
			error.status === 401
				? "That token isn't known here."
				: error.status === 403
					? "That is an agent's member token. The page takes a viewer token."
					: error.status === 404
						? "That token doesn't belong to this team."
						: `Couldn't sign in: ${error.message}`;
		return;
	}
	saveViewer(viewer);
	form.reset();
	showSignedIn();
}

function showSignedIn() {
	$("sign-in").hidden = true;
	$("sign-in-error").textContent = "";
	$("who").textContent = `Team ${viewer.team}`;
	$("sign-out").hidden = false;
	route();
}

// ---- Routing and polling --------------------------------------------------------------------

let current = null; // the view on screen: { refresh() }
let timer = null;

function stopPolling() {
	clearInterval(timer);
	timer = null;
	current = null;
}

/** Refreshes the view on screen about every 10 s, only while the tab is visible. */
function startPolling(view) {
	stopPolling();
	current = view;
	timer = setInterval(() => {
		if (document.visibilityState === "visible") {
			tick();
		}
	}, POLL_MS);
	tick();
}

async function tick() {
	const view = current;
	if (!view || view.busy) {
		return;
	}
	view.busy = true;
	try {
		await view.refresh();
		view.setStatus("");
	} catch (error) {
		if (error.status === 401 || error.status === 403) {
			signOut("Your token is no longer accepted. Sign in again.");
		} else if (view === current) {
			view.setStatus(
				error.status === 404 ? "This room doesn't exist or has expired." : `Couldn't update: ${error.message}`,
			);
		}
	} finally {
		view.busy = false;
	}
}

function route() {
	if (!viewer) {
		return;
	}
	const match = location.hash.match(/^#\/rooms\/([0-9a-f]{32})$/);
	startPolling(match && ROOM_ID.test(match[1]) ? roomView(match[1]) : roomsView());
}

// ---- The rooms list -------------------------------------------------------------------------

function counts(tasks) {
	const list = el("ul", "counts");
	for (const key of [...COLUMNS, "overdue", "blocked"]) {
		const count = tasks?.[key] ?? 0;
		if (count > 0 || COLUMNS.includes(key)) {
			list.append(
				el("li", count > 0 && (key === "overdue" || key === "blocked") ? `warn ${key}` : key, `${count} ${key}`),
			);
		}
	}

	return list;
}

function roomsView() {
	const status = el("p", "status", "Loading…");
	const list = el("ul", "rooms");
	$("view").replaceChildren(el("h1", null, "Rooms"), status, list);

	return {
		setStatus(text) {
			status.textContent = text;
		},
		async refresh() {
			const { rooms } = await api(teamPath());
			if (rooms.length === 0) {
				list.replaceChildren(el("li", "empty", "No rooms yet. Rooms appear here once an agent opens one."));
				return;
			}
			list.replaceChildren(
				...rooms.map((room) => {
					const link = el("a", "room-link", el("code", "room-id", room.id));
					link.href = `#/rooms/${room.id}`;
					return el(
						"li",
						`room ${room.closed ? "is-closed" : "is-open"}`,
						el("div", "room-head", link, room.closed ? badge("closed", "closed") : badge("open", "open")),
						el(
							"p",
							"meta",
							"Last activity ",
							timeEl(room.lastActivity),
							` · ${room.lastSeq} message${room.lastSeq === 1 ? "" : "s"}`,
							room.closed ? " · closed " : null,
							room.closed ? timeEl(room.closed) : null,
						),
						counts(room.tasks),
					);
				}),
			);
		},
	};
}

// ---- One room -------------------------------------------------------------------------------

function taskCard(task) {
	const flags = el(
		"div",
		"flags",
		task.overdue ? badge(`overdue · due ${task.due}`, "overdue") : task.due ? badge(`due ${task.due}`, "due") : null,
		task.blocked ? badge(`blocked by #${task.waitsFor.join(", #")}`, "blocked") : null,
		task.priority && task.priority !== "normal" ? badge(task.priority, `priority-${task.priority}`) : null,
	);
	const card = el(
		"li",
		`task${task.overdue ? " is-overdue" : ""}${task.blocked ? " is-blocked" : ""}`,
		el("p", "task-title", el("span", "task-number", `#${task.number} `), task.title),
		flags.childElementCount > 0 ? flags : null,
		task.doneWhen ? el("p", "done-when", "Done when: ", task.doneWhen) : null,
		el("p", "meta", `by ${task.createdBy}`, task.holder ? ` · held by ${task.holder}` : null),
	);

	return card;
}

function roomView(roomId) {
	const base = `${teamPath()}/${roomId}`;
	const back = el("a", "back", "← All rooms");
	back.href = "#/";
	const title = el("h1", null, "Room ", el("code", "room-id", roomId));
	const state = el("p", "meta");
	const status = el("p", "status", "Loading…");

	const people = el("ul", "people");
	const board = el("div", "board");
	const columns = Object.fromEntries(COLUMNS.map((name) => [name, el("ol", "tasks")]));
	const headings = Object.fromEntries(COLUMNS.map((name) => [name, el("h3", null, name)]));
	board.append(...COLUMNS.map((name) => el("section", `column column-${name}`, headings[name], columns[name])));

	const earlier = el("button", "earlier", "Load earlier messages");
	earlier.type = "button";
	earlier.hidden = true;
	const messages = el("ol", "messages");

	$("view").replaceChildren(
		back,
		title,
		state,
		status,
		el("section", "panel", el("h2", null, "Board"), board),
		el("section", "panel", el("h2", null, "Messages"), earlier, messages),
		el("section", "panel", el("h2", null, "Participants"), people),
	);

	// The seqs shown so far: messages[oldest..newest]. 0 until the first load.
	let oldest = 0;
	let newest = 0;
	let loaded = false;

	function messageItem(message) {
		const item = el(
			"li",
			message.sender === "[board]" ? "message board-line" : "message",
			el("p", "meta", el("span", "sender", message.sender), " · ", timeEl(message.at), ` · #${message.seq}`),
			el("p", "text", message.text),
		);
		return item;
	}

	/** Reads every message after since, following more until the end. */
	async function readFrom(since) {
		const all = [];
		for (;;) {
			const page = await api(`${base}/messages?since=${since}&limit=200`);
			all.push(...page.messages);
			if (!page.more || page.messages.length === 0) {
				return all;
			}
			since = page.messages[page.messages.length - 1].seq;
		}
	}

	earlier.addEventListener("click", async () => {
		earlier.disabled = true;
		try {
			const since = Math.max(0, oldest - 1 - PAGE);
			const { messages: page } = await api(`${base}/messages?since=${since}&limit=${oldest - 1 - since}`);
			if (page.length > 0) {
				messages.prepend(...page.map(messageItem));
				oldest = page[0].seq;
			}
			// Nothing earlier is kept once a page comes back short of the seq it started after.
			earlier.hidden = page.length === 0 || since === 0;
		} catch (error) {
			status.textContent = `Couldn't load earlier messages: ${error.message}`;
		} finally {
			earlier.disabled = false;
		}
	});

	return {
		setStatus(text) {
			status.textContent = text;
		},
		async refresh() {
			const [{ room }, { tasks }] = await Promise.all([api(base), api(`${base}/tasks?include_confirmed=true`)]);

			state.replaceChildren(
				...present([
					room.closed ? badge("closed", "closed") : badge("open", "open"),
					" Opened ",
					timeEl(room.opened),
					room.closed ? " · closed " : null,
					room.closed ? timeEl(room.closed) : null,
					" · last activity ",
					timeEl(room.lastActivity),
					` · ${room.connectedCount} stream${room.connectedCount === 1 ? "" : "s"} open`,
				]),
			);

			people.replaceChildren(
				...(room.participants.length === 0
					? [el("li", "empty", "Nobody has posted or taken a step yet.")]
					: room.participants.map((person) =>
							el(
								"li",
								"person",
								el("span", "sender", person.name),
								person.owner ? el("span", "owner", ` (${person.owner}'s agent)`) : null,
								el("span", "meta", " · last seen ", timeEl(person.lastSeen)),
							),
						)),
			);

			for (const name of COLUMNS) {
				const inColumn = tasks.filter((task) => task.status === name);
				headings[name].textContent = `${name} (${inColumn.length})`;
				columns[name].replaceChildren(...inColumn.map(taskCard));
			}

			if (!loaded) {
				// Open at the latest page; earlier pages load on request.
				const since = Math.max(0, room.lastSeq - PAGE);
				const page = await readFrom(since);
				messages.replaceChildren(...page.map(messageItem));
				oldest = page.length > 0 ? page[0].seq : room.lastSeq + 1;
				newest = page.length > 0 ? page[page.length - 1].seq : room.lastSeq;
				earlier.hidden = since === 0 || page.length === 0;
				loaded = true;
				if (page.length === 0) {
					messages.replaceChildren(el("li", "empty", "No messages."));
				}
			} else if (room.lastSeq > newest) {
				const page = await readFrom(newest);
				if (page.length > 0) {
					messages.querySelector(".empty")?.remove();
					messages.append(...page.map(messageItem));
					newest = page[page.length - 1].seq;
				}
			}
		},
	};
}

// ---- Start ----------------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
	$("sign-in").addEventListener("submit", signIn);
	$("sign-out").addEventListener("click", () => signOut());
	window.addEventListener("hashchange", route);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			tick();
		}
	});
	if (viewer) {
		showSignedIn();
	} else {
		showSignedOut();
	}
});

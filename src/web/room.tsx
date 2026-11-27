// One room: its board in four columns, its messages with earlier pages on request, and who is in it.
import { useRef, useState } from "preact/hooks";
import { api, type Message, type MessagePage, type RoomDetail, roomsPath, type Task, type Viewer } from "./api.ts";
import { useBoardMotion } from "./motion.ts";
import { usePolling } from "./poll.ts";
import { Badge, Live, plural, Squiggle, Status, Time } from "./ui.tsx";

const PAGE = 50;
const COLUMNS = ["open", "claimed", "done", "confirmed"] as const;
const SENDER_TONES = ["pink", "yellow", "teal", "violet"] as const;

/** The same sender always gets the same colour, so a conversation is easy to follow. */
function senderTone(name: string): string {
	let hash = 0;
	for (const char of name) {
		hash = (hash * 31 + char.charCodeAt(0)) | 0;
	}
	return SENDER_TONES[Math.abs(hash) % SENDER_TONES.length];
}

function TaskCard({ task }: { task: Task }) {
	const flags = [
		task.overdue ? (
			<Badge key="due" tone="overdue">
				overdue · due {task.due}
			</Badge>
		) : task.due ? (
			<Badge key="due" tone="due">
				due {task.due}
			</Badge>
		) : null,
		task.blocked ? (
			<Badge key="blocked" tone="blocked">
				blocked by #{task.waitsFor.join(", #")}
			</Badge>
		) : null,
		task.priority !== "normal" ? (
			<Badge key="priority" tone={task.priority}>
				{task.priority}
			</Badge>
		) : null,
	].filter(Boolean);

	return (
		<li
			class={`task${task.overdue ? " is-overdue" : ""}${task.blocked ? " is-blocked" : ""}`}
			data-task={task.number}
			data-status={task.status}
		>
			<p class="task-title">
				<span class="task-number">#{task.number}</span> {task.title}
			</p>
			{flags.length > 0 && <div class="flags">{flags}</div>}
			{task.doneWhen && (
				<p class="done-when">
					<span class="done-when-label">Done when</span> {task.doneWhen}
				</p>
			)}
			<p class="meta">
				by {task.createdBy}
				{task.holder && <> · held by {task.holder}</>}
			</p>
		</li>
	);
}

function Board({ tasks }: { tasks: Task[] }) {
	const board = useRef<HTMLDivElement>(null);
	useBoardMotion(board, tasks);
	return (
		<div class="board" ref={board}>
			{COLUMNS.map((name) => {
				const inColumn = tasks.filter((task) => task.status === name);
				return (
					<section key={name} class={`column column-${name}`} aria-label={`${name}, ${inColumn.length}`}>
						<h3 class="column-head">
							<span class="column-name">{name}</span>
							<span class="column-count">{inColumn.length}</span>
						</h3>
						{inColumn.length === 0 ? (
							<p class="column-empty">Nothing here</p>
						) : (
							<ol class="tasks">
								{inColumn.map((task) => (
									<TaskCard key={task.number} task={task} />
								))}
							</ol>
						)}
					</section>
				);
			})}
		</div>
	);
}

function MessageItem({ message, arrived }: { message: Message; arrived: boolean }) {
	const fresh = arrived ? " is-new" : "";
	if (message.sender === "[board]") {
		return (
			<li class={`message board-line${fresh}`}>
				<span class="board-line-tag">board</span>
				<span class="text">{message.text}</span>
				<span class="meta">
					<Time at={message.at} /> · #{message.seq}
				</span>
			</li>
		);
	}
	const tone = senderTone(message.sender);
	return (
		<li class={`message${fresh}`}>
			<span class={`avatar avatar-${tone}`} aria-hidden="true">
				{message.sender.slice(0, 1).toUpperCase()}
			</span>
			<div class="bubble">
				<p class="meta">
					<span class="sender">{message.sender}</span> · <Time at={message.at} /> · #{message.seq}
				</p>
				<p class="text">{message.text}</p>
			</div>
		</li>
	);
}

export function RoomView({ viewer, roomId, onRefused }: { viewer: Viewer; roomId: string; onRefused: () => void }) {
	const base = `${roomsPath(viewer)}/${roomId}`;
	const [room, setRoom] = useState<RoomDetail | null>(null);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [messages, setMessages] = useState<Message[] | null>(null);
	const [hasEarlier, setHasEarlier] = useState(false);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [earlierError, setEarlierError] = useState("");
	// The seqs shown so far: messages[oldest..newest]. Unset until the first load.
	const range = useRef<{ oldest: number; newest: number } | null>(null);
	// The newest seq of the first load: anything after it arrived while the page was open, and pops in.
	const firstNewest = useRef(Number.POSITIVE_INFINITY);

	/** Reads every message after since, following more until the end. */
	async function readFrom(since: number): Promise<Message[]> {
		const all: Message[] = [];
		for (;;) {
			const page = await api<MessagePage>(viewer, `${base}/messages?since=${since}&limit=200`);
			all.push(...page.messages);
			if (!page.more || page.messages.length === 0) {
				return all;
			}
			since = page.messages[page.messages.length - 1].seq;
		}
	}

	const { status, loading, live } = usePolling(
		async () => {
			const [{ room: next }, { tasks: board }] = await Promise.all([
				api<{ room: RoomDetail }>(viewer, base),
				api<{ tasks: Task[] }>(viewer, `${base}/tasks?include_confirmed=true`),
			]);
			setRoom(next);
			setTasks(board);

			const shown = range.current;
			if (!shown) {
				// Open at the latest page; earlier pages load on request.
				const since = Math.max(0, next.lastSeq - PAGE);
				const page = await readFrom(since);
				range.current = {
					oldest: page.length > 0 ? page[0].seq : next.lastSeq + 1,
					newest: page.length > 0 ? page[page.length - 1].seq : next.lastSeq,
				};
				firstNewest.current = range.current.newest;
				setMessages(page);
				setHasEarlier(since > 0 && page.length > 0);
			} else if (next.lastSeq > shown.newest) {
				const page = await readFrom(shown.newest);
				if (page.length > 0) {
					shown.newest = page[page.length - 1].seq;
					setMessages((list) => [...(list ?? []), ...page]);
				}
			}
		},
		onRefused,
		"This room doesn't exist or has expired.",
	);

	async function loadEarlier() {
		const shown = range.current;
		if (!shown) {
			return;
		}
		setLoadingEarlier(true);
		setEarlierError("");
		try {
			const since = Math.max(0, shown.oldest - 1 - PAGE);
			const { messages: page } = await api<MessagePage>(
				viewer,
				`${base}/messages?since=${since}&limit=${shown.oldest - 1 - since}`,
			);
			if (page.length > 0) {
				shown.oldest = page[0].seq;
				setMessages((list) => [...page, ...(list ?? [])]);
			}
			// Nothing earlier is kept once a page comes back short of the seq it started after.
			setHasEarlier(page.length > 0 && since > 0);
		} catch (error) {
			setEarlierError(`Couldn't load earlier messages: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setLoadingEarlier(false);
		}
	}

	return (
		<>
			<a class="back" href="#/">
				← All rooms
			</a>
			<div class="page-head room-title-row">
				<h1 class="page-title">
					Room <code class="room-id">{roomId}</code>
				</h1>
				{!loading && <Live on={live} />}
			</div>
			{room && (
				<p class="room-state">
					{room.closed ? <Badge tone="closed">closed</Badge> : <Badge tone="open">open</Badge>}
					<span class="meta">
						Opened <Time at={room.opened} />
						{room.closed && (
							<>
								{" "}
								· closed <Time at={room.closed} />
							</>
						)}{" "}
						· last activity <Time at={room.lastActivity} /> · {plural(room.connectedCount, "stream")} open
					</span>
				</p>
			)}
			<Status text={status || earlierError} loading={loading} />

			<section class="frame panel panel-board" aria-labelledby="board-title">
				<div class="panel-head">
					<h2 id="board-title">Board</h2>
					<Squiggle waves={2} tone="yellow" />
				</div>
				<Board tasks={tasks} />
			</section>

			<div class="room-columns">
				<section class="frame panel panel-messages" aria-labelledby="messages-title">
					<div class="panel-head">
						<h2 id="messages-title">Messages</h2>
						<Squiggle waves={2} tone="pink" />
					</div>
					{hasEarlier && (
						<button type="button" class="button button-ghost earlier" disabled={loadingEarlier} onClick={loadEarlier}>
							{loadingEarlier ? "Loading…" : "Load earlier messages"}
						</button>
					)}
					{messages && messages.length === 0 ? (
						<p class="empty">No messages.</p>
					) : (
						<ol class="messages">
							{messages?.map((message) => (
								<MessageItem key={message.seq} message={message} arrived={message.seq > firstNewest.current} />
							))}
						</ol>
					)}
				</section>

				<section class="frame panel panel-people" aria-labelledby="people-title">
					<div class="panel-head">
						<h2 id="people-title">Participants</h2>
						<Squiggle waves={2} tone="teal" />
					</div>
					{room && room.participants.length === 0 ? (
						<p class="empty">Nobody has posted or taken a step yet.</p>
					) : (
						<ul class="people">
							{room?.participants.map((person) => (
								<li key={person.name} class="person">
									<span class={`avatar avatar-${senderTone(person.name)}`} aria-hidden="true">
										{person.name.slice(0, 1).toUpperCase()}
									</span>
									<span class="person-text">
										<span class="sender">{person.name}</span>
										{person.owner && <span class="owner">{person.owner}'s agent</span>}
										<span class="meta">
											last seen <Time at={person.lastSeen} />
										</span>
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</>
	);
}

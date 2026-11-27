// The team's rooms: one chunky card each, open rooms first as the API orders them.
import { useState } from "preact/hooks";
import { api, type RoomSummary, roomsPath, type TaskCounts, type Viewer } from "./api.ts";
import { usePolling } from "./poll.ts";
import { Badge, plural, Squiggle, Time } from "./ui.tsx";

const COLUMNS = ["open", "claimed", "done", "confirmed"] as const;

function Counts({ tasks }: { tasks: TaskCounts | undefined }) {
	const overdue = tasks?.overdue ?? 0;
	const blocked = tasks?.blocked ?? 0;
	return (
		<ul class="counts" aria-label="Tasks">
			{COLUMNS.map((key) => (
				<li key={key} class={`count count-${key}`}>
					<strong>{tasks?.[key] ?? 0}</strong> {key}
				</li>
			))}
			{overdue > 0 && (
				<li class="count count-overdue">
					<strong>{overdue}</strong> overdue
				</li>
			)}
			{blocked > 0 && (
				<li class="count count-blocked">
					<strong>{blocked}</strong> blocked
				</li>
			)}
		</ul>
	);
}

function RoomCard({ room }: { room: RoomSummary }) {
	return (
		<li class={`frame room-card ${room.closed ? "is-closed" : "is-open"}`}>
			<a class="room-link" href={`#/rooms/${room.id}`}>
				<span class="room-head">
					{room.closed ? <Badge tone="closed">closed</Badge> : <Badge tone="open">open</Badge>}
					<code class="room-id">{room.id}</code>
				</span>
				<span class="meta">
					Last activity <Time at={room.lastActivity} /> · {plural(room.lastSeq, "message")}
					{room.closed && (
						<>
							{" "}
							· closed <Time at={room.closed} />
						</>
					)}
				</span>
			</a>
			<Counts tasks={room.tasks} />
		</li>
	);
}

export function RoomsView({ viewer, onRefused }: { viewer: Viewer; onRefused: () => void }) {
	const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
	const status = usePolling(
		async () => setRooms((await api<{ rooms: RoomSummary[] }>(viewer, roomsPath(viewer))).rooms),
		onRefused,
		"This team has no rooms here.",
	);

	return (
		<>
			<div class="page-head">
				<h1 class="page-title">Rooms</h1>
				<Squiggle waves={3} tone="pink" />
			</div>
			<p class="status" role="status">
				{status}
			</p>
			{rooms && rooms.length === 0 ? (
				<div class="frame empty-state">
					<div class="dots" aria-hidden="true" />
					<h2>No rooms yet</h2>
					<p>Rooms appear here once an agent on your team opens one.</p>
				</div>
			) : (
				<ul class="rooms">
					{rooms?.map((room) => (
						<RoomCard key={room.id} room={room} />
					))}
				</ul>
			)}
		</>
	);
}

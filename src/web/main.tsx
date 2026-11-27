// The Partyline people's page: a read-only view of a team's rooms over the people API v1.
// Room text is written by other people's agents, so it only reaches the page through JSX text,
// which Preact writes as text nodes. Nothing here sets HTML.
import "./styles/tokens.css";
import "./styles/app.css";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api, ApiError, clearViewer, loadViewer, ROOM_ID, roomsPath, saveViewer, TEAM, type Viewer } from "./api.ts";
import { RoomView } from "./room.tsx";
import { RoomsView } from "./rooms.tsx";
import { LogoMark, Squiggle, Wordmark } from "./ui.tsx";

function roomFromHash(): string | null {
	const match = location.hash.match(/^#\/rooms\/([0-9a-f]{32})$/);
	return match && ROOM_ID.test(match[1]) ? match[1] : null;
}

function useRoomRoute(): string | null {
	const [room, setRoom] = useState(roomFromHash);
	useEffect(() => {
		const onHash = () => setRoom(roomFromHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	return room;
}

function signInError(error: unknown): string {
	if (!(error instanceof ApiError)) {
		return `Couldn't sign in: ${error instanceof Error ? error.message : String(error)}`;
	}
	switch (error.status) {
		case 401:
			return "That token isn't known here.";
		case 403:
			return "That is an agent's member token. The page takes a viewer token.";
		case 404:
			return "That token doesn't belong to this team.";
		default:
			return `Couldn't sign in: ${error.message}`;
	}
}

function SignIn({ notice, onSignedIn }: { notice: string; onSignedIn: (viewer: Viewer) => void }) {
	const [error, setError] = useState(notice);
	const [busy, setBusy] = useState(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const data = new FormData(form);
		const team = String(data.get("team") ?? "").trim();
		const token = String(data.get("token") ?? "").trim();
		if (!TEAM.test(team)) {
			setError("A team name is a-z, 0-9 or dash, up to 32 characters.");
			return;
		}
		const viewer = { team, token };
		setBusy(true);
		try {
			await api(viewer, roomsPath(viewer));
		} catch (failure) {
			setError(signInError(failure));
			return;
		} finally {
			setBusy(false);
		}
		saveViewer(viewer);
		form.reset();
		onSignedIn(viewer);
	}

	return (
		<main class="sign-in-page">
			<div class="dots dots-corner" aria-hidden="true" />
			<form class="frame sign-in" onSubmit={submit} aria-labelledby="sign-in-title">
				<div class="sign-in-brand">
					<LogoMark size={88} />
					<Wordmark large />
				</div>
				<p class="tagline">Rooms for agents. Guard on the door.</p>
				<h1 id="sign-in-title" class="sign-in-title">
					Sign in to watch your team's rooms
				</h1>
				<p class="hint">
					Paste the viewer token you were given. It stays in this tab and is gone when you close it or sign out.
				</p>
				<label class="field">
					<span class="field-label">Team</span>
					<input name="team" autocomplete="off" spellcheck={false} required pattern="[a-z0-9\-]{1,32}" />
				</label>
				<label class="field">
					<span class="field-label">Viewer token</span>
					<input name="token" type="password" autocomplete="off" required />
				</label>
				<p class="error" role="alert">
					{error}
				</p>
				<button type="submit" class="button button-primary" disabled={busy}>
					{busy ? "Checking…" : "Sign in"}
				</button>
				<Squiggle waves={4} tone="teal" />
			</form>
		</main>
	);
}

function Header({ team, onSignOut }: { team: string; onSignOut: () => void }) {
	return (
		<header class="bar">
			<a class="brand" href="#/" aria-label="Partyline: all rooms">
				<LogoMark size={40} />
				<Wordmark />
			</a>
			<span class="who">
				<span class="who-label">team</span> {team}
			</span>
			<button type="button" class="button button-ghost" onClick={onSignOut}>
				Sign out
			</button>
		</header>
	);
}

function App() {
	const [viewer, setViewer] = useState(loadViewer);
	const [notice, setNotice] = useState("");
	const room = useRoomRoute();

	const signOut = useCallback((message = "") => {
		clearViewer();
		setNotice(message);
		setViewer(null);
	}, []);
	const refused = useCallback(() => signOut("Your token is no longer accepted. Sign in again."), [signOut]);

	if (!viewer) {
		return (
			<SignIn
				key={notice}
				notice={notice}
				onSignedIn={(next) => {
					setNotice("");
					setViewer(next);
				}}
			/>
		);
	}

	return (
		<>
			<Header team={viewer.team} onSignOut={() => signOut()} />
			<main class="page">
				{room ? (
					<RoomView key={room} viewer={viewer} roomId={room} onRefused={refused} />
				) : (
					<RoomsView viewer={viewer} onRefused={refused} />
				)}
			</main>
		</>
	);
}

render(<App />, document.getElementById("root")!);

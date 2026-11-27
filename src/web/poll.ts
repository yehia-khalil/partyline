// Keeps a view fresh: loads it now, then about every 10 s while the tab is visible, and again
// when the tab comes back. A refused token signs the page out; anything else shows as a status line.
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, isRefused } from "./api.ts";

export const POLL_MS = 10_000;

export interface Polling {
	/** Empty when the last refresh worked, otherwise what to tell the reader. */
	status: string;
	/** True until the first refresh has answered. */
	loading: boolean;
	/** True while the page is actually following the room: the tab is visible and the last refresh worked. */
	live: boolean;
}

export function usePolling(refresh: () => Promise<void>, onRefused: () => void, notFound: string): Polling {
	const [status, setStatus] = useState("Loading…");
	const [loading, setLoading] = useState(true);
	const [visible, setVisible] = useState(document.visibilityState === "visible");
	const latest = useRef(refresh);
	latest.current = refresh;
	const refused = useRef(onRefused);
	refused.current = onRefused;

	useEffect(() => {
		let busy = false;
		let live = true;
		async function tick() {
			if (busy || !live) {
				return;
			}
			busy = true;
			try {
				await latest.current();
				if (live) {
					setStatus("");
					setLoading(false);
				}
			} catch (error) {
				if (!live) {
					return;
				}
				if (isRefused(error)) {
					refused.current();
				} else {
					const message = error instanceof Error ? error.message : String(error);
					setStatus(error instanceof ApiError && error.status === 404 ? notFound : `Couldn't update: ${message}`);
					setLoading(false);
				}
			} finally {
				busy = false;
			}
		}
		const visible = () => {
			const shown = document.visibilityState === "visible";
			setVisible(shown);
			if (shown) {
				tick();
			}
		};
		const timer = setInterval(visible, POLL_MS);
		document.addEventListener("visibilitychange", visible);
		tick();

		return () => {
			live = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [notFound]);

	return { status, loading, live: !loading && status === "" && visible };
}

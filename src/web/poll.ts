// Keeps a view fresh: loads it now, then about every 10 s while the tab is visible, and again
// when the tab comes back. A refused token signs the page out; anything else shows as a status line.
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, isRefused } from "./api.ts";

export const POLL_MS = 10_000;

export function usePolling(refresh: () => Promise<void>, onRefused: () => void, notFound: string): string {
	const [status, setStatus] = useState("Loading…");
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
				}
			} finally {
				busy = false;
			}
		}
		const visible = () => {
			if (document.visibilityState === "visible") {
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

	return status;
}

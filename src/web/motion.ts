// The motion that needs script: a task card gliding to its new column (FLIP), the confetti burst
// when a task is confirmed, and the shake of a refused sign-in. Everything else is CSS in app.css.
// It all uses the Web Animations API on transform and opacity only, reads its timings from the
// --motion-* tokens in tokens.css, and does nothing when the reader prefers reduced motion.
import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export const prefersReducedMotion = () => reducedMotion.matches;

function token(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A duration token in milliseconds. Browsers may hand it back as "620ms" or as "0.62s". */
function ms(name: string): number {
	const text = token(name);
	const value = parseFloat(text);
	if (!Number.isFinite(value)) {
		return 0;
	}
	return text.endsWith("ms") ? value : text.endsWith("s") ? value * 1000 : value;
}

/** Shakes an element once, side to side: a refused sign-in. */
export function shake(element: Element | null) {
	if (!element || prefersReducedMotion()) {
		return;
	}
	element.animate(
		[
			{ transform: "translateX(0)" },
			{ transform: "translateX(-12px)" },
			{ transform: "translateX(10px)" },
			{ transform: "translateX(-6px)" },
			{ transform: "translateX(4px)" },
			{ transform: "translateX(0)" },
		],
		{ duration: ms("--motion-shake"), easing: token("--ease-out") },
	);
}

const CONFETTI_TONES = ["pink", "yellow", "teal", "violet"] as const;
const CONFETTI_PIECES = 22;

/** A short burst of brand-coloured confetti and sparkles from the middle of an element. */
export function burst(element: Element) {
	if (prefersReducedMotion()) {
		return;
	}
	const box = element.getBoundingClientRect();
	const x = box.left + box.width / 2;
	const y = box.top + box.height / 2;
	const layer = document.createElement("div");
	layer.className = "confetti";
	layer.setAttribute("aria-hidden", "true");
	document.body.append(layer);

	const duration = ms("--motion-burst");
	const flights = [];
	for (let i = 0; i < CONFETTI_PIECES; i++) {
		const piece = document.createElement("span");
		piece.className = `confetti-piece confetti-${CONFETTI_TONES[i % CONFETTI_TONES.length]}${i % 3 === 0 ? " is-sparkle" : ""}`;
		layer.append(piece);
		const angle = (i / CONFETTI_PIECES) * Math.PI * 2 + Math.random() * 0.4;
		const reach = 70 + Math.random() * 80;
		const dx = Math.cos(angle) * reach;
		const dy = Math.sin(angle) * reach - 30;
		const spin = (Math.random() - 0.5) * 720;
		flights.push(
			piece.animate(
				[
					{ transform: `translate(${x}px, ${y}px) rotate(0deg) scale(0.4)`, opacity: 1 },
					{
						transform: `translate(${x + dx}px, ${y + dy}px) rotate(${spin / 2}deg) scale(1.1)`,
						opacity: 1,
						offset: 0.5,
					},
					{
						transform: `translate(${x + dx * 1.1}px, ${y + dy + 30}px) rotate(${spin * 0.75}deg) scale(1)`,
						opacity: 1,
						offset: 0.75,
					},
					{ transform: `translate(${x + dx * 1.15}px, ${y + dy + 60}px) rotate(${spin}deg) scale(0.7)`, opacity: 0 },
				],
				{ duration: duration * (0.8 + Math.random() * 0.4), easing: token("--ease-out") },
			).finished,
		);
	}
	Promise.allSettled(flights).then(() => layer.remove());
}

interface Place {
	status: string;
	x: number;
	y: number;
}

/**
 * Glides a task card to its new place when its status changes, with a small overshoot, and bursts
 * confetti when it reaches confirmed. Cards are found by data-task and data-status inside the
 * container. A poll that changed nothing moves nothing, and the first load never animates.
 */
export function useBoardMotion(container: RefObject<HTMLElement | null>, tasks: unknown) {
	const places = useRef<Map<string, Place> | null>(null);

	useLayoutEffect(() => {
		const root = container.current;
		if (!root) {
			return;
		}
		const origin = root.getBoundingClientRect();
		const before = places.current;
		const after = new Map<string, Place>();
		const animate = before !== null && !prefersReducedMotion();
		for (const card of root.querySelectorAll<HTMLElement>("[data-task]")) {
			const box = card.getBoundingClientRect();
			const place = { status: card.dataset.status ?? "", x: box.left - origin.left, y: box.top - origin.top };
			after.set(card.dataset.task ?? "", place);
			const was = before?.get(card.dataset.task ?? "");
			if (!animate || !was || was.status === place.status) {
				continue;
			}
			card.animate(
				[
					{ transform: `translate(${was.x - place.x}px, ${was.y - place.y}px) scale(1.04)` },
					{ transform: "translate(0, 0) scale(1)" },
				],
				{ duration: ms("--motion-glide"), easing: token("--ease-bounce") },
			);
			if (place.status === "confirmed") {
				window.setTimeout(() => burst(card), ms("--motion-glide") * 0.6);
			}
		}
		places.current = after;
	}, [tasks]);
}

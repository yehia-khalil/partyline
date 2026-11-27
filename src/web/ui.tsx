// Small pieces every view uses: the brand marks drawn from .github/assets, badges and times.
// Everything here renders through JSX, so room text only ever becomes text nodes.
import type { ComponentChildren } from "preact";

/** The logo mark from the banner: a chunky frame with three dots and the guard's shield. */
export function LogoMark({ size = 40 }: { size?: number }) {
	return (
		<svg class="logo-mark" viewBox="0 0 272 272" width={size} height={size} aria-hidden="true" focusable="false">
			<defs>
				<mask id="pl-mark-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="272" height="272">
					<rect width="272" height="272" fill="#fff" />
					<path
						d="M150 146 H240 V196 C240 226 221 242 195 252 C169 242 150 226 150 196Z"
						fill="#000"
						stroke="#000"
						stroke-width="13"
						stroke-linejoin="round"
					/>
				</mask>
			</defs>
			<g mask="url(#pl-mark-mask)">
				<rect
					x="30"
					y="22"
					width="196"
					height="176"
					rx="32"
					fill="none"
					class="mark-shadow"
					stroke-width="26"
					transform="translate(11 11)"
				/>
				<rect x="30" y="22" width="196" height="176" rx="32" fill="none" stroke="#ff4fa3" stroke-width="26" />
				<circle cx="80" cy="98" r="17" fill="#ffd23f" />
				<circle cx="128" cy="98" r="17" fill="#3ddbd9" />
				<circle cx="176" cy="98" r="17" fill="#8b5cf6" />
			</g>
			<path d="M150 146 H240 V196 C240 226 221 242 195 252 C169 242 150 226 150 196Z" fill="#ffd23f" />
			<path d="M187.2 186.0 A10.2 10.2 0 1 1 202.8 186.0 L208.2 211.2 H181.8Z" fill="#241446" />
		</svg>
	);
}

/** The slanted two-colour wordmark, set in the system's heaviest face. */
export function Wordmark({ large = false }: { large?: boolean }) {
	return (
		<span class={large ? "wordmark wordmark-large" : "wordmark"} aria-label="Partyline">
			<span class="wordmark-party" aria-hidden="true">
				PARTY
			</span>
			<span class="wordmark-line" aria-hidden="true">
				LINE
			</span>
		</span>
	);
}

/** The banner's squiggle: half-waves of 30 units, drawn with a round cap. */
export function Squiggle({ waves = 4, tone = "pink" }: { waves?: number; tone?: "pink" | "teal" | "yellow" }) {
	let d = "M6 20";
	for (let i = 0; i < waves * 2; i++) {
		d += ` q15 ${i % 2 === 0 ? -14 : 14} 30 0`;
	}
	return (
		<svg
			class={`squiggle squiggle-${tone}`}
			viewBox={`0 0 ${waves * 60 + 12} 40`}
			width={waves * 30 + 6}
			height="20"
			aria-hidden="true"
			focusable="false"
		>
			<path d={d} fill="none" stroke-width="9" stroke-linecap="round" />
		</svg>
	);
}

export type Tone = "open" | "closed" | "overdue" | "blocked" | "due" | "high" | "low" | "muted";

export function Badge({ tone, children }: { tone: Tone; children: ComponentChildren }) {
	return <span class={`badge badge-${tone}`}>{children}</span>;
}

function when(iso: string | null | undefined): string {
	if (!iso) {
		return "";
	}
	const date = new Date(iso);

	return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

export function Time({ at }: { at: string | null | undefined }) {
	return <time dateTime={String(at ?? "")}>{when(at)}</time>;
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

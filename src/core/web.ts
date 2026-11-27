/**
 * The people's web page at /app: one static page, its script and its stylesheet, served the same
 * way on every host. The page holds no data; it signs in with a viewer token and reads the people
 * API from the browser. The host supplies the files' text, read from src/web.
 */

export type WebAssets = { html: string; css: string; script: string };

/** Only this origin's own files and API, nothing inline, no frames, no forms that navigate. */
export const CONTENT_SECURITY_POLICY =
	"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const SECURITY_HEADERS = {
	"Content-Security-Policy": CONTENT_SECURITY_POLICY,
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-cache",
};

/** Answers /app and its two files, or null for any other path. */
export function serveApp(request: Request, url: URL, assets: WebAssets): Response | null {
	const files: Record<string, [string, string]> = {
		"/app": [assets.html, "text/html; charset=utf-8"],
		"/app/app.js": [assets.script, "text/javascript; charset=utf-8"],
		"/app/app.css": [assets.css, "text/css; charset=utf-8"],
	};
	const file = files[url.pathname];
	if (!file) {
		return null;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405, headers: { ...SECURITY_HEADERS, Allow: "GET, HEAD" } });
	}
	const [body, type] = file;

	return new Response(request.method === "HEAD" ? null : body, {
		headers: { ...SECURITY_HEADERS, "Content-Type": type },
	});
}

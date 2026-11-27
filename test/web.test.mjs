/**
 * The people's page (src/web) shows text other people's agents wrote, so it must never turn that
 * text into markup or code. There is no DOM in the test runner, so this checks the source: no
 * HTML sinks, no eval, nothing inline for the CSP to refuse, and the token kept out of lasting storage.
 * It also checks the core handler both hosts share.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTENT_SECURITY_POLICY, serveApp } from "../src/core/web.ts";

const read = (name) => readFileSync(new URL(`../src/web/${name}`, import.meta.url), "utf8");
// Comments may name what the code must not do, so the checks read the code alone.
const script = read("app.js").replace(/^\s*\/\/.*$/gm, "");
const html = read("index.html");

test("the page script never writes HTML or runs strings as code", () => {
	for (const sink of [
		/\.innerHTML\b/,
		/\.outerHTML\b/,
		/insertAdjacentHTML/,
		/document\.write/,
		/\beval\s*\(/,
		/\bnew\s+Function\b/,
		/setTimeout\s*\(\s*["'`]/,
		/setInterval\s*\(\s*["'`]/,
		/DOMParser/,
		/createContextualFragment/,
		/\.srcdoc\b/,
	]) {
		assert.doesNotMatch(script, sink, String(sink));
	}
});

test("the token is kept in sessionStorage only, never localStorage, a cookie or the URL", () => {
	assert.match(script, /sessionStorage\.setItem/);
	assert.doesNotMatch(script, /localStorage|document\.cookie|indexedDB/);
	assert.doesNotMatch(script, /[?&]token=|location\.(search|href)\s*=/);
	assert.match(script, /Authorization: `Bearer \$\{viewer\.token\}`/);
});

test("the HTML has no inline script, style or event handlers for the CSP to refuse", () => {
	assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
	assert.doesNotMatch(html, /<style|style="/);
	assert.doesNotMatch(html, /\son[a-z]+=/);
	assert.doesNotMatch(html, /https?:\/\//);
});

test("the core handler both hosts share serves /app and its files with the security headers", async () => {
	const assets = { html: "<p>page</p>", css: "p{}", script: "1" };
	for (const path of ["/app", "/app/app.js", "/app/app.css"]) {
		const url = new URL(`https://rooms.example${path}`);
		const response = serveApp(new Request(url), url, assets);
		assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	}
	const head = new URL("https://rooms.example/app");
	assert.equal(await serveApp(new Request(head, { method: "HEAD" }), head, assets).text(), "");
	const other = new URL("https://rooms.example/app/x");
	assert.equal(serveApp(new Request(other), other, assets), null);
});

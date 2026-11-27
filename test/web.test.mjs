/**
 * The people's page (src/web, built by Vite into dist/web) shows text other people's agents wrote,
 * so it must never turn that text into markup or code. There is no DOM in the test runner, so this
 * checks the source and the built files: no HTML sinks, no eval, nothing inline for the CSP to
 * refuse, nothing from another origin, and the token kept out of lasting storage. It also checks
 * the core handler both hosts share. npm test builds the page first (pretest).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTENT_SECURITY_POLICY, serveApp } from "../src/core/web.ts";

const sourceDir = new URL("../src/web/", import.meta.url);
const builtDir = new URL("../dist/web/", import.meta.url);
// Comments may name what the code must not do, so the checks read the code alone.
const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const sources = readdirSync(sourceDir, { recursive: true })
	.filter((name) => /\.(ts|tsx)$/.test(name))
	.map((name) => [name, stripComments(readFileSync(new URL(name, sourceDir), "utf8"))]);
const source = sources.map(([, text]) => text).join("\n");
const built = (name) => readFileSync(new URL(name, builtDir), "utf8");

test("the page source never writes HTML or runs strings as code", () => {
	assert.ok(sources.length >= 5, "the page's sources were found");
	for (const sink of [
		/dangerouslySetInnerHTML/,
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
		/\bstyle=\{/,
	]) {
		assert.doesNotMatch(source, sink, String(sink));
	}
});

test("the built script has no eval or Function constructor and loads nothing from elsewhere", () => {
	const script = built("app.js");
	assert.doesNotMatch(script, /\beval\s*\(/);
	assert.doesNotMatch(script, /\bnew\s+Function\b|\bFunction\s*\(/);
	assert.doesNotMatch(script, /\bimport\s*\(/);
	// The only absolute URLs Preact carries are the SVG, XHTML and MathML namespace names.
	for (const url of script.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
		assert.match(url, /^http:\/\/www\.w3\.org\//, url);
	}
	assert.doesNotMatch(built("app.css"), /url\(|@import|https?:/);
});

test("Vite emits exactly the three files the server serves", () => {
	assert.deepEqual(readdirSync(builtDir).sort(), ["app.css", "app.js", "index.html"]);
});

test("the token is kept in sessionStorage only, never localStorage, a cookie or the URL", () => {
	assert.match(source, /sessionStorage\.setItem/);
	assert.doesNotMatch(source, /localStorage|document\.cookie|indexedDB/);
	assert.doesNotMatch(source, /[?&]token=|location\.(search|href)\s*=/);
	assert.match(source, /Authorization: `Bearer \$\{viewer\.token\}`/);
	assert.doesNotMatch(built("app.js"), /localStorage|document\.cookie|indexedDB/);
});

test("the built HTML has no inline script, style or event handlers for the CSP to refuse", () => {
	const html = built("index.html");
	assert.match(html, /<script type="module" crossorigin src="\/app\/app\.js"><\/script>/);
	assert.match(html, /<link rel="stylesheet" crossorigin href="\/app\/app\.css">/);
	assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
	assert.doesNotMatch(html, /<style|style="/);
	assert.doesNotMatch(html, /\son[a-z]+=/);
	assert.doesNotMatch(html, /https?:\/\/|data:/);
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

test("the page's motion moves transform and opacity only, and stops under reduced motion", () => {
	const css = readFileSync(new URL("styles/app.css", sourceDir), "utf8");
	const frames = [...css.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)];
	assert.ok(frames.length >= 5, "the keyframes were found");
	for (const [, name, body] of frames) {
		for (const [, property] of body.matchAll(/^\s*([a-z-]+):/gm)) {
			assert.ok(["transform", "opacity"].includes(property), `@keyframes ${name} animates ${property}`);
		}
	}
	const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
	assert.ok(reduced, "there is a reduced-motion block");
	assert.match(reduced[1], /transition: none !important/);
	assert.match(reduced[1], /animation: none !important/);
	assert.match(source, /prefers-reduced-motion: reduce/, "the scripted motion checks it too");
});

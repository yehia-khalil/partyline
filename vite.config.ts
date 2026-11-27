// Builds the people's page (src/web) into dist/web: index.html, app.js and app.css, nothing else.
// The server serves those three files at /app under a CSP that allows no inline code or style
// and no data: URLs, so nothing may be inlined and there is no module-preload polyfill.
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/web",
	base: "/app/",
	plugins: [preact()],
	build: {
		outDir: "../../dist/web",
		emptyOutDir: true,
		assetsInlineLimit: 0,
		cssCodeSplit: false,
		modulePreload: { polyfill: false },
		sourcemap: false,
		rolldownOptions: {
			output: {
				entryFileNames: "app.js",
				chunkFileNames: "app-[name].js",
				assetFileNames: (asset) => (asset.names.some((name) => name.endsWith(".css")) ? "app.css" : "[name][extname]"),
			},
		},
	},
});

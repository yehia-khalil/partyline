// The people's page as Vite builds it into dist/web, bundled as text by the rules in wrangler.jsonc.
declare module "*/dist/web/index.html" {
	const text: string;
	export default text;
}
declare module "*/dist/web/app.css" {
	const text: string;
	export default text;
}
declare module "*/dist/web/app.js" {
	const text: string;
	export default text;
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { markedSession } from "./harness.mjs";

const { blocked, allowed } = JSON.parse(readFileSync(new URL("./attacks.json", import.meta.url), "utf8"));
const session = markedSession();
after(session.cleanup);

const label = (action) => (typeof action === "string" ? action : `${action.tool} ${JSON.stringify(action.input)}`);

for (const cls of [...new Set(blocked.map((row) => row.class))]) {
	test(`known ${cls} attacks need approval`, () => {
		for (const row of blocked.filter((r) => r.class === cls)) {
			assert.equal(session.weigh(row.action), "approve", `${label(row.action)}: ${row.why}`);
		}
	});
}

test("everyday work is still allowed", () => {
	for (const row of allowed) {
		assert.equal(session.weigh(row.action), row.weight, label(row.action));
	}
});

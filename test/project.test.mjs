import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findMuleRoot } from "../src/project.ts";
import { makeDeps, writeFile } from "./helpers/deps.mjs";

test("finds the marker in cwd", () => {
	const deps = makeDeps();
	writeFile(join(deps.home, "app/mule-artifact.json"), "{}");
	assert.equal(findMuleRoot(join(deps.home, "app"), deps), join(deps.home, "app"));
});

test("finds the marker in an ancestor", () => {
	const deps = makeDeps();
	writeFile(join(deps.home, "app/mule-artifact.json"), "{}");
	mkdirSync(join(deps.home, "app/src/main/mule"), { recursive: true });
	assert.equal(findMuleRoot(join(deps.home, "app/src/main/mule"), deps), join(deps.home, "app"));
});

test("does not look in $HOME itself or above", () => {
	const deps = makeDeps();
	writeFile(join(deps.home, "mule-artifact.json"), "{}");
	mkdirSync(join(deps.home, "x/y"), { recursive: true });
	assert.equal(findMuleRoot(join(deps.home, "x/y"), deps), undefined);
});

test("returns undefined when there is no marker", () => {
	const deps = makeDeps();
	mkdirSync(join(deps.home, "plain"), { recursive: true });
	assert.equal(findMuleRoot(join(deps.home, "plain"), deps), undefined);
});

// The Firestore wrapper must write to the real database and leave the local
// copy alone while the real one works (the local copy is only a fallback).
// Run with `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkvision-dbfb-"));
process.chdir(tmp); // dbFallback resolves its backing files from the cwd at import time
const { HybridFirestore, setForceLocalFallback } = await import("../dbFallback");

function fakeRealDb(opts: { failWith?: Error } = {}) {
  const calls: string[] = [];
  const op = (name: string) => async () => {
    calls.push(name);
    if (opts.failWith) throw opts.failWith;
  };
  const db = {
    collection: () => ({ doc: () => ({ set: op("set"), update: op("update"), delete: op("delete") }) })
  };
  return { db, calls };
}

const projectsFile = path.join(tmp, "db_fallback_projects.json");

test("writes go to the real database only, with no local copy, when it works", async () => {
  setForceLocalFallback(false);
  const { db, calls } = fakeRealDb();
  const h = new HybridFirestore(db);
  assert.equal(await h.collection("projects").doc("A").set({ big: "x".repeat(1000) }), true);
  assert.equal(await h.collection("projects").doc("A").update({ n: 1 }), true);
  assert.deepEqual(calls, ["set", "update"]);
  assert.equal(fs.existsSync(projectsFile), false, "local file must not be written while the real DB works");
});

test("a failed real write falls back to the local copy so it isn't lost", async () => {
  setForceLocalFallback(false);
  const { db } = fakeRealDb({ failWith: new Error("boom") });
  const h = new HybridFirestore(db);
  assert.equal(await h.collection("projects").doc("B").set({ name: "kept" }), true);
  const saved = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  assert.equal(saved.B.name, "kept");
});

test("with no real database, writes use the local copy", async () => {
  setForceLocalFallback(true);
  const h = new HybridFirestore(null);
  await h.collection("projects").doc("C").set({ name: "local" });
  const snap = await h.collection("projects").doc("C").get();
  assert.equal(snap.data().name, "local");
});

test("select() is accepted on queries and ignored locally", async () => {
  setForceLocalFallback(true);
  const h = new HybridFirestore(null);
  const snap = await h.collection("projects").where("name", "==", "local").select("name").limit(5).get();
  assert.equal(snap.docs.length, 1);
});

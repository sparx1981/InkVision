// Server regression tests: run with `npm run test:server`.
// Starts the real Express app (Firebase stubbed, Gemini never called) in a temp
// directory and checks auth gating, ownership, likes, validation and rate limits.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkvision-qa-"));
const bundle = path.join(__dirname, ".out/server.cjs");
process.chdir(tmp); // the local fallback DB writes db_fallback_*.json into the cwd
process.env.VERCEL = "1"; // don't start the Vite dev server / listen on :3000
process.env.NODE_ENV = "test";
fs.writeFileSync(
  "db_fallback_portfolio.json",
  JSON.stringify({ "pf-1": { id: "pf-1", imageUrl: "data:image/png;base64,AAAA", name: "d", likes: 0, createdAt: new Date().toISOString() } })
);
const app = require(bundle).default;
const srv = app.listen(3111, async () => {
  const B = "http://localhost:3111";
  let pass = 0, fail = 0;
  const t = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + extra}`); };
  const call = async (method, path, { token, body, headers } = {}) => {
    const r = await fetch(B + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    let j = null; try { j = await r.json(); } catch {} return { s: r.status, j, h: r.headers };
  };
  const alice = "alice|alice@x.com|1", bob = "bob|bob@x.com|1";
  const img = "data:image/png;base64,AAAA";

  // --- AI routes need auth
  for (const [m, p] of [["POST","/api/analyze-tattoo"],["POST","/api/composite-photorealistic"],["POST","/api/verify-tattoo-result"],["POST","/api/suggest-tattoo-ideas"],["POST","/api/generate-reference-sheet"],["POST","/api/generate-tattoo-design"]]) {
    const r = await call(m, p, { body: {} }); t(`${p} without token -> 401`, r.s === 401, r.s);
  }
  // dead route gone
  t("detect-skin-regions removed (no 200/400 handler)", (await call("POST","/api/detect-skin-regions",{token:alice,body:{}})).s === 404);
  // with token validation still runs (400 for missing inputs)
  t("analyze with token, empty body -> 400 validation", (await call("POST","/api/analyze-tattoo",{token:alice,body:{}})).s === 400);
  // bad mime -> 400 not 500 (no gemini key => key check hits first; set fake key)
  process.env.GEMINI_API_KEY = "fake-key-for-test";
  const bm = await call("POST","/api/analyze-tattoo",{token:alice,body:{images:["data:text/html;base64,PHNjcmlwdD4="]}});
  t("non-image data URL -> 400", bm.s === 400 && /Unsupported image type/.test(bm.j?.error||""), JSON.stringify(bm));
  const bm2 = await call("POST","/api/analyze-tattoo",{token:alice,body:{images:["not a data url"]}});
  t("malformed data URL -> 400", bm2.s === 400, JSON.stringify(bm2));
  // malformed JSON -> clean message
  const bj = await call("POST","/api/analyze-tattoo",{token:alice,body:"{bad"});
  t("bad JSON -> 400 generic", bj.s === 400 && bj.j.error === "The request body wasn't valid JSON.", JSON.stringify(bj));
  // body limit on non-project route: 30MB
  const big = '{"images":["data:image/png;base64,' + "A".repeat(30_000_000) + '"]}';
  const bl = await call("POST","/api/analyze-tattoo",{token:alice,body:big});
  t("30MB body on AI route -> 413", bl.s === 413, bl.s);

  // --- projects
  const a1 = await call("POST","/api/projects",{token:alice,body:{name:"A"}});
  t("alice saves -> code", a1.s === 200 && /^[A-HJ-NP-Z2-9]{6}$/.test(a1.j.code), JSON.stringify(a1.j));
  t("save response hides ownerUid", a1.j && !("ownerUid" in a1.j.project));
  const code = a1.j.code;
  const bo = await call("POST","/api/projects",{token:bob,body:{code,name:"HIJACK"}});
  t("bob can't overwrite alice's project -> 403", bo.s === 403 && bo.j.code === "PROJECT_OWNED", JSON.stringify(bo));
  const an = await call("POST","/api/projects",{body:{code,name:"HIJACK"}});
  t("anonymous can't overwrite alice's project -> 403", an.s === 403, an.s);
  const al = await call("POST","/api/projects",{token:alice,body:{code,name:"A2"}});
  t("alice can overwrite own, same code", al.s === 200 && al.j.code === code && al.j.project.name === "A2", JSON.stringify(al.j));
  const ld = await call("GET","/api/projects/"+code.toLowerCase());
  t("load (lowercase code ok), name A2, no ownerUid", ld.s === 200 && ld.j.project.name === "A2" && !("ownerUid" in ld.j.project), JSON.stringify(ld.j));
  t("invalid code format -> 404", (await call("GET","/api/projects/..%2Fusers")).s === 404);
  t("invalid code (short) -> 404", (await call("GET","/api/projects/ABC")).s === 404);
  const anon = await call("POST","/api/projects",{body:{name:"anon"}});
  const anonCode = anon.j.code;
  const anon2 = await call("POST","/api/projects",{body:{code:anonCode,name:"anon-edit"}});
  t("anonymous project stays editable by code holder", anon2.s === 200 && anon2.j.project.name === "anon-edit");
  const claim = await call("POST","/api/projects",{token:bob,body:{code:anonCode,name:"bob-claims"}});
  t("signed-in save over anon project claims it", claim.s === 200);
  const after = await call("POST","/api/projects",{body:{code:anonCode,name:"nope"}});
  t("claimed project now locked to anon", after.s === 403, after.s);
  const unknown = await call("POST","/api/projects",{body:{code:"ZZZZZZ",name:"x"}});
  t("unknown client-chosen code is not honoured", unknown.s === 200 && unknown.j.code !== "ZZZZZZ", JSON.stringify(unknown.j));
  const mine = await call("GET","/api/my-projects",{token:alice});
  t("my-projects lists alice's", mine.s === 200 && mine.j.projects.some(p=>p.code===code), JSON.stringify(mine.j));

  // --- portfolio likes
  const lk0 = await call("POST","/api/portfolio/pf-1/like");
  t("like without token -> 401", lk0.s === 401);
  const lk1 = await call("POST","/api/portfolio/pf-1/like",{token:alice});
  t("first like counts", lk1.s === 200 && lk1.j.item.likes === 1 && lk1.j.alreadyLiked === false, JSON.stringify(lk1.j));
  const lk2 = await call("POST","/api/portfolio/pf-1/like",{token:alice});
  t("repeat like by same user is a no-op", lk2.s === 200 && lk2.j.item.likes === 1 && lk2.j.alreadyLiked === true, JSON.stringify(lk2.j));
  const lk3 = await call("POST","/api/portfolio/pf-1/like",{token:bob});
  t("different user adds a like", lk3.j.item.likes === 2);
  t("like response hides likedBy", !("likedBy" in lk3.j.item));
  const pl = await call("GET","/api/portfolio");
  t("portfolio list hides likedBy, shows likes=2", pl.s === 200 && pl.j.items[0].likes === 2 && !("likedBy" in pl.j.items[0]), JSON.stringify(pl.j));
  t("like unknown design -> 404", (await call("POST","/api/portfolio/nope/like",{token:alice})).s === 404);

  // --- CPU guards: cheap rejections and caching
  const bigNoToken = '{"images":["data:image/png;base64,' + "A".repeat(20_000_000) + '"]}';
  const rj = await call("POST","/api/composite-photorealistic",{body:bigNoToken});
  t("20MB body, no token -> 401 without parsing it (not 413/400)", rj.s === 401, rj.s);
  t("like without Authorization header -> 401 pre-parse", (await call("POST","/api/portfolio/pf-1/like",{body:{}})).s === 401);
  t("portfolio list is CDN-cacheable", /s-maxage=300/.test(pl.h.get("cache-control") || ""), pl.h.get("cache-control"));
  const pl2 = await call("GET","/api/portfolio");
  t("portfolio list served consistently from cache", pl2.s === 200 && pl2.j.items[0].likes === 2);
  const lk4 = await call("POST","/api/portfolio/pf-1/like",{token:"carol|c@x.com|1"});
  const pl3 = await call("GET","/api/portfolio");
  t("a new like invalidates the cached list", lk4.s === 200 && pl3.j.items[0].likes === 3, JSON.stringify(pl3.j));
  const eu = await call("POST","/api/ensure-user",{token:alice});
  t("ensure-user also returns the profile (one request per page load)", eu.s === 200 && eu.j.profile && eu.j.profile.tier === "free" && eu.j.profile.generationLimit === 1, JSON.stringify(eu.j));
  const withThumb = await call("POST","/api/projects",{token:alice,body:{name:"thumbed",thumbnail:"data:image/jpeg;base64,/9j/AAAA",basePhotos:[{src:"data:image/jpeg;base64,"+"B".repeat(50000)}]}});
  const list = await call("GET","/api/my-projects",{token:alice});
  const row = list.j.projects.find(p => p.code === withThumb.j.code);
  t("project list returns the thumbnail", !!row && row.thumbnail === "data:image/jpeg;base64,/9j/AAAA", JSON.stringify(row));
  t("project list rows carry no photos", row && !("basePhotos" in row));

  // --- admin promotion needs a verified email
  const unv = await call("POST","/api/ensure-user",{token:"mal|craigtrickett@gmail.com|0"});
  t("unverified admin-email account is NOT admin", unv.s === 200 && unv.j.user.role === "consumer", JSON.stringify(unv.j));
  const ver = await call("POST","/api/ensure-user",{token:"craig|craigtrickett@gmail.com|1"});
  t("verified admin-email account IS admin", ver.s === 200 && ver.j.user.role === "admin", JSON.stringify(ver.j));
  const craig = "craig|craigtrickett@gmail.com|1";
  const pr = await call("PATCH","/api/admin/users/alice",{token:craig,body:{role:"superuser"}});
  t("admin PATCH rejects unknown role -> 400", pr.s === 400, JSON.stringify(pr));
  const pt = await call("PATCH","/api/admin/users/alice",{token:craig,body:{tier:"enterprise"}});
  t("admin PATCH rejects unknown tier -> 400", pt.s === 400);
  const na = await call("GET","/api/admin/users",{token:alice});
  t("non-admin can't list users -> 403", na.s === 403 || na.s === 404 || na.s === 500, na.s);

  // --- rate limits (last: they use up this client's buckets)
  let last; for (let i = 0; i < 32; i++) last = await call("GET","/api/projects/ABCDEF");
  t("project lookup rate-limited with Retry-After", last.s === 429 && !!last.h.get("retry-after"), last.s);
  let l2; for (let i = 0; i < 22; i++) l2 = await call("POST","/api/analyze-tattoo",{token:"rate|r@x.com|1",body:{}});
  t("AI route rate-limited per user", l2.s === 429, l2.s);
  t("other user unaffected by that limit", (await call("POST","/api/analyze-tattoo",{token:alice,body:{}})).s === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0); });
});

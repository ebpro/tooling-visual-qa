#!/usr/bin/env node
/**
 * Selftest — runs the ported checker over fixtures/ and asserts per-page expectations:
 *   - each defects/ page produces EXACTLY its expected check id(s)
 *   - clean/ pages produce zero violations
 *   - the legit scroller is soft-tagged in scrollers.jsonl (NOT in violations)
 *   - every violation row references an existing screenshot PNG
 * Slide (Reveal-CDN) fixtures are SKIPPED (with a warning) when jsdelivr is unreachable.
 * Exits 0 (all green) / 1 (failures), printing a PASS/FAIL table.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./src/runner.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ROOT, "fixtures");
const REVEAL_CDN_PROBE = "https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js";

// pageKey (relative path under fixtures/) → expected violation check-id set
const EXPECT = {
  "defects/overflow-scrollbox.html": ["overflow.scrollbox"],
  "defects/slide-overflow.html": ["overflow.slide-viewport"],
  "defects/broken-image.html": ["image.broken", "link.deadref", "subresource.failed"], // 404 img = all three rows (deadref: DOM scan finds the missing src)
  "defects/mermaid-error.html": ["mermaid.resolution"],
  "defects/blank-slide.html": ["slide.blank"],
  "defects/deadref.html": ["link.deadref", "subresource.failed"], // 3 deadref rows; script/link 404s emit companion subresource.failed (explicitly tolerated)
  "defects/overflow-mjx.html": ["overflow.scrollbox"], // v0.1.3: mjx boxes pruned by rule 1; only the plain div row may remain (count-checked below)
  "defects/prune-sibling.html": ["image.broken", "link.deadref", "subresource.failed"], // v0.1.3: sibling of prune_files/ — must still be scanned
  "clean/clean.html": [],        // scroller must land in scrollers.jsonl instead; subdir/ dir link must NOT deadref
  "clean/clean-deck.html": [],
  "clean/subdir/index.html": [],
};
const SLIDE_PAGES = ["defects/slide-overflow.html", "defects/blank-slide.html", "clean/clean-deck.html"];

async function cdnReachable() {
  try {
    const r = await fetch(REVEAL_CDN_PROBE, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function main({ out } = {}) {
  const OUT = path.resolve(out || path.join(ROOT, "out-selftest"));
  const cdn = await cdnReachable();
  if (!cdn) console.warn("WARNING: reveal.js CDN unreachable — slide fixtures will be SKIPPED.");

  const summary = await runCheck({ site: FIXTURES, out: OUT, mode: "selftest" });

  const violations = fs.existsSync(path.join(OUT, "violations.jsonl"))
    ? fs.readFileSync(path.join(OUT, "violations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const scrollers = fs.existsSync(path.join(OUT, "scrollers.jsonl"))
    ? fs.readFileSync(path.join(OUT, "scrollers.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const key = (u) => new URL(u).pathname.replace(/^\/+/, "");
  const byPage = {};
  for (const v of violations) (byPage[key(v.page)] ??= []).push(v);

  const rows = []; // {page, status, note}
  const skip = (p, note) => rows.push({ page: p, status: "SKIP", note });
  const verdict = (p, ok, note) => rows.push({ page: p, status: ok ? "PASS" : "FAIL", note: note || "" });

  // load-error guard
  const loadErrs = violations.filter((v) => v.check === "load-error");
  if (loadErrs.length) console.warn("WARNING: load-error rows:", JSON.stringify(loadErrs, null, 2));

  for (const [p, expected] of Object.entries(EXPECT)) {
    if (!cdn && SLIDE_PAGES.includes(p)) { skip(p, "CDN unreachable"); continue; }
    const found = byPage[p] || [];
    const got = [...new Set(found.map((v) => v.check))].sort();
    const want = [...expected].sort();
    const same = got.length === want.length && got.every((c, i) => c === want[i]);
    verdict(p, same && !found.some((v) => v.check === "load-error"),
      same ? `${want.length ? want.join(",") : "no violations"} (${found.length} row(s))` : `expected [${want}] got [${got}]`);
    if (p === "clean/clean.html") {
      const sc = scrollers.filter((s) => key(s.page) === p);
      verdict("clean/clean.html:scroller-tagged", sc.length >= 1, `scrollers.jsonl rows: ${sc.length}`);
    }
  }
  // no violations from unexpected pages
  const unexpected = Object.keys(byPage).filter((p) => !(p in EXPECT));
  verdict("no-unexpected-pages", unexpected.length === 0, unexpected.join(","));
  // deadref specifics: defects/deadref.html → exactly 3 link.deadref rows (nope.html dom, missing.js, ghost.css);
  // clean pages → zero link.deadref rows.
  const dr = (byPage["defects/deadref.html"] || []).filter((v) => v.check === "link.deadref");
  const drTargets = dr.map((v) => v.detail.match(/target=([^ ]+)/)?.[1]).sort().join(",");
  verdict("deadref:3-rows", dr.length === 3 && drTargets === "/defects/ghost.css,/defects/missing.js,/defects/nope.html",
    `${dr.length} row(s) targets=[${drTargets}] sources=[${dr.map((v) => v.detail.match(/source=(\w+)/)?.[1]).join(",")}]`);
  const drClean = violations.filter((v) => v.check === "link.deadref" && ["clean/clean.html", "clean/clean-deck.html", "clean/subdir/index.html"].includes(key(v.page)));
  verdict("deadref:clean-zero", drClean.length === 0, drClean.map((v) => `${key(v.page)} ${v.detail}`).join(" | ") || "0 row(s)");
  // v0.1.3 rule 1: on defects/overflow-mjx.html exactly ONE scrollbox row — the planted
  // plain div — and no scrollbox row anywhere carries an mjx selector (MathJax exclusion).
  const mjxRows = (byPage["defects/overflow-mjx.html"] || []).filter((v) => v.check === "overflow.scrollbox");
  verdict("overflow-mjx:1-row-plain-only",
    mjxRows.length === 1 && mjxRows[0].selector.includes("#plain-scroller") && !mjxRows[0].selector.includes("mjx"),
    `${mjxRows.length} row(s) selectors=[${mjxRows.map((v) => v.selector).join(" ")}]`);
  const anyMjx = violations.filter((v) => v.check === "overflow.scrollbox" && /mjx/i.test(v.selector)).length;
  verdict("overflow-mjx:no-mjx-rows-corpus", anyMjx === 0, `${anyMjx} mjx-selector scrollbox row(s)`);
  // v0.1.3 rule 2: no page under a *_files directory segment may enter the walk,
  // while the sibling planted page in the same directory IS scanned (see EXPECT row).
  const walked = summary.pages.some((p) => key(p.url || p.page).startsWith("defects/prune_files/"));
  const siblingScanned = summary.pages.some((p) => key(p.url || p.page) === "defects/prune-sibling.html");
  verdict("_files-dir-not-scanned", !walked && siblingScanned,
    `prune_files walked=${walked}, prune-sibling scanned=${siblingScanned}`);
  // every violation row has an existing screenshot file
  const badShots = violations.filter((v) => !v.screenshot || !fs.existsSync(path.join(OUT, v.screenshot)) || fs.statSync(path.join(OUT, v.screenshot)).size === 0);
  verdict("all-rows-have-screenshots", badShots.length === 0,
    badShots.length ? badShots.map((v) => `${key(v.page)}:${v.check}=${v.screenshot}`).join(" | ") : `${violations.length} row(s)`);

  // ---- table ----
  const w = Math.max(...rows.map((r) => r.page.length)) + 2;
  console.log("\n" + "PAGE".padEnd(w) + "RESULT  NOTE");
  console.log("-".repeat(w + 8 + 40));
  for (const r of rows) console.log(r.page.padEnd(w) + r.status.padEnd(8) + r.note);
  const failed = rows.filter((r) => r.status === "FAIL");
  console.log(`\n${rows.filter((r) => r.status === "PASS").length} PASS / ${failed.length} FAIL / ${rows.filter((r) => r.status === "SKIP").length} SKIP` +
    ` | pages checked: ${summary.pages.length}, total violations: ${summary.totals.violations}, scrollers: ${scrollers.length}, duration: ${summary.durationSec}s`);
  console.log(`out: ${OUT}`);
  if (failed.length) { console.log("FAILED: " + failed.map((f) => f.page + " — " + f.note).join(" ; ")); return 1; }
  console.log(cdn ? "SELFTEST: PASS" : "SELFTEST: PASS (slide fixtures skipped — CDN unreachable)");
  return 0;
}

// direct-run entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.normalize(fs.realpathSync(process.argv[1]))) {
  const outIdx = process.argv.indexOf("--out");
  process.exitCode = await main({ out: outIdx >= 0 ? process.argv[outIdx + 1] : undefined });
}

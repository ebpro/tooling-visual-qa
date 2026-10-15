/**
 * Runner — ported from tier1-poc/checker.js (runPage + main block).
 * Serves the site with `python3 -m http.server` on a free port (unless --url is given),
 * walks pages, runs the ported checks in the POC's execution order, and writes
 * violations.jsonl / scrollers.jsonl / summary.json / shots/ into --out.
 *
 * Deviation from the POC (documented): page listing is a RECURSIVE walk of *.html under
 * --site (the POC expected a rendered-Quarto site layout: root notes + _slides/ decks).
 * Listing still tags a page "slides" when its path contains a `_slides/` segment;
 * regardless of the listing tag, the deck-vs-document flow is decided at runtime by the
 * presence of window.Reveal on the loaded page — which is the authoritative signal.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import * as mermaidChecks from "./checks/mermaid.mjs";
import * as overflowChecks from "./checks/overflow.mjs";
import * as imageChecks from "./checks/images.mjs";
import * as blankChecks from "./checks/blanks.mjs";
import * as deadrefChecks from "./checks/deadref.mjs";

const SETTLE_MS = 900; // mermaid renders on window 'load' (POC)

function rel(u) { return u.replace(/^\/+/, "") || "index.html"; }
function pageKey(u) { return rel(new URL(u).pathname); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/**
 * Browser launch options, env-driven (v0.1.2, for CI container runs):
 *   VQA_EXECUTABLE_PATH — absolute path to a Chromium-compatible binary
 *     (e.g. /usr/local/bin/chrome-headless-shell inside the solen image).
 *     Unset -> Playwright's own browser resolution (local dev behaviour unchanged).
 *   VQA_BROWSER_ARGS  — comma-separated extra Chromium args
 *     (e.g. "--no-sandbox,--disable-dev-shm-usage" when running as root).
 */
function launchOptions() {
  const opts = {};
  if (process.env.VQA_EXECUTABLE_PATH) opts.executablePath = process.env.VQA_EXECUTABLE_PATH;
  const extra = (process.env.VQA_BROWSER_ARGS || "").split(",").map((a) => a.trim()).filter(Boolean);
  if (extra.length) opts.args = extra;
  return opts;
}

async function startServer(siteDir) {
  const port = await freePort();
  const proc = spawn("python3", ["-m", "http.server", String(port), "--directory", siteDir], {
    stdio: "ignore", detached: false,
  });
  const base = `http://127.0.0.1:${port}`;
  // poll until the server answers (POC slept 1s; polling is deterministic)
  const deadline = Date.now() + 10000;
  for (;;) {
    try { const r = await fetch(base + "/"); if (r.status < 500) break; } catch {}
    if (Date.now() > deadline) { proc.kill("SIGKILL"); throw new Error("static server did not come up on " + base); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    stop() { try { proc.kill("SIGKILL"); } catch {} },
  };
}

function listPages(site, base, filterRe) {
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // v0.1.3 pre-S2 tuning: Quarto saves per-deck asset trees as <deck>_files/
        // (vendored revealjs libs incl. speaker-view.html). DIRECTORY segments only.
        // Corpus evidence (M1-verify): 19+2 such pages scanned on DEV-ADV/sample,
        // 0 violations produced — pure runtime cost, no signal. Prune the subtree.
        if (ent.name.endsWith("_files")) continue;
        walk(full);
      }
      else if (ent.name.endsWith(".html")) {
        const relPath = path.relative(site, full).split(path.sep).join("/");
        out.push({
          type: relPath.split("/").includes("_slides") ? "slides" : "notes",
          name: ent.name, relPath,
          url: `${base}/${relPath.split("/").map(encodeURIComponent).join("/")}`,
        });
      }
    }
  })(site);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return filterRe ? out.filter((p) => filterRe.test(p.name) || filterRe.test(p.relPath)) : out;
}

/**
 * Run the visual-QA check over a site directory.
 * opts: { site, url?, filter?, out, mode? }  → writes <out>/{violations,scrollers}.jsonl,
 * <out>/summary.json, <out>/shots/*.png; returns the summary object.
 */
export async function runCheck(opts) {
  const SITE = path.resolve(opts.site);
  const OUT = path.resolve(opts.out);
  const MODE = opts.mode || "check";
  const SHOTS = path.join(OUT, "shots");
  fs.rmSync(SHOTS, { recursive: true, force: true }); // stale shots must not outlive their violations
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = opts.url ? null : await startServer(SITE);
  const BASE = (opts.url || server.base).replace(/\/$/, "");

  const violations = [];
  const scrollers = [];
  const summary = { mode: MODE, pages: [], totals: {} };
  const t0 = Date.now();
  const state = { vId: 0 }; // in-page marker id counter (POC module-global)
  const addViolation = (v) => { violations.push(v); return v; };

  async function shot(page, url, tag, cssSel) {
    const name = `${pageKey(url).replace(/[^a-zA-Z0-9._-]/g, "_")}__${tag}.png`;
    const file = path.join(SHOTS, name);
    try {
      if (cssSel) {
        const h = page.locator(`[data-vqa-id="${cssSel}"]`).first();
        if (await h.count()) {
          await h.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          await h.screenshot({ path: file, timeout: 4000 }).catch(async () => { await page.screenshot({ path: file }); });
          return "shots/" + name;
        }
      }
      await page.screenshot({ path: file });
      return "shots/" + name;
    } catch (e) {
      return "SHOT-FAILED:" + e.message.slice(0, 80);
    }
  }

  async function runPage(browser, pg) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const failed = imageChecks.watchSubresources(page, BASE);
    const session = {
      page, url: pg.url, BASE, SITE, addViolation, violations, scrollers, shot,
      get vId() { return state.vId; }, set vId(v) { state.vId = v; },
    };
    const rec = { page: pg.url, type: pg.type, mermaid: null, violations: 0 };
    const before = violations.length;
    try {
      await page.goto(pg.url, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(SETTLE_MS);

      rec.mermaid = await mermaidChecks.checkMermaid(session);
      await imageChecks.checkImgs(session);

      // Deck vs document flow — runtime Reveal presence is authoritative.
      const isDeck = await page.evaluate(() => !!window.Reveal && typeof window.Reveal.slide === "function");
      if (isDeck) {
        rec.type = "slides";
        await page.waitForFunction(() => window.Reveal && Reveal.isReady && Reveal.isReady(), null, { timeout: 15000 }).catch(() => {});
        const cfg = await page.evaluate(() => (window.Reveal ? { width: Reveal.getConfig().width, height: Reveal.getConfig().height } : null));
        const dims = await page.evaluate(() => ({
          h: Reveal.getHorizontalSlides().length,
          v: Reveal.getHorizontalSlides().map((s) => s.querySelectorAll("section").length),
          total: Reveal.getTotalSlides(),
        }));
        rec.slides = dims.total;
        const seenIdx = new Set();
        for (let h = 0; h < dims.h; h++) {
          const vCount = Math.max(1, dims.v[h] || 1);
          for (let v = 0; v < vCount; v++) {
            await page.evaluate(({ h, v }) => Reveal.slide(h, v, 0), { h, v });
            await page.waitForTimeout(80);
            const idx = await page.evaluate(() => { const i = Reveal.getIndices(); return `${i.h},${i.v}`; });
            if (seenIdx.has(idx)) continue; // clamped duplicates
            seenIdx.add(idx);
            const [ih, iv] = idx.split(",").map(Number);
            // blank check on arrival (before fragments)
            await blankChecks.checkBlankOnArrival(session, ih, iv);
            // walk fragments to end-state, then overflow + svg-size checks
            await page.evaluate(async () => {
              for (let i = 0; i < 100 && Reveal.nextFragment(); i++) await new Promise((r) => setTimeout(r, 5));
            });
            await page.waitForTimeout(80);
            const defects = await overflowChecks.checkOverflowInPage(session, { scope: "deck", viewport: cfg });
            await overflowChecks.attachDeckOverflowShots(session, defects, `slide${ih}-${iv}`);
            await mermaidChecks.checkZeroSizeSvgsDeck(session, ih, iv);
          }
        }
      } else {
        // notes: whole-document overflow + visible svg zero-size
        const defects = await overflowChecks.checkOverflowInPage(session, { scope: "doc", viewport: null });
        await overflowChecks.attachDocOverflowShots(session, defects);
        await mermaidChecks.checkZeroSizeSvgsDoc(session);
      }

      // failed subresources (dedup)
      await imageChecks.reportFailedSubresources(session, failed);
      // mermaid violation screenshots (element clip where still in DOM)
      await mermaidChecks.attachMermaidShots(session, before);
      // dead same-origin refs (DOM scan authoritative for <a href>; response-404s deduped in).
      // Runs LAST so its data-vqa-id=REF<n> tagging cannot disturb earlier evidence clips.
      await deadrefChecks.checkDeadrefs(session, failed);
    } catch (e) {
      rec.error = String(e).slice(0, 200);
      addViolation({ page: pg.url, check: "load-error", selector: "-", detail: rec.error, screenshot: null });
    }
    rec.violations = violations.length - before;
    summary.pages.push(rec);
    await page.close();
  }

  try {
    const pages = listPages(SITE, BASE, opts.filter ? new RegExp(opts.filter) : null);
    const browser = await chromium.launch(launchOptions());
    for (const pg of pages) await runPage(browser, pg);
    await browser.close();
  } finally {
    if (server) server.stop();
  }

  const byCheck = {};
  for (const v of violations) byCheck[v.check] = (byCheck[v.check] || 0) + 1;
  const byCheckType = {};
  for (const v of violations) {
    const t = pageKey(v.page).split("/").includes("_slides") ? "slides" : "notes";
    byCheckType[`${v.check}/${t}`] = (byCheckType[`${v.check}/${t}`] || 0) + 1;
  }
  summary.totals = { violations: violations.length, byCheck, byCheckAndPageType: byCheckType, intentionalScrollers: scrollers.length };
  summary.mermaidExamined = summary.pages.reduce((a, p) => a + (p.mermaid ? p.mermaid.leftover + p.mermaid.rendered : 0), 0);
  summary.durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(OUT, "violations.jsonl"), violations.map((v) => { const { id, ...rest } = v; return JSON.stringify(rest); }).join("\n") + (violations.length ? "\n" : ""));
  fs.writeFileSync(path.join(OUT, "scrollers.jsonl"), scrollers.map((s) => JSON.stringify(s)).join("\n") + (scrollers.length ? "\n" : ""));
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

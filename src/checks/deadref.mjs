/**
 * link.deadref — same-origin references whose target is absent from the served tree.
 *
 * Two evidence sources, deduped per (page, resolved target path):
 *   source=dom       : DOM scan of <a href> / <img src> / <script src> / <link href>.
 *                      Authoritative for <a href>, which browsers never fetch.
 *   source=response  : entries from the shared response-404 listener (images.watchSubresources)
 *                      with status === 404 — covers fetched assets even if the DOM mutated.
 *
 * False-positive guards (per demand-audit subtleties):
 *   - skip external/other-origin, mailto:, data:, javascript:, tel:, pure #fragments
 *   - query strings and fragments are dropped before the fs lookup (URL.pathname never has them)
 *   - percent-encoding is decoded before the fs lookup
 *   - trailing-slash directory links resolve against <dir>/index.html, falling back to the
 *     directory itself (python http.server answers 200 for a bare directory via listing)
 *   - a plain path that exists as a directory is considered reachable (server 301s to listing)
 */
import fs from "node:fs";
import path from "node:path";

export const REFS = [
  ["a", "href"],
  ["img", "src"],
  ["script", "src"],
  ["link", "href"],
];

/** Non-fetchable / out-of-scope shapes, checked on the RAW attribute value. */
function skipRaw(raw) {
  if (!raw || /^[#?]/.test(raw)) return true; // fragment-only or query-only → resolves to this page
  if (/^(?:https?:|mailto:|data:|javascript:|tel:|about:|blob:|ftp:|file:)/i.test(raw)) return true;
  return false;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a raw attribute value against the page URL and the served tree rooted at SITE.
 * Returns { targetPath, fsPath, reachable } or null when out of scope (external / skipped).
 */
export function resolveRef(SITE, BASE, pageUrl, raw) {
  if (skipRaw(raw)) return null;
  let u;
  try {
    u = new URL(raw, pageUrl);
  } catch {
    return null; // unparseable — not our business here
  }
  if (u.origin !== new URL(BASE).origin) return null;
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    p = u.pathname; // malformed escapes: keep encoded form, likely absent → real deadref
  }
  const fsPath = path.resolve(SITE, "." + p);
  let reachable;
  if (p.endsWith("/")) {
    reachable = fs.existsSync(path.join(fsPath, "index.html")) || isDir(fsPath);
  } else {
    reachable = fs.existsSync(fsPath) || isDir(fsPath); // dir w/o trailing slash → server 301s to listing
  }
  return { targetPath: p, fsPath, reachable };
}

/** Collect same-origin refs from the DOM, tagging each element with data-vqa-id=REF<n> for evidence clips. */
async function collectDomRefs(page) {
  return page.evaluate((REFS) => {
    const out = [];
    let n = 0;
    for (const [tag, attr] of REFS) {
      for (const el of document.querySelectorAll(tag)) {
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        out.push({ tag, attr, raw, vqa: "REF" + ++n });
        el.setAttribute("data-vqa-id", "REF" + n); // last writer wins on duplicates; harmless for shots
      }
    }
    return out;
  }, REFS);
}

/** DOM scan + response-404 merge, deduped per (page, targetPath). Rows carry source=dom|response. */
export async function checkDeadrefs(session, failed) {
  const { page, url, BASE, SITE, addViolation, shot } = session;
  const seen = new Set(); // dedupe key: page + resolved target path (one row per pair)
  const rows = []; // this page's deadref violations, in add order (for screenshot attachment)
  const domRefs = await collectDomRefs(page);

  for (const r of domRefs) {
    const res = resolveRef(SITE, BASE, url, r.raw);
    if (!res || res.reachable || seen.has(res.targetPath)) continue;
    seen.add(res.targetPath);
    const v = addViolation({
      page: url, check: "link.deadref", selector: `${r.tag}[${r.attr}="${r.raw}"]`,
      detail: `missing target=${res.targetPath} source=dom`, screenshot: null,
    });
    v._vqa = r.vqa; // transient element-clip marker; deleted before jsonl serialization below
    rows.push(v);
  }

  // Response-404 evidence (fetched assets), deduped against the DOM rows.
  for (const f of failed || []) {
    if (f.status !== 404) continue;
    const res = resolveRef(SITE, BASE, url, f.url);
    if (!res || res.reachable || seen.has(res.targetPath)) continue;
    seen.add(res.targetPath);
    rows.push(addViolation({
      page: url, check: "link.deadref", selector: res.targetPath,
      detail: `missing target=${res.targetPath} source=response`, screenshot: null,
    }));
  }

  // Evidence screenshots (POC pattern): element clip via data-vqa-id for dom rows, page shot for the rest.
  for (let i = 0; i < rows.length; i++) {
    rows[i].screenshot = await shot(page, url, `deadref_${i + 1}`, rows[i]._vqa);
    delete rows[i]._vqa; // keep the jsonl schema clean ({page,check,selector,detail,screenshot})
  }
  return rows.length;
}

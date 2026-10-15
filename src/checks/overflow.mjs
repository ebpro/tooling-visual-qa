/**
 * Overflow checks — ported faithfully from tier1-poc/checker.js checkOverflowInPage.
 *   - overflow.scrollbox      : scrollWidth/Height > clientWidth/Height + 2px on visible elements
 *                               (transform-immunity: scroll metrics are layout-space, not affected
 *                               by the Reveal stage scale matrix — POC empirical finding #3).
 *   - overflow.slide-viewport : leaf reveal section content box vs Reveal configured viewport.
 * Soft-tagging: elements that are themselves overflow:auto/scroll go to scrollers.jsonl
 * (intentional), elements absorbed by an ancestor axis-scroller are skipped entirely.
 */
export const EPSILON_PX = 2; // POC epsilon

/**
 * Run the overflow evaluation inside the page (POC checkOverflowInPage, verbatim logic).
 * session: { page, url, violations, scrollers, addViolation, vId }
 * opts: { scope: 'deck' | 'doc', viewport: {width,height} | null }
 * Returns the defect list (with vqaId); violations rows are already appended.
 */
export async function checkOverflowInPage(session, opts) {
  const { page, url, violations, scrollers, addViolation } = session;
  const added = await page.evaluate(({ scope, viewport, startId, eps }) => {
    function hasAxisScroller(el, axis) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const ov = axis === "x" ? cs.overflowX : cs.overflowY;
        if (ov === "auto" || ov === "scroll") return a;
      }
      return null;
    }
    function isSelfScroller(el, axis) {
      const cs = getComputedStyle(el);
      const ov = axis === "x" ? cs.overflowX : cs.overflowY;
      return ov === "auto" || ov === "scroll";
    }
    const out = { defects: [], intentional: [] };
    let roots;
    if (scope === "deck") {
      const present = [...document.querySelectorAll(".reveal .slides section.present")];
      roots = present.length ? [present[present.length - 1]] : []; // deepest = leaf slide
    } else {
      roots = [document.body];
    }
    const els = [];
    for (const r0 of roots) els.push(r0, ...r0.querySelectorAll("*"));
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.display === "inline") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el === document.documentElement || el === document.body) continue;
      // v0.1.3 pre-S2 tuning (M1-verify evidence, DEV-ADV): MathJax v3 builds its
      // equation layout from internal boxes (<mjx-container> and its mjx-* children)
      // that carry tiny intentional overflow (scrollWidth>clientWidth glyph boxes);
      // ~716/743 scrollbox rows on a real course site were mjx noise, none actionable.
      // Exclude any candidate whose tagName is an mjx-* custom element OR that has an
      // mjx-container ancestor (covers plain wrapper divs MathJax nests inside formulas).
      if (el.tagName.startsWith("MJX-") || el.closest("mjx-container")) continue;
      const ox = el.scrollWidth - el.clientWidth > eps;
      const oy = el.scrollHeight - el.clientHeight > eps;
      if (!ox && !oy) continue;
      const sel = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
        (el.className && typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
      for (const [axis, over] of [["x", ox], ["y", oy]]) {
        if (!over) continue;
        const px = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
        if (isSelfScroller(el, axis)) {
          out.intentional.push({ selector: sel, axis, overflowPx: px, why: "self overflow:" + (axis === "x" ? cs.overflowX : cs.overflowY) });
        } else if (hasAxisScroller(el, axis)) {
          // absorbed by an intentional ancestor scroller — not a defect
        } else {
          const id = startId + out.defects.length;
          el.setAttribute("data-vqa-id", String(id));
          out.defects.push({
            kind: "scrollbox", selector: sel, axis, overflowPx: px,
            rect: { w: Math.round(r.width), h: Math.round(r.height) }, vqaId: id,
          });
        }
      }
    }
    // deck: leaf-slide content box vs Reveal configured viewport
    if (viewport) {
      for (const sec of roots) {
        const dx = sec.scrollWidth - viewport.width;
        const dy = sec.scrollHeight - viewport.height;
        if (dx > eps || dy > eps) {
          const id = startId + 100000 + out.defects.length;
          sec.setAttribute("data-vqa-id", String(id));
          out.defects.push({
            kind: "slide-viewport",
            selector: "leaf-section vs Reveal viewport " + viewport.width + "x" + viewport.height,
            axis: dy > dx ? "y" : "x",
            overflowPx: Math.max(dx, dy),
            rect: { w: sec.scrollWidth, h: sec.scrollHeight },
            vqaId: id,
          });
        }
      }
    }
    return out;
  }, { scope: opts.scope, viewport: opts.viewport, startId: session.vId, eps: EPSILON_PX });
  session.vId += 1000;
  for (const d of added.defects)
    addViolation({
      id: d.vqaId, page: url,
      check: d.kind === "slide-viewport" ? "overflow.slide-viewport" : "overflow.scrollbox",
      selector: d.selector,
      detail: `axis=${d.axis} overflowPx=${d.overflowPx} rect=${d.rect.w}x${d.rect.h}`,
      screenshot: null,
    });
  for (const it of added.intentional)
    scrollers.push({ page: url, selector: it.selector, axis: it.axis, overflowPx: it.overflowPx, why: it.why });
  return added.defects;
}

/** Attach one full-slide screenshot to each deck defect (POC: slideShot for all defects of a slide). */
export async function attachDeckOverflowShots(session, defects, slideTag) {
  const { page, url, violations, shot } = session;
  if (!defects.length) return;
  const slideShot = await shot(page, url, `${slideTag}_overflow`);
  for (const d of defects) {
    const vv = violations.find((x) => x.id === d.vqaId);
    if (vv) vv.screenshot = slideShot;
  }
}

/** Attach an element-clipped screenshot to each document-scope defect (POC notes-page behaviour). */
export async function attachDocOverflowShots(session, defects) {
  const { page, url, violations, shot } = session;
  for (const d of defects) {
    const vv = violations.find((x) => x.id === d.vqaId);
    if (vv) vv.screenshot = await shot(page, url, `overflow_${d.vqaId}`, String(d.vqaId));
  }
}

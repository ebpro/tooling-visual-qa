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
 * v0.1.4 severity floor (notebook-ci iteration-1 evidence): residuals under this many
 * px on overflow.slide-viewport are projector-invisible noise → severity "warning"
 * instead of "error". Only that check is floored; overflow.scrollbox stays error.
 * Rows carry an explicit `severity` field so gate consumers can use row.severity
 * when present (the registry's base severity "error" remains the fallback for
 * sub-floor-free rows and all other checks — ONE source of truth: this constant).
 */
export const SLIDE_VIEWPORT_WARNING_FLOOR_PX = 50;

/**
 * v0.1.5 noise-class exclusions for overflow.scrollbox (DEV-ADV M1 evidence,
 * out-m1/dev-adv-v013): 150/218 remaining scrollbox rows were `span.screen-reader-only`
 * (all rect=1x1 — the classic clip/1px sr-only pattern, invisible by construction) and
 * 37/218 were `i.bi.*` bootstrap-icon glyph boxes (rect 15x15–31x31, empty decorative
 * pseudo-element content). Neither class is actionable; gate=error must not be blocked
 * by them. Excluded candidates are skipped ENTIRELY (no violation row, no scrollers row).
 *
 * Detection policy (evidence-driven):
 *  - sr-only: COMPUTED-STYLE based (the probe already fetches style + rect): position
 *    absolute/fixed AND (a layout dimension <= SR_ONLY_MAX_DIM_PX OR a non-default
 *    clip/clip-path). Covers .screen-reader-only (clip: rect) and .visually-hidden
 *    (clip-path: inset) without a class allowlist; a visible box is never suppressed.
 *  - bootstrap icons: class-based by necessity — an <i class="bi ..."> glyph box has no
 *    distinctive computed style; tag I + whitespace-delimited class token "bi".
 */
export const SR_ONLY_MAX_DIM_PX = 1;
export const BI_ICON_CLASS_TOKEN = "bi";

/**
 * Run the overflow evaluation inside the page (POC checkOverflowInPage, verbatim logic).
 * session: { page, url, violations, scrollers, addViolation, vId }
 * opts: { scope: 'deck' | 'doc', viewport: {width,height} | null, warningFloorPx?: number }
 * Returns the defect list (with vqaId); violations rows are already appended.
 */
export async function checkOverflowInPage(session, opts) {
  const { page, url, violations, scrollers, addViolation } = session;
  // CLI dial (--warning-floor-px): default = module constant (one source of truth).
  const warningFloorPx = opts.warningFloorPx ?? SLIDE_VIEWPORT_WARNING_FLOOR_PX;
  const added = await page.evaluate(({ scope, viewport, startId, eps, srOnlyMaxDimPx, biToken }) => {
    // v0.1.5 noise-class exclusions — see SCROLLER constants in module scope.
    const biClassRe = new RegExp("(^|\\s)" + biToken + "(\\s|$)");
    function isVisuallyHidden(el, cs, r) {
      if (cs.position !== "absolute" && cs.position !== "fixed") return false;
      return r.width <= srOnlyMaxDimPx || r.height <= srOnlyMaxDimPx ||
        (!!cs.clip && cs.clip !== "auto") || (!!cs.clipPath && cs.clipPath !== "none");
    }
    function isBootstrapIcon(el) {
      return el.tagName === "I" && typeof el.className === "string" && biClassRe.test(el.className.trim());
    }
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
      // v0.1.5: invisible sr-only boxes and decorative bootstrap-icon glyphs are
      // never actionable scrollbox candidates — skip before classification so they
      // appear in NEITHER violations.jsonl NOR scrollers.jsonl.
      if (isVisuallyHidden(el, cs, r) || isBootstrapIcon(el)) continue;
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
  }, { scope: opts.scope, viewport: opts.viewport, startId: session.vId, eps: EPSILON_PX,
       srOnlyMaxDimPx: SR_ONLY_MAX_DIM_PX, biToken: BI_ICON_CLASS_TOKEN });
  session.vId += 1000;
  for (const d of added.defects)
    addViolation({
      id: d.vqaId, page: url,
      check: d.kind === "slide-viewport" ? "overflow.slide-viewport" : "overflow.scrollbox",
      // v0.1.4 severity floor — ONLY overflow.slide-viewport: sub-floor residuals are
      // warning, >= floor stays error. scrollbox rows carry no severity field and
      // fall back to the registry severity (error) for gate consumers.
      ...(d.kind === "slide-viewport"
        ? { severity: d.overflowPx >= warningFloorPx ? "error" : "warning" }
        : {}),
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

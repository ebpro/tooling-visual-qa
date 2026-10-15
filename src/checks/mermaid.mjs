/**
 * Mermaid resolution check — ported faithfully from tier1-poc/checker.js checkMermaid
 * plus the zero-size-svg companions and the post-hoc element-clip screenshot pass.
 *
 * POC empirical findings encoded here:
 *  - Error signature (mermaid 11.12.0 / Quarto 1.10.18): leftover pre.mermaid-js containing
 *    svg[aria-roledescription="error"] + text.error-text ("Syntax error in text").
 *  - Chain abort: mermaid-init.js renders sequentially without try/catch, so one parse
 *    error leaves every LATER block unrendered → report both mermaid-syntax-error (culprit)
 *    and mermaid-unrendered (collateral).
 *  - A successfully rendered block has its <pre> REMOVED and the svg moved out with class
 *    mermaid-js.
 */

/** Whole-loaded-page resolution check (render happens on window load, visibility-independent). */
export async function checkMermaid(session) {
  const { page, url, addViolation } = session;
  const info = await page.evaluate(() => {
    const leftover = [...document.querySelectorAll("pre.mermaid-js, pre.mermaid")];
    const rendered = [...document.querySelectorAll("svg.mermaid-js")];
    const rows = [];
    for (const pre of leftover) {
      const svg = pre.querySelector("svg");
      const errMarker = svg && (svg.getAttribute("aria-roledescription") === "error" || svg.querySelector(".error-text"));
      const errText = errMarker ? [...svg.querySelectorAll(".error-text")].map((t) => t.textContent).join(" | ").slice(0, 160) : null;
      rows.push({ kind: errMarker ? "mermaid-syntax-error" : "mermaid-unrendered", textHead: pre.textContent.trim().slice(0, 60), errText });
    }
    for (const svg of rendered) {
      if (svg.getAttribute("aria-roledescription") === "error" || svg.querySelector(".error-text"))
        rows.push({ kind: "mermaid-syntax-error", textHead: "(moved svg)", errText: [...svg.querySelectorAll(".error-text")].map((t) => t.textContent).join(" | ").slice(0, 160) });
    }
    return { leftover: leftover.length, rendered: rendered.length, rows };
  });
  for (const r of info.rows)
    addViolation({
      page: url, check: "mermaid.resolution",
      selector: r.kind === "mermaid-syntax-error" ? "pre.mermaid-js[error-svg]" : "pre.mermaid-js[no-svg]",
      detail: `${r.kind}: "${r.textHead}"${r.errText ? " [" + r.errText + "]" : ""}`,
      screenshot: null,
    });
  return info;
}

/** Zero-size visible svg inside the current leaf slide (deck flow, POC inline block). */
export async function checkZeroSizeSvgsDeck(session, ih, iv) {
  const { page, url, addViolation, shot } = session;
  const zeroSvgs = await page.evaluate(() => {
    const all = [...document.querySelectorAll(".reveal .slides section.present")];
    const sec = all[all.length - 1];
    if (!sec) return [];
    return [...sec.querySelectorAll("svg")].filter((s) => { const r = s.getBoundingClientRect(); return r.width < 2 || r.height < 2; }).map((s) => s.id || s.parentElement?.className || "svg");
  });
  for (const z of zeroSvgs)
    addViolation({
      page: url, check: "mermaid.resolution",
      selector: `svg zero-size slide ${ih},${iv}`,
      detail: `svg ${z} renders with <2px box in visible slide`,
      screenshot: await shot(page, url, `slide${ih}-${iv}_zerosvg`),
    });
  return zeroSvgs.length;
}

/** Visible zero-size svg.mermaid-js across the document (notes flow, POC inline block). */
export async function checkZeroSizeSvgsDoc(session) {
  const { page, url, addViolation } = session;
  const zeroSvgs = await page.evaluate(() =>
    [...document.querySelectorAll("svg.mermaid-js")].filter((s) => { const r = s.getBoundingClientRect(); const cs = getComputedStyle(s); return cs.display !== "none" && (r.width < 2 || r.height < 2); }).map((s) => s.id || "svg")
  );
  for (const z of zeroSvgs)
    addViolation({
      page: url, check: "mermaid.resolution",
      selector: "svg.mermaid-js zero-size",
      detail: `svg ${z} visible with <2px box`,
      screenshot: null,
    });
  return zeroSvgs.length;
}

/**
 * Element-clip evidence for mermaid violations whose <pre> is still in the DOM
 * (POC post-hoc pass, scoped to violations added on this page since `before`).
 */
export async function attachMermaidShots(session, before) {
  const { page, url, violations, shot } = session;
  for (const vv of violations.slice(before)) {
    if (vv.check === "mermaid.resolution" && !vv.screenshot) {
      const found = await page.evaluate((det) => {
        const pres = [...document.querySelectorAll("pre.mermaid-js, pre.mermaid")];
        for (const p of pres) if (det.includes(p.textContent.trim().slice(0, 60))) { p.setAttribute("data-vqa-id", "MER"); return true; }
        return false;
      }, vv.detail);
      if (found) vv.screenshot = await shot(page, url, "mermaid", "MER");
    }
  }
}

/**
 * Blank slide check — ported faithfully from the inline block in tier1-poc/checker.js
 * deck walk. Evaluated on arrival at a slide, BEFORE fragments are revealed (a slide
 * whose content is all fragments is not "blank" at its end-state, but the POC flags
 * the arrival state; preserved as-is).
 * Blank = leaf present section with no visible text AND no svg/img/canvas/video/iframe
 * with a >1px box.
 */
export async function checkBlankOnArrival(session, ih, iv) {
  const { page, url, addViolation, shot } = session;
  const blank = await page.evaluate(() => {
    const all = [...document.querySelectorAll(".reveal .slides section.present")];
    const sec = all[all.length - 1];
    if (!sec) return { present: false };
    const txt = (sec.innerText || "").trim();
    const media = [...sec.querySelectorAll("svg, img, canvas, video, iframe")].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
    return { present: true, textLen: txt.length, visMedia: media.length, cls: sec.className };
  });
  if (blank.present && blank.textLen === 0 && blank.visMedia === 0) {
    addViolation({
      page: url, check: "slide.blank", selector: `slide ${ih},${iv}`,
      detail: `no visible text/media cls=${blank.cls}`,
      screenshot: await shot(page, url, `slide${ih}-${iv}_blank`),
    });
    return true;
  }
  return false;
}

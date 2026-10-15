/**
 * Image / subresource checks — ported faithfully from tier1-poc/checker.js
 * (checkImgs + the response/requestfailed listeners and their dedup report in runPage).
 *   - image.broken        : img.complete && naturalWidth === 0
 *   - subresource.failed  : same-origin response status >= 400, or same-origin requestfailed
 */

/**
 * Attach same-origin failure listeners to a page (POC runPage preamble).
 * Returns the mutable `failed` array; consume it with reportFailedSubresources.
 */
export function watchSubresources(page, BASE) {
  const failed = [];
  page.on("response", (r) => {
    try {
      const u = new URL(r.url());
      if (u.origin === new URL(BASE).origin && r.status() >= 400) failed.push({ url: r.url(), status: r.status() });
    } catch {}
  });
  page.on("requestfailed", (rq) => {
    try {
      const u = new URL(rq.url());
      if (u.origin === new URL(BASE).origin) failed.push({ url: rq.url(), status: "requestfailed:" + (rq.failure()?.errorText || "?") });
    } catch {}
  });
  return failed;
}

/** Broken images, with element-clipped evidence where the img is still in the DOM. */
export async function checkImgs(session) {
  const { page, url, addViolation, shot } = session;
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0).map((i) => ({ src: i.getAttribute("src"), alt: i.getAttribute("alt") }))
  );
  const added = [];
  for (const b of broken) {
    added.push(addViolation({
      page: url, check: "image.broken", selector: `img[src="${b.src}"]`,
      detail: `naturalWidth=0 src=${b.src} alt=${b.alt}`, screenshot: null,
    }));
  }
  if (broken.length) {
    await page.evaluate((srcs) => {
      let n = 0;
      for (const i of document.querySelectorAll("img"))
        if (i.complete && i.naturalWidth === 0 && srcs.includes(i.getAttribute("src"))) i.setAttribute("data-vqa-id", "IMG" + ++n);
      return n;
    }, broken.map((b) => b.src));
    for (let k = 1; k <= broken.length; k++) {
      const s = await shot(page, url, `brokenimg_${k}`, "IMG" + k);
      if (added[k - 1]) added[k - 1].screenshot = s;
    }
  }
  return broken.length;
}

/** Deduped failed-subresource violations (one page screenshot attached to the group). */
export async function reportFailedSubresources(session, failed) {
  const { page, url, violations, addViolation, shot } = session;
  const seen = new Set();
  const addedStart = violations.length;
  for (const f of failed) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    addViolation({
      page: url, check: "subresource.failed", selector: f.url.replace(session.BASE, ""),
      detail: `status=${f.status}`, screenshot: null,
    });
  }
  if (violations.length > addedStart) {
    const s = await shot(page, url, "subresources");
    for (let i = addedStart; i < violations.length; i++) violations[i].screenshot = s;
  }
  return violations.length - addedStart;
}

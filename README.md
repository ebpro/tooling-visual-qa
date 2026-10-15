# tooling-visual-qa

Deterministic visual-QA checker for rendered Quarto sites (HTML notes + Reveal.js
slides). ESM port of the validated `tier1-poc` POC into `src/checks/` modules +
registry + runner. Playwright-driven, headless Chromium, no LLM, no heuristics
beyond fixed pixel thresholds — every violation row carries a page URL, check id,
selector, detail and an evidence screenshot.

**Promotion stage: S0 (tool candidate).** This repo is the standalone tool; wiring
it as a canary check against an ebpro lecture CI render is the next step.

## Install

```bash
npm ci
npx playwright install chromium        # first time only (~downloads the browser)
```

Requires Node >= 18 (native `fetch` is used for the CDN reachability probe).

## Usage

```bash
# check a rendered site directory (served locally on a free port via
# python3 -m http.server, unless --url points at an already-running server)
node src/cli.mjs check --site <siteDir> [--url <url>] [--filter <regex>] --out <dir> [--mode <name>]

# self-test over fixtures/ (no external site needed)
node src/cli.mjs selftest [--out <dir>]          # or: node selftest.mjs
```

`check` writes into `--out`:

- `violations.jsonl` — one row per finding: `{page, check, selector, detail, screenshot}`
- `scrollers.jsonl` — intentional scroll regions (`overflow:auto` boxes), NOT defects
- `summary.json` — per-page mermaid counts, violation totals, duration
- `shots/` — evidence PNGs referenced by each violation row

**Page walk:** a recursive scan of `*.html` under `--site`. Since v0.1.3, directories whose
name ends in `_files` are pruned from the walk — these are Quarto's vendored per-deck asset
trees (`<deck>_files/` holding the bundled reveal.js runtime and `speaker-view.html`), which
produce no findings and only add scan time. The prune is on **directory segments only**; a
file named `x_files.html` is still scanned, and `--filter` remains an orthogonal page-name
regex.

## Check registry

Implemented in `src/checks/*`, metadata in `src/registry.mjs`.

| id | severity | threshold | what it detects |
|---|---|---|---|
| `mermaid.resolution` | error | zero-box ≤ 2 px | Mermaid blocks left unrendered: `svg[aria-roledescription="error"]` with "Syntax error in text" (culprit) and raw-source leftovers on later blocks (chain-abort collateral — `mermaid-init.js` renders sequentially without try/catch) |
| `overflow.scrollbox` | error | 2 px epsilon | Content exceeding its box on non-slide pages; `overflow:auto` regions are soft-tagged in `scrollers.jsonl` instead of flagged. **Since v0.1.3** MathJax v3 internal layout boxes are excluded (candidates with an `MJX-*` tagName or an `mjx-container` ancestor) — on a real course site ~96 % of scrollbox rows were non-actionable formula-glyph noise |
| `overflow.slide-viewport` | error | 2 px epsilon | Leaf Reveal slide taller/wider than the configured viewport (transform-independent layout metrics — stage scale does not inflate measurements); ≥100 px is real bleed, ≤10 px is noise-level |
| `image.broken` | error | — | `<img>` with `naturalWidth = 0` |
| `subresource.failed` | error | — | Same-origin subresource answered ≥400 or failed to load |
| `link.deadref` | error | — | href/src target absent from the served tree (DOM scan finds dead `<a href>` the browser never prefetches; 404-response rows cover fetched assets) |
| `slide.blank` | error | — | Reveal slide with no visible text or media on arrival |

## Fixtures & selftest

`fixtures/clean/` and `fixtures/defects/` cover every check id with a positive and
a negative case, plus edge assertions (deadref exact targets, scroller soft-tagging,
screenshot existence). The Reveal.js-based fixtures load the deck runtime from the
jsdelivr CDN; when the CDN is unreachable the selftest **skips** those pages with a
warning instead of failing red. Current local status: **19 PASS / 0 FAIL**.

## Parity note

The port was validated parity-exact against the `tier1-poc` checker on a real
corpus snapshot of `ebpro/notebook-ci` (rendered site tree, 12 pages incl.
speaker-view and planted-defect decks). Local run numbers: 74 mermaid elements
examined, 47 violation rows classified per-check
(`overflow.slide-viewport` 34, `mermaid.resolution` 9, `overflow.scrollbox` 1,
`image.broken` 1, `subresource.failed` 1, `link.deadref` 1) and 24 intentional
scrollers soft-tagged. Note the port reports check-id-level granularity where
the POC aggregated all overflow modes into a single `overflow` check id.

## CI

`.github/workflows/selftest.yml` runs `node selftest.mjs` on a headless-linux
GitHub runner (Node 20, Playwright Chromium with system deps) on every push/PR to
`main`.

## License

MIT — see [LICENSE](LICENSE).

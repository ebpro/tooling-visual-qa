/**
 * Check metadata registry. Each entry: { id, severity, threshold, tags, fixHint } plus
 * the imported check module so consumers can discover capabilities without reading code.
 * Implementation functions are invoked by the runner in the POC's execution order.
 */
import * as mermaid from "./checks/mermaid.mjs";
import * as overflow from "./checks/overflow.mjs";
import * as images from "./checks/images.mjs";
import * as blanks from "./checks/blanks.mjs";
import * as deadref from "./checks/deadref.mjs";

export const CHECK_REGISTRY = [
  {
    id: "mermaid.resolution",
    severity: "error",
    threshold: { zeroBoxPx: 2 },
    tags: ["mermaid", "render"],
    fixHint: "Fix the diagram source flagged 'Syntax error in text'; later blocks on the page are chain-abort collateral (mermaid-init renders sequentially without try/catch) and clear once the culprit is fixed.",
    impl: mermaid,
  },
  {
    id: "overflow.scrollbox",
    severity: "error",
    threshold: { epsilonPx: overflow.EPSILON_PX },
    tags: ["layout", "overflow"],
    fixHint: "Content exceeds its box: shrink/wrap the content, or make the region an intentional scroller (overflow:auto — it will then be soft-tagged in scrollers.jsonl instead).",
    impl: overflow,
  },
  {
    id: "overflow.slide-viewport",
    severity: "error",
    threshold: { epsilonPx: overflow.EPSILON_PX },
    tags: ["layout", "reveal", "slides"],
    fixHint: "Leaf slide content is taller/wider than the Reveal configured viewport: split the slide, shrink content, or enable Reveal scroll — >=100px is real bleed, <=10px is noise-level.",
    impl: overflow,
  },
  {
    id: "image.broken",
    severity: "error",
    threshold: {},
    tags: ["assets", "image"],
    fixHint: "img with naturalWidth=0: fix the src path or regenerate the asset.",
    impl: images,
  },
  {
    id: "subresource.failed",
    severity: "error",
    threshold: {},
    tags: ["assets", "network"],
    fixHint: "Same-origin subresource answered >=400 or failed: fix the referenced path (broken img links appear here too, as the 404).",
    impl: images,
  },
  {
    id: "link.deadref",
    severity: "error",
    threshold: {},
    tags: ["assets", "links"],
    fixHint: "fix-dead-ref: the same-origin href/src target is absent from the served tree — point it at an existing path or remove the reference (source=dom rows include <a href>, which browsers never preflight; source=response rows are fetched assets that answered 404).",
    impl: deadref,
  },
  {
    id: "slide.blank",
    severity: "error",
    threshold: {},
    tags: ["reveal", "content"],
    fixHint: "Reveal slide with no visible text or media on arrival: add content or remove the empty section.",
    impl: blanks,
  },
];

export const CHECK_IDS = CHECK_REGISTRY.map((c) => c.id);
export function getCheck(id) { return CHECK_REGISTRY.find((c) => c.id === id) || null; }

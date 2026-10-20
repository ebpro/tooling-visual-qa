#!/usr/bin/env node
/**
 * visual-qa CLI
 *   visual-qa check --site <dir> [--url <url>] [--filter <regex>] --out <dir> [--mode <name>]
 *                   [--viewport <WxH>] [--warning-floor-px <N>]
 *   visual-qa selftest [--out <dir>]
 * `check` serves <dir> on a free port unless --url points at an already-running server.
 * `check --help` prints the full option list (with defaults) and exits 0.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheck, DEFAULT_VIEWPORT } from "./runner.mjs";
import { SLIDE_VIEWPORT_WARNING_FLOOR_PX } from "./checks/overflow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  return Object.fromEntries(
    argv.reduce((a, v, i, arr) => {
      if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]);
      return a;
    }, [])
  );
}

function usage() {
  console.error(`usage:
  visual-qa check --site <dir> [--url <url>] [--filter <regex>] --out <dir> [--mode <name>]
                  [--viewport <WxH>] [--warning-floor-px <N>]
  visual-qa selftest [--out <dir>]`);
  process.exit(2);
}

/** Full help for `check` (stdout, exit 0). Defaults read from the code constants. */
function checkHelp() {
  console.log(`usage: visual-qa check --site <dir> [--url <url>] [--filter <regex>] --out <dir>
                  [--mode <name>] [--viewport <WxH>] [--warning-floor-px <N>]

options:
  --site <dir>              rendered site directory to serve and walk (required)
  --url <url>               already-running server base URL (skips the local server)
  --filter <regex>          page-name/rel-path regex restricting the walk
  --out <dir>               output directory (required): violations.jsonl, scrollers.jsonl,
                            summary.json, shots/
  --mode <name>             label recorded in summary.json (default: "check")
  --viewport <WxH>          browser page viewport in CSS pixels, e.g. 1920x1080
                            (default: ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height})
  --warning-floor-px <N>    overflow.slide-viewport severity floor: residuals < N px are
                            classified severity="warning" instead of "error" (default:
                            ${SLIDE_VIEWPORT_WARNING_FLOOR_PX}; N must be a number >= 0)

Invalid --viewport / --warning-floor-px values exit 2 with a usage error.`);
}

/** `--viewport 1280x800` → {width:1280,height:800}; invalid → null. */
export function parseViewport(value) {
  const m = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** `--warning-floor-px 50` → 50; invalid (non-numeric or < 0) → null. */
export function parseWarningFloorPx(value) {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.normalize(fs.realpathSync(process.argv[1]));

if (isMain) await main();

async function main() {
const [cmd, ...rest] = process.argv.slice(2);
const args = parseFlags(rest);

if (cmd === "check") {
  if ("help" in args) { checkHelp(); process.exit(0); }
  if (!args.site || !args.out) usage();
  let viewport;
  if ("viewport" in args) {
    viewport = parseViewport(args.viewport);
    if (!viewport) {
      console.error(`error: invalid --viewport "${args.viewport ?? ""}" — expected <WxH> with positive integers, e.g. 1920x1080`);
      usage();
    }
  }
  let warningFloorPx;
  if ("warning-floor-px" in args) {
    warningFloorPx = parseWarningFloorPx(args["warning-floor-px"]);
    if (warningFloorPx === null) {
      console.error(`error: invalid --warning-floor-px "${args["warning-floor-px"] ?? ""}" — expected a number >= 0`);
      usage();
    }
  }
  const summary = await runCheck({
    site: args.site, url: args.url, filter: args.filter, out: args.out, mode: args.mode || "check",
    viewport, warningFloorPx,
  });
  console.log(JSON.stringify(summary.totals, null, 2));
  console.log("mermaid elements examined:", summary.mermaidExamined, "| intentional scrollers:", summary.totals.intentionalScrollers, "| duration(s):", summary.durationSec);
  console.log("out:", path.resolve(args.out));
} else if (cmd === "selftest") {
  const mod = await import(pathToFileURL(path.join(here, "..", "selftest.mjs")).href);
  const code = await mod.main({ out: args.out });
  process.exit(code);
} else {
  usage();
}
}

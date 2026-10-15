#!/usr/bin/env node
/**
 * visual-qa CLI
 *   visual-qa check --site <dir> [--url <url>] [--filter <regex>] --out <dir> [--mode <name>]
 *   visual-qa selftest [--out <dir>]
 * `check` serves <dir> on a free port unless --url points at an already-running server.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheck } from "./runner.mjs";

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
  visual-qa selftest [--out <dir>]`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseFlags(rest);

if (cmd === "check") {
  if (!args.site || !args.out) usage();
  const summary = await runCheck({ site: args.site, url: args.url, filter: args.filter, out: args.out, mode: args.mode || "check" });
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

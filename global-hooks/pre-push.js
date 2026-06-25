// pre-push.js — ClickUp Git Sync hook logic (CommonJS, cross-platform)
"use strict";

const { execSync, spawnSync } = require("child_process");
const { readFileSync, existsSync } = require("fs");
const { createInterface } = require("readline");
const path = require("path");

const AGENT_DIR    = path.dirname(path.dirname(__filename));
const AGENT_SCRIPT = path.join(AGENT_DIR, "agent.mjs");
const CONFIG_FILE  = path.join(AGENT_DIR, "config.json");

if (!existsSync(AGENT_SCRIPT)) process.exit(0);

// ── Resolve current repo ──────────────────────────────────────────────────────
let repoPath, branch;
try {
  repoPath = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  branch   = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
} catch {
  process.exit(0);
}

// ── Check TRACKED_REPOS in config.json ───────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch {}

const normRepo  = repoPath.replace(/\\/g, "/").toLowerCase();
const tracked   = (cfg.TRACKED_REPOS || []).map(p => p.replace(/\\/g, "/").toLowerCase());
const isTracked = tracked.some(p => normRepo === p || normRepo.startsWith(p + "/"));

if (!isTracked) {
  let remoteUrl = "";
  try { remoteUrl = execSync("git remote get-url origin", { encoding: "utf8" }).trim(); } catch {}
  const combined = (remoteUrl + " " + path.basename(repoPath)).toLowerCase();
  const pattern  = /degreepartner|admin.?cms|adminbackend|uniadv|\/dt(?!l)|\/dtl|[_\-]dt(?!l)|[_\-]dtl/i;
  if (!pattern.test(combined)) process.exit(0);
  console.log("[clickup-sync] Matched by keyword: " + path.basename(repoPath));
  console.log("[clickup-sync] Tip: re-run install to add this repo to config.");
} else {
  console.log("[clickup-sync] Detected tracked repo: " + repoPath);
}

// ── Read push refs from stdin ─────────────────────────────────────────────────
// Git sends: <local-ref> <local-sha1> <remote-ref> <remote-sha1>  (one line per ref)
const rl   = createInterface({ input: process.stdin });
const refs = [];

rl.on("line", function(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return;
  const localSha  = parts[1];
  const remoteSha = parts[3];
  refs.push({
    fromRef: remoteSha === "0000000000000000000000000000000000000000" ? "HEAD~5" : remoteSha,
    toRef:   localSha,
  });
});

rl.on("close", function() {
  for (const { fromRef, toRef } of refs) {
    // spawnSync: blocks until agent finishes so interactive prompts show in terminal
    spawnSync(process.execPath, [AGENT_SCRIPT, repoPath, branch, fromRef, toRef], {
      stdio: "inherit",
    });
  }
  process.exit(0);
});

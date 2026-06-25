#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook — ClickUp Git Sync
 * Fires after every Bash tool call. If the command was a `git push`,
 * runs the ClickUp agent in the background for that repo.
 *
 * Receives JSON via stdin:
 *   { tool_name, tool_input: { command }, tool_response: { output } }
 */

import { readFileSync } from "fs";
import { execSync, spawn } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const raw = readFileSync("/dev/stdin", "utf8").trim();
if (!raw) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

const { tool_name, tool_input } = payload;
if (tool_name !== "Bash") process.exit(0);

const cmd = tool_input?.command ?? "";
if (!cmd.includes("git push")) process.exit(0);

// Resolve repo path from cwd
const cwd = tool_input?.cwd ?? process.cwd();
let repoPath;
try {
  repoPath = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
} catch { process.exit(0); }

// Get current branch
let branch;
try {
  branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, encoding: "utf8" }).trim();
} catch { branch = "unknown"; }

// Resolve agent path relative to this hook file — works wherever the repo is cloned
const __dir      = path.dirname(fileURLToPath(import.meta.url));
const agentScript = path.join(__dir, "agent.mjs");

// Run agent detached so it doesn't block Claude Code
const child = spawn("node", [agentScript, repoPath, branch, "HEAD~5", "HEAD"], {
  detached: true,
  stdio: "inherit",
  cwd: repoPath,
});
child.unref();

process.exit(0);

#!/usr/bin/env node
/**
 * ClickUp Git Sync Agent
 * Runs on every git push across DTL / AdminCMS / DT repos.
 * For each commit:
 *   - Finds matching ClickUp task (by ID, keyword hint, or search)
 *   - Asks developer: use existing task or create new?
 *   - Updates task with detailed comment + status, or creates new task
 */

import { execSync }                     from "child_process";
import { readFileSync, readdirSync }    from "fs";
import * as readline                    from "readline";
import path                             from "path";
import { fileURLToPath }                from "url";
import os                               from "os";

// ── Config ────────────────────────────────────────────────────────────────────
const __dir   = path.dirname(fileURLToPath(import.meta.url));
const config  = JSON.parse(readFileSync(path.join(__dir, "config.json"), "utf8"));
const API_KEY = config.CLICKUP_API_KEY;
const TEAM_ID = config.CLICKUP_TEAM_ID;
const BASE_URL = "https://api.clickup.com/api/v2";

// Top-level app tasks — always shown as pinned options
const APP_TASKS = [
  { label: "AdminCMS", id: "86d2k288x", url: "https://app.clickup.com/t/90161564878/86d2k288x" },
  { label: "DT",       id: "86d2k283b", url: "https://app.clickup.com/t/90161564878/86d2k283b" },
  { label: "DTL",      id: "86d2k2808", url: "https://app.clickup.com/t/90161564878/86d2k2808" },
];

// Known task IDs — keyword → ClickUp task ID
const KNOWN_TASKS = {
  AdminCMS:        "86d2k288x",
  Commission:      "86d2k28ht",
  Incentives:      "86d2k28hu",
  Ledger:          "86d2k28hy",
  Invoice:         "86d2k28j2",
  "Lead Punch":    "86d2k28j8",
  "Lead Ops":      "86d2k2b32",
  "Lead Module":   "86d2k2br1",
  DegrePartner:    "86d2k283b",
  DTL:             "86d2k2808",
  referral:        "86d2k283b",
  onboarding:      "86d2k283b",
};

// Branch → ClickUp status
const BRANCH_STATUS_MAP = {
  "feat/":    "in progress",
  "fix/":     "in progress",
  "hotfix/":  "in review",
  "release/": "in review",
  "staging":  "in review",
  "Staging":  "in review",
  "main":     "complete",
  "Main":     "complete",
};

// ── ClickUp API helpers ───────────────────────────────────────────────────────
async function cu(method, endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: { Authorization: API_KEY, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickUp ${method} ${endpoint} → ${res.status}: ${err}`);
  }
  return res.json();
}

const cuGet  = (ep)       => cu("GET",  ep);
const cuPost = (ep, body) => cu("POST", ep, body);
const cuPut  = (ep, body) => cu("PUT",  ep, body);

async function getTaskById(id) {
  try { return await cuGet(`/task/${id}`); } catch { return null; }
}

async function searchTasks(query) {
  try {
    const res = await cuGet(`/team/${TEAM_ID}/task?query=${encodeURIComponent(query)}&include_closed=false`);
    return res.tasks ?? [];
  } catch { return []; }
}

async function addComment(taskId, text) {
  await cuPost(`/task/${taskId}/comment`, { comment_text: text, notify_all: false });
}

async function updateTaskDescription(taskId, description) {
  try { await cuPut(`/task/${taskId}`, { description }); } catch {}
}

async function updateStatus(taskId, status) {
  try { await cuPut(`/task/${taskId}`, { status }); } catch {}
}

async function getSpacesAndLists() {
  const { spaces } = await cuGet(`/team/${TEAM_ID}/space?archived=false`);
  const lists = [];
  for (const space of spaces) {
    const { folders } = await cuGet(`/space/${space.id}/folder?archived=false`);
    for (const folder of folders) {
      const { lists: fl } = await cuGet(`/folder/${folder.id}/list?archived=false`);
      lists.push(...fl.map(l => ({ ...l, spaceName: space.name })));
    }
    const { lists: sl } = await cuGet(`/space/${space.id}/list?archived=false`);
    lists.push(...sl.map(l => ({ ...l, spaceName: space.name })));
  }
  return lists;
}

async function createTask(listId, name, description, repoLabel, priority = 3) {
  return cuPost(`/list/${listId}/task`, {
    name,
    description,
    tags: [repoLabel.toLowerCase()],
    status: "in progress",
    priority, // 1=urgent 2=high 3=normal 4=low
  });
}

async function createSubtask(parentTaskId, name, description) {
  const parent = await getTaskById(parentTaskId);
  if (!parent) throw new Error(`Parent task ${parentTaskId} not found`);
  const listId = parent.list?.id;
  if (!listId) throw new Error(`Could not resolve list for parent task ${parentTaskId}`);
  return cuPost(`/list/${listId}/task`, {
    name,
    description,
    parent: parentTaskId,
    status: "in progress",
  });
}

async function updateTaskDesc(taskId, description) {
  try { await cuPut(`/task/${taskId}`, { description }); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractTaskId(msg) {
  const m = msg.match(/#([a-z0-9]+)|CU-([a-z0-9]+)|\[([a-z0-9]+)\]/i);
  return m ? (m[1] || m[2] || m[3]) : null;
}

function hintTaskIdFromMessage(msg) {
  const lower = msg.toLowerCase();
  for (const [kw, id] of Object.entries(KNOWN_TASKS)) {
    if (lower.includes(kw.toLowerCase())) return id;
  }
  return null;
}

function statusFromBranch(branch) {
  for (const [prefix, status] of Object.entries(BRANCH_STATUS_MAP)) {
    if (branch.startsWith(prefix) || branch === prefix.replace("/", "")) return status;
  }
  return "in progress";
}

// ── Prompt (interactive) — opens the terminal directly, works inside git hooks ─
import { createReadStream } from "fs";

const TTY_PATH = process.platform === "win32" ? "\\\\.\\CON" : "/dev/tty";

let _rl = null;
function getRL() {
  if (!_rl) {
    const tty = createReadStream(TTY_PATH);
    _rl = readline.createInterface({ input: tty, output: process.stdout, terminal: false });
  }
  return _rl;
}
function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = getRL();
    rl.once("line", (ans) => resolve(ans.trim()));
  });
}
function closePrompt() { if (_rl) { _rl.close(); _rl = null; } }

// ── Detailed comment ──────────────────────────────────────────────────────────
function formatComment(commit, repoName, branch, prompts = []) {
  const fileList = commit.files.length
    ? commit.files.map(f => `• \`${f}\``).join("\n")
    : "_No files recorded_";

  // Group files by area for the "what was done" summary
  const filesByArea = {};
  for (const f of commit.files) {
    const area = f.split("/").slice(0, 2).join("/");
    filesByArea[area] = (filesByArea[area] || 0) + 1;
  }
  const workSummary = Object.entries(filesByArea)
    .map(([area, count]) => `• \`${area}\` — ${count} file(s) updated`)
    .join("\n");

  const promptSection = prompts.length
    ? [
        ``,
        `### 💬 Developer Prompts (Claude Code session)`,
        `_Prompts and instructions used during this session:_`,
        ``,
        ...prompts.map((p, i) =>
          `**[${i + 1}]** \`${new Date(p.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}\`\n> ${p.text.replace(/\n/g, "\n> ")}`
        ),
      ].join("\n")
    : "";

  return [
    `## 🔧 Update — ${repoName} / \`${branch}\``,
    ``,
    `### ✅ What Was Completed`,
    `**${commit.message}**`,
    workSummary ? `\n${workSummary}` : "",
    ``,
    `| Field  | Value |`,
    `|--------|-------|`,
    `| Commit | \`${commit.hash}\` |`,
    `| Author | ${commit.author} |`,
    `| Date   | ${commit.date} |`,
    `| Branch | \`${branch}\` |`,
    ``,
    `### 📁 Files Changed (${commit.files.length})`,
    fileList,
    promptSection,
    ``,
    `---`,
    `_Auto-synced by ClickUp Git Sync Agent_`,
  ].join("\n");
}

// ── Detailed task description (for new tasks + subtasks) ─────────────────────
function formatDescription(commit, repoName, branch, prompts = []) {
  // Derive a "what was completed" summary from commit message + files
  const filesByArea = {};
  for (const f of commit.files) {
    const area = f.split("/").slice(0, 2).join("/");
    filesByArea[area] = (filesByArea[area] || 0) + 1;
  }
  const areaSummary = Object.entries(filesByArea)
    .map(([area, count]) => `- \`${area}\` — ${count} file(s)`)
    .join("\n") || "_None recorded_";

  const promptBlock = prompts.length
    ? [
        ``,
        `## 💬 Developer Prompts (Claude Code session)`,
        `_Instructions and context used during this work session:_`,
        ``,
        ...prompts.map((p, i) =>
          `**[${i + 1}]** \`${new Date(p.ts).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}\`\n> ${p.text.replace(/\n/g, "\n> ")}`
        ),
      ].join("\n")
    : "";

  return [
    `**Auto-created from git push.**`,
    ``,
    `## ✅ What Was Completed`,
    `**${commit.message}**`,
    ``,
    areaSummary,
    ``,
    `## Details`,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Repository | ${repoName} |`,
    `| Branch | \`${branch}\` |`,
    `| Author | ${commit.author} |`,
    `| Commit | \`${commit.hash}\` |`,
    `| Date | ${commit.date} |`,
    ``,
    `## 📁 All Files Changed`,
    commit.files.map(f => `- \`${f}\``).join("\n") || "_None recorded_",
    promptBlock,
    ``,
    `## Next Steps`,
    `- Review and update with business context`,
    `- Set assignee, priority, and due date`,
    `- Link to related tasks if applicable`,
  ].join("\n");
}

// ── Extract user prompts from Claude Code session files ───────────────────────
// Reads ~/.claude/projects/<encoded-repo-path>/*.jsonl and returns prompts
// that fall within [windowStart, windowEnd] (Date objects).
function getSessionPrompts(repoPath, windowStart, windowEnd) {
  try {
    const home        = os.homedir();
    const projectsDir = path.join(home, ".claude", "projects");
    const allDirs     = readdirSync(projectsDir);
    const prompts     = [];

    for (const dir of allDirs) {
      let files;
      try { files = readdirSync(path.join(projectsDir, dir)).filter(f => f.endsWith(".jsonl")); }
      catch { continue; }

      for (const file of files) {
        let lines;
        try { lines = readFileSync(path.join(projectsDir, dir, file), "utf8").split("\n").filter(Boolean); }
        catch { continue; }

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== "user") continue;

            const ts = entry.timestamp ? new Date(entry.timestamp) : null;
            if (!ts || ts < windowStart || ts > windowEnd) continue;

            // Filter by cwd — only include messages from sessions run inside or above the repo
            const cwd = entry.cwd ?? "";
            const repoIsUnder = repoPath.startsWith(cwd) || cwd.startsWith(repoPath);
            if (cwd && !repoIsUnder) continue;

            const content = entry.message?.content;
            let text = "";
            if (typeof content === "string") text = content;
            else if (Array.isArray(content)) {
              text = content.filter(c => c?.type === "text").map(c => c.text).join(" ");
            }

            text = text.trim();
            if (text.length < 8) continue;
            if (text.startsWith("<system-reminder>") || text.startsWith("[Request interrupted")) continue;

            prompts.push({ ts: ts.toISOString(), text: text.slice(0, 500) });
          } catch { /* skip malformed */ }
        }
      }
    }

    return prompts.sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args     = process.argv.slice(2);
  const repoPath = args[0] || process.cwd();
  const branch   = args[1] || "unknown";
  const fromRef  = args[2] || "HEAD~10";
  const toRef    = args[3] || "HEAD";
  const repoName = path.basename(repoPath);

  // Auto-detect which app task this repo maps to
  const detectedApp = APP_TASKS.find(a => {
    const n = repoName.toLowerCase();
    const l = a.label.toLowerCase();
    return n === l || n.includes(l) || l.includes(n);
  }) ?? null;

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  ClickUp Git Sync — ${repoName} [${branch}]`);
  if (detectedApp) console.log(`║  App: ${detectedApp.label}`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  let logOutput;
  try {
    logOutput = execSync(
      `git -C "${repoPath}" log ${fromRef}..${toRef} --pretty=format:"%H|%an|%ad|%s" --date=short --name-only`,
      { encoding: "utf8" }
    ).trim();
  } catch {
    console.log("No commits to process.");
    return;
  }

  if (!logOutput) { console.log("Nothing to sync."); return; }

  const commits = [];
  const blocks  = logOutput.split(/\n(?=[a-f0-9]{40}\|)/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const [hash, author, date, ...msgParts] = lines[0].split("|");
    const message = msgParts.join("|");
    const files   = lines.slice(1).filter(l => l.trim() && !l.startsWith(" "));
    commits.push({ hash, author, date, message, files });
  }

  console.log(`📝 ${commits.length} commit(s) to process\n`);

  let allLists = null;
  const getDefaultList = async () => {
    if (!allLists) allLists = await getSpacesAndLists();
    return allLists.find(l => l.spaceName?.toLowerCase().includes("degreepartner")) ?? allLists[0];
  };

  const targetStatus = statusFromBranch(branch);

  for (const [i, commit] of commits.entries()) {
    console.log(`┌─ Commit ${i + 1}/${commits.length} ─────────────────────────────`);
    console.log(`│  Hash:    ${commit.hash.slice(0, 7)}`);
    console.log(`│  Author:  ${commit.author}`);
    console.log(`│  Message: ${commit.message}`);
    console.log(`│  Files:   ${commit.files.length} changed`);
    console.log(`└────────────────────────────────────────────────\n`);

    // ── Extract Claude Code prompts for this commit's session window ──────────
    const commitTime  = new Date(commit.date + "T00:00:00Z");
    const windowStart = new Date(commitTime.getTime() - 12 * 60 * 60 * 1000); // 12h before
    const windowEnd   = new Date(commitTime.getTime() + 36 * 60 * 60 * 1000); // 36h after
    const prompts     = getSessionPrompts(repoPath, windowStart, windowEnd);
    if (prompts.length) {
      console.log(`   🧠 Found ${prompts.length} Claude Code prompt(s) from this session`);
    }

    // ── Find matching task ────────────────────────────────────────────────────
    let candidates = [];

    const explicitId = extractTaskId(commit.message);
    if (explicitId) {
      const t = await getTaskById(explicitId);
      if (t) candidates.push({ task: t, how: "explicit ID in commit message" });
    }

    const hintId = hintTaskIdFromMessage(commit.message);
    if (hintId && (!explicitId || hintId !== explicitId)) {
      const t = await getTaskById(hintId);
      if (t && !candidates.find(c => c.task.id === t.id)) {
        candidates.push({ task: t, how: "keyword match" });
      }
    }

    const keywords = commit.message
      .replace(/^(feat|fix|chore|refactor|docs|test|style|ci|build|perf)\(?[^)]*\)?:\s*/i, "")
      .slice(0, 60);
    const searchResults = await searchTasks(keywords);
    for (const t of searchResults.slice(0, 3)) {
      if (!candidates.find(c => c.task.id === t.id)) {
        candidates.push({ task: t, how: "search match" });
      }
    }

    // ── Determine match confidence ────────────────────────────────────────────
    // High confidence = explicit task ID in commit → auto-comment, no prompt.
    // Medium confidence = keyword hint → ask.
    // Low confidence = search only → ask.
    const highConfidence = !!explicitId && candidates.length > 0 && candidates[0].how === "explicit ID in commit message";

    // ── Ask developer ─────────────────────────────────────────────────────────
    let chosenTask = null;
    let action     = null; // "comment" | "subtask" | "new" | "skip"

    if (highConfidence) {
      // Auto-match — no need to ask
      chosenTask = candidates[0].task;
      action     = "comment";
      console.log(`✅ Auto-matched by task ID: "${chosenTask.name}"\n`);
    } else if (candidates.length > 0) {
      console.log(`🔍 Found ${candidates.length} possible matching task(s):\n`);
      candidates.forEach((c, idx) => {
        console.log(`  [${idx + 1}] ${c.task.name}`);
        console.log(`       ID: ${c.task.id}  |  Status: ${c.task.status?.status ?? "unknown"}  |  Match: ${c.how}`);
        console.log(`       URL: https://app.clickup.com/t/${c.task.id}\n`);
      });

      // Show detected app task as a pinned option
      const appOffset = candidates.length;
      if (detectedApp) {
        console.log(`  ── This repo (${detectedApp.label}) ──`);
        console.log(`  [${appOffset + 1}] ${detectedApp.label}  |  ${detectedApp.url}\n`);
      }
      console.log(`  [N] Create a brand-new task under ${detectedApp ? detectedApp.label : "an app"}`);
      console.log(`  [S] Skip this commit\n`);

      const totalOptions = candidates.length + (detectedApp ? 1 : 0);
      const pick = await prompt(`👉 Select task [1-${totalOptions}], N for new, S to skip: `);

      if (pick.toLowerCase() === "s") {
        console.log(`   ⏭  Skipped.\n`); continue;
      } else if (pick.toLowerCase() === "n" || pick === "") {
        chosenTask = null;
      } else {
        const idx = parseInt(pick) - 1;
        if (idx >= 0 && idx < candidates.length) {
          // Picked a search-matched task
          chosenTask = candidates[idx].task;
          console.log(`   ✓ Using: "${chosenTask.name}"\n`);
          console.log(`  What type of change is this commit?`);
          console.log(`  [1] Modification / rework → add comment only`);
          console.log(`  [2] New sub-feature → create subtask under this task\n`);
          const updateType = await prompt(`👉 Choose [1/2]: `);
          action = updateType === "2" ? "subtask" : "comment";
        } else if (detectedApp && idx === candidates.length) {
          // Picked the pinned detected-app task
          console.log(`   ✓ Using app task: "${detectedApp.label}"\n`);
          chosenTask = await getTaskById(detectedApp.id);
          if (!chosenTask) { console.log(`   ❌ Could not fetch app task.\n`); continue; }
          console.log(`  What type of change is this commit?`);
          console.log(`  [1] Modification / rework → add comment only`);
          console.log(`  [2] New sub-feature → create subtask under ${detectedApp.label}\n`);
          const updateType = await prompt(`👉 Choose [1/2]: `);
          action = updateType === "2" ? "subtask" : "comment";
        } else {
          console.log(`   ⚠️  Invalid — creating new task.\n`);
        }
      }
    } else {
      console.log(`🔍 No search matches found.\n`);
      if (detectedApp) {
        console.log(`  [1] ${detectedApp.label}  |  ${detectedApp.url}`);
      }
      console.log(`  [N] Create a brand-new task under ${detectedApp ? detectedApp.label : "an app"}`);
      console.log(`  [S] Skip this commit\n`);

      const pick = await prompt(`👉 Select [${detectedApp ? "1, " : ""}N, S]: `);

      if (pick.toLowerCase() === "s") {
        console.log(`   ⏭  Skipped.\n`); continue;
      } else if (pick === "1" && detectedApp) {
        chosenTask = await getTaskById(detectedApp.id);
        if (!chosenTask) { console.log(`   ❌ Could not fetch app task.\n`); continue; }
        console.log(`   ✓ Using app task: "${detectedApp.label}"\n`);
        console.log(`  [1] Modification / rework → add comment only`);
        console.log(`  [2] New sub-feature → create subtask under ${detectedApp.label}\n`);
        const updateType = await prompt(`👉 Choose [1/2]: `);
        action = updateType === "2" ? "subtask" : "comment";
      } else {
        chosenTask = null; // falls through to brand-new flow
      }
    }

    // ── Execute chosen action ─────────────────────────────────────────────────
    if (chosenTask && action === "comment") {
      // Modification/rework → comment only
      const comment = formatComment(commit, repoName, branch, prompts);
      await addComment(chosenTask.id, comment);
      await updateStatus(chosenTask.id, targetStatus);
      console.log(`   💬 Comment added to "${chosenTask.name}"`);
      console.log(`   📌 Status → "${targetStatus}"`);
      console.log(`   🔗 https://app.clickup.com/t/${chosenTask.id}\n`);

    } else if (chosenTask && action === "subtask") {
      // New sub-feature → create subtask under the parent task
      const subtaskName = `[${repoName}] ${commit.message.slice(0, 80)}`;
      const subtaskDesc = formatDescription(commit, repoName, branch, prompts);
      const subtask = await createSubtask(chosenTask.id, subtaskName, subtaskDesc);
      await updateStatus(subtask.id, targetStatus);
      // Also add comment on parent linking to the subtask
      await addComment(chosenTask.id, `📌 New subtask created from \`${commit.hash.slice(0,7)}\`: **${subtaskName}**\nhttps://app.clickup.com/t/${subtask.id}`);
      console.log(`   🗂  Subtask created under "${chosenTask.name}"`);
      console.log(`   📌 Status → "${targetStatus}"`);
      console.log(`   🔗 https://app.clickup.com/t/${subtask.id}\n`);

    } else {
      // Brand-new task — auto-assign to detected app, no need to ask
      const parentApp = detectedApp;

      console.log(`\n📋 Creating new task${parentApp ? ` under ${parentApp.label}` : ""}:\n`);
      const customName = await prompt(`   Task name [Enter to use commit message]: `);
      const taskName   = customName || `[${repoName}] ${commit.message.slice(0, 80)}`;

      console.log(`   Priority: [1] Urgent  [2] High  [3] Normal  [4] Low`);
      const priInput = await prompt(`   Choose priority [default: 3]: `);
      const priority = [1,2,3,4].includes(parseInt(priInput)) ? parseInt(priInput) : 3;

      const description = formatDescription(commit, repoName, branch, prompts);

      if (parentApp) {
        const parentTask = await getTaskById(parentApp.id);
        if (!parentTask) throw new Error(`Could not fetch ${parentApp.label} task`);
        const listId = parentTask.list?.id;
        if (!listId) throw new Error(`No list found for ${parentApp.label}`);
        const newTask = await cuPost(`/list/${listId}/task`, {
          name: taskName, description, parent: parentApp.id,
          status: "in progress", priority, tags: [repoName.toLowerCase()],
        });
        await updateStatus(newTask.id, targetStatus);
        console.log(`\n   ✨ Subtask created under ${parentApp.label}: "${newTask.name}"`);
        console.log(`   📌 Status → "${targetStatus}"`);
        console.log(`   🔗 https://app.clickup.com/t/${newTask.id}\n`);
      } else {
        const defaultList = await getDefaultList();
        const newTask     = await createTask(defaultList.id, taskName, description, repoName, priority);
        await updateStatus(newTask.id, targetStatus);
        console.log(`\n   ✨ New task created: "${newTask.name}"`);
        console.log(`   📌 Status → "${targetStatus}"`);
        console.log(`   🔗 https://app.clickup.com/t/${newTask.id}\n`);
      }
    }
  }

  closePrompt();
  console.log(`✅ ClickUp sync complete for ${repoName}\n`);
}

main().catch(err => {
  console.error("❌ ClickUp agent error:", err.message);
  process.exit(0); // Never block the push
});

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  parseClaudeRecord,
  parseCodexRecord,
  parseOpenClawEvent,
} from "./chat-response-parsers.mjs";

const root = resolve(process.env.START_TALK_ROOT || resolve(import.meta.dirname, ".."));
const runtimeDir = resolve(root, "runtime");
const logPath = resolve(runtimeDir, "logs", "chat-response-monitor.log");
const statePath = resolve(runtimeDir, "chat-response-monitor-state.json");
const bridgeUrl =
  process.env.LUMINA_VOICE_BRIDGE_URL || "http://127.0.0.1:8765/voice/claude-response";
const home = os.homedir();
const startedAt = Date.now();
const MAX_TRACKED_FILES = 120;
const RECENT_FILE_MS = 7 * 24 * 60 * 60_000;
const REPLAY_WINDOW_MS = 2 * 60_000;
const SEEN_TTL_MS = 10 * 60_000;

mkdirSync(dirname(logPath), { recursive: true });

function log(message) {
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function walkFiles(directory, predicate, output = []) {
  if (!existsSync(directory)) return output;
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, output);
    else if (entry.isFile() && predicate(path)) output.push(path);
  }
  return output;
}

function recentJsonlFiles(directory) {
  const cutoff = Date.now() - RECENT_FILE_MS;
  return walkFiles(directory, (path) => path.toLowerCase().endsWith(".jsonl"))
    .map((path) => {
      try {
        return { path, stat: statSync(path) };
      } catch {
        return undefined;
      }
    })
    .filter((item) => item && item.stat.mtimeMs >= cutoff)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, MAX_TRACKED_FILES);
}

function openClawDatabases() {
  return walkFiles(
    join(home, ".openclaw", "agents"),
    (path) => basename(path).toLowerCase() === "openclaw-agent.sqlite",
  );
}

function emptyState() {
  return { version: 1, initializedAt: new Date().toISOString(), files: {}, databases: {}, seen: {} };
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed?.version === 1) return parsed;
  } catch {
    // First start or interrupted state write.
  }
  return emptyState();
}

const state = loadState();
let initialized = existsSync(statePath);
let polling = false;
let lastDiscoveryAt = 0;
let codexFiles = [];
let claudeFiles = [];
let databases = [];

function saveState() {
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, statePath);
}

function hashText(source, text) {
  return createHash("sha256")
    .update(`${source}\n${text.replace(/\s+/gu, " ").trim()}`)
    .digest("hex");
}

function pruneSeen() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const [key, timestamp] of Object.entries(state.seen)) {
    if (Number(timestamp) < cutoff) delete state.seen[key];
  }
}

async function enqueue(source, requestId, text) {
  const trimmed = text.trim().slice(0, 6000);
  if (!trimmed) return;
  const key = hashText(source, trimmed);
  if (state.seen[key]) return;
  try {
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: trimmed, requestId, source }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return;
    const result = await response.json();
    if (result?.ok !== true) return;
    state.seen[key] = Date.now();
    log(`enqueued source=${source} id=${requestId} length=${trimmed.length}`);
  } catch (error) {
    log(`enqueue failed source=${source} error=${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendedLines(path, offset) {
  const size = statSync(path).size;
  if (size < offset) offset = 0;
  if (size === offset) return { lines: [], offset };
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, buffer, 0, length, offset);
  } finally {
    closeSync(descriptor);
  }
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline < 0) return { lines: [], offset };
  return {
    lines: buffer.subarray(0, lastNewline + 1).toString("utf8").split(/\r?\n/u),
    offset: offset + lastNewline + 1,
  };
}

async function pollTranscriptFiles(items, source, parser) {
  for (const item of items) {
    const knownOffset = state.files[item.path];
    if (knownOffset === undefined) {
      state.files[item.path] = item.stat.mtimeMs >= startedAt - REPLAY_WINDOW_MS ? 0 : item.stat.size;
    }
    const result = appendedLines(item.path, Number(state.files[item.path]) || 0);
    state.files[item.path] = result.offset;
    let lineNumber = 0;
    for (const line of result.lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        const text = parser(JSON.parse(line));
        if (text) {
          const id = `${source}:file:${basename(item.path)}:${result.offset}:${lineNumber}`;
          await enqueue(source, id, text);
        }
      } catch {
        // Ignore malformed or partially migrated transcript records.
      }
    }
  }
}

function maxDatabaseRow(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(database.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM transcript_events").get().value);
  } finally {
    database.close();
  }
}

async function pollOpenClawDatabase(path) {
  if (state.databases[path] === undefined) {
    const modifiedRecently = statSync(path).mtimeMs >= startedAt - REPLAY_WINDOW_MS;
    state.databases[path] = modifiedRecently && initialized ? 0 : maxDatabaseRow(path);
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare(
        "SELECT rowid, session_id, seq, event_json FROM transcript_events WHERE rowid > ? ORDER BY rowid LIMIT 500",
      )
      .all(Number(state.databases[path]) || 0);
    for (const row of rows) {
      state.databases[path] = Math.max(Number(state.databases[path]) || 0, Number(row.rowid));
      const text = parseOpenClawEvent(row.event_json);
      if (text) {
        await enqueue("openclaw", `openclaw:db:${row.session_id}:${row.seq}`, text);
      }
    }
  } finally {
    database.close();
  }
}

function discover() {
  codexFiles = recentJsonlFiles(join(home, ".codex", "sessions"));
  claudeFiles = recentJsonlFiles(join(home, ".claude", "projects"));
  databases = openClawDatabases();
  lastDiscoveryAt = Date.now();
}

function baseline() {
  discover();
  for (const item of [...codexFiles, ...claudeFiles]) state.files[item.path] = item.stat.size;
  for (const path of databases) {
    try {
      state.databases[path] = maxDatabaseRow(path);
    } catch (error) {
      log(`database baseline failed path=${path} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  initialized = true;
  saveState();
  log(`baseline codex=${codexFiles.length} claude=${claudeFiles.length} openclaw=${databases.length}`);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!initialized) baseline();
    if (Date.now() - lastDiscoveryAt > 10_000) discover();
    await pollTranscriptFiles(codexFiles, "codex", parseCodexRecord);
    await pollTranscriptFiles(claudeFiles, "claude-code", parseClaudeRecord);
    for (const path of databases) {
      try {
        await pollOpenClawDatabase(path);
      } catch (error) {
        log(`database poll failed path=${path} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    pruneSeen();
    saveState();
  } catch (error) {
    log(`poll failed error=${error instanceof Error ? error.stack || error.message : String(error)}`);
  } finally {
    polling = false;
  }
}

log(`monitor started pid=${process.pid}`);
await poll();
setInterval(poll, 1500);

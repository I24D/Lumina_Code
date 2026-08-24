import fs from "node:fs";
import path from "node:path";

import type { Session, Usage } from "core/index.js";
import { v4 as uuidv4 } from "uuid";

import { runtimeEventBus } from "../api/runtimeEvents.js";
import { getSessionDir } from "../session.js";
import { logger } from "../util/logger.js";

export type ChildSessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/**
 * Persisted record for work delegated by a primary session to a subagent.
 *
 * Child sessions intentionally live outside the primary session index so they
 * do not appear as unrelated top-level chats. They can still be queried by
 * parentSessionId and exposed as a tree by future CLI/GUI clients.
 */
export interface ChildSessionRecord extends Session {
  parentSessionId: string;
  agentName: string;
  status: ChildSessionStatus;
  dateCreated: string;
  dateUpdated: string;
  error?: string;
}

function getChildSessionDir(): string {
  const childSessionDir = path.join(getSessionDir(), "children");
  if (!fs.existsSync(childSessionDir)) {
    fs.mkdirSync(childSessionDir, { recursive: true });
  }
  return childSessionDir;
}

function assertSafeSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId) || sessionId.includes("..")) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

function getChildSessionFilePath(sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(getChildSessionDir(), `${sessionId}.json`);
}

function makeChildSessionTitle(agentName: string, prompt: string): string {
  const compactPrompt = prompt.replace(/\s+/g, " ").trim();
  const summary = compactPrompt || "Delegated task";
  return `${agentName}: ${summary}`.slice(0, 120);
}

/** Create an in-memory child session and persist its initial running state. */
export function createChildSession(
  parentSessionId: string,
  agentName: string,
  prompt: string,
): ChildSessionRecord {
  if (!parentSessionId.trim()) {
    throw new Error("A child session requires a parent session ID");
  }
  if (!agentName.trim()) {
    throw new Error("A child session requires an agent name");
  }

  const now = new Date().toISOString();
  const childSession: ChildSessionRecord = {
    sessionId: uuidv4(),
    parentSessionId,
    agentName,
    status: "queued",
    dateCreated: now,
    dateUpdated: now,
    title: makeChildSessionTitle(agentName, prompt),
    workspaceDirectory: process.cwd(),
    history: [
      {
        message: { role: "user", content: prompt },
        contextItems: [],
      },
    ],
    usage: {
      totalCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: {
        cachedTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };

  saveChildSession(childSession);
  return childSession;
}

/** Persist a child session without changing the CLI's active primary session. */
export function saveChildSession(childSession: ChildSessionRecord): void {
  assertSafeSessionId(childSession.sessionId);
  childSession.dateUpdated = new Date().toISOString();
  fs.writeFileSync(
    getChildSessionFilePath(childSession.sessionId),
    JSON.stringify(childSession, null, 2),
    "utf8",
  );
  runtimeEventBus.publish("child.updated", {
    sessionId: childSession.sessionId,
    parentSessionId: childSession.parentSessionId,
    agentName: childSession.agentName,
    status: childSession.status,
    dateUpdated: childSession.dateUpdated,
  });
}

/** Add model usage to a child without touching the active primary session. */
export function trackChildSessionUsage(
  childSession: ChildSessionRecord,
  cost: number,
  usage: Usage,
): void {
  childSession.usage.totalCost += cost;
  childSession.usage.promptTokens += usage.promptTokens;
  childSession.usage.completionTokens += usage.completionTokens;

  if (usage.promptTokensDetails?.cachedTokens) {
    childSession.usage.promptTokensDetails ??= {};
    childSession.usage.promptTokensDetails.cachedTokens =
      (childSession.usage.promptTokensDetails.cachedTokens ?? 0) +
      usage.promptTokensDetails.cachedTokens;
  }
  if (usage.promptTokensDetails?.cacheWriteTokens) {
    childSession.usage.promptTokensDetails ??= {};
    childSession.usage.promptTokensDetails.cacheWriteTokens =
      (childSession.usage.promptTokensDetails.cacheWriteTokens ?? 0) +
      usage.promptTokensDetails.cacheWriteTokens;
  }

  saveChildSession(childSession);
}

export function loadChildSession(sessionId: string): ChildSessionRecord | null {
  try {
    const filePath = getChildSessionFilePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    logger.error(`Error loading child session ${sessionId}:`, error);
    return null;
  }
}

export function listChildSessions(
  parentSessionId: string,
): ChildSessionRecord[] {
  return fs
    .readdirSync(getChildSessionDir())
    .filter((file) => file.endsWith(".json"))
    .map((file) => loadChildSession(path.basename(file, ".json")))
    .filter(
      (session): session is ChildSessionRecord =>
        session !== null && session.parentSessionId === parentSessionId,
    )
    .sort((a, b) => b.dateCreated.localeCompare(a.dateCreated));
}

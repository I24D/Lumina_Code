/**
 * governance-policy.ts — Microsoft Agent Governance Toolkit integration for Lumina.
 *
 * Provides runtime policy enforcement for agent actions with:
 * - Policy DSL for defining allowed/blocked actions
 * - Risk-based approval workflows
 * - Structured audit logging for compliance
 * - Real-time action evaluation before execution
 *
 * Policy file location: c:/I24D_WhatsApp/governance-policy.json
 * Audit log location: c:/I24D_WhatsApp/logs/governance-audit.jsonl
 *
 * Based on: https://github.com/microsoft/agent-governance-toolkit
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";

// ============================================================================
// Types
// ============================================================================

export type ActionCategory =
  | "file"
  | "process"
  | "network"
  | "browser"
  | "shell"
  | "clipboard"
  | "ui"
  | "memory"
  | "skill"
  | "custom";

export type RiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PolicyAction = "allow" | "block" | "require_approval" | "audit_only";

export interface PolicyRule {
  id: string;
  description?: string;
  category: ActionCategory;
  actionPattern: string; // Regex pattern for action names
  targetPattern?: string; // Optional regex for target paths/URLs
  riskLevel: RiskLevel;
  decision: PolicyAction;
  conditions?: {
    timeRange?: { start: string; end: string }; // HH:MM format
    maxFileSize?: number; // bytes
    allowedProcesses?: string[];
    blockedProcesses?: string[];
    requireUserPresence?: boolean;
  };
  enabled: boolean;
}

export interface GovernanceConfig {
  version: string;
  lastUpdated: string;
  defaultDecision: PolicyAction;
  requireApprovalForRisk: RiskLevel[];
  auditLogEnabled: boolean;
  auditLogPath: string;
  maxAuditLogSizeMB: number;
  rules: PolicyRule[];
}

export interface ActionContext {
  action: string;
  category: ActionCategory;
  target?: string;
  parameters?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
}

export interface GovernanceDecision {
  allowed: boolean;
  decision: PolicyAction;
  riskLevel: RiskLevel;
  matchedRule?: PolicyRule;
  reason: string;
  requiresApproval: boolean;
  auditLogged: boolean;
}

// ============================================================================
// Default Policy
// ============================================================================

const DEFAULT_POLICY: GovernanceConfig = {
  version: "1.0.0",
  lastUpdated: new Date().toISOString(),
  defaultDecision: "audit_only",
  requireApprovalForRisk: ["HIGH", "CRITICAL"],
  auditLogEnabled: true,
  auditLogPath: "c:/I24D_WhatsApp/logs/governance-audit.jsonl",
  maxAuditLogSizeMB: 100,
  rules: [
    // File operations
    {
      id: "file-read-safe",
      description: "Allow read-only file operations in workspace",
      category: "file",
      actionPattern: "^(read|list|exists|stat)$",
      targetPattern: "^c:/I24D_WhatsApp/.*",
      riskLevel: "SAFE",
      decision: "allow",
      enabled: true,
    },
    {
      id: "file-write-workspace",
      description: "Allow writes only in workspace directories",
      category: "file",
      actionPattern: "^(write|append|create)$",
      targetPattern: "^c:/I24D_WhatsApp/(workspace-dev|skills|recipes|recordings)/.*",
      riskLevel: "LOW",
      decision: "allow",
      enabled: true,
    },
    {
      id: "file-delete-restricted",
      description: "Require approval for file deletions",
      category: "file",
      actionPattern: "^delete$",
      riskLevel: "HIGH",
      decision: "require_approval",
      enabled: true,
    },
    
    // Process operations
    {
      id: "process-list-safe",
      description: "Allow process listing",
      category: "process",
      actionPattern: "^list$",
      riskLevel: "SAFE",
      decision: "allow",
      enabled: true,
    },
    {
      id: "process-kill-restricted",
      description: "Require approval for killing processes",
      category: "process",
      actionPattern: "^kill$",
      riskLevel: "HIGH",
      decision: "require_approval",
      enabled: true,
    },
    
    // Shell commands
    {
      id: "shell-read-only",
      description: "Allow read-only shell commands",
      category: "shell",
      actionPattern: "^(Get-|Select-|Where-|Measure-)",
      riskLevel: "LOW",
      decision: "allow",
      enabled: true,
    },
    {
      id: "shell-destructive-blocked",
      description: "Block destructive shell commands",
      category: "shell",
      actionPattern: "(Remove-Item|rm|del|rmdir|format|shutdown|restart)",
      riskLevel: "CRITICAL",
      decision: "block",
      enabled: true,
    },
    
    // Browser operations
    {
      id: "browser-navigation-safe",
      description: "Allow browser navigation",
      category: "browser",
      actionPattern: "^(goto|navigate|click|type|read)$",
      riskLevel: "SAFE",
      decision: "allow",
      enabled: true,
    },
    
    // UI automation
    {
      id: "ui-automation-safe",
      description: "Allow UI automation actions",
      category: "ui",
      actionPattern: "^(click|type|scroll|drag|observe)$",
      riskLevel: "LOW",
      decision: "allow",
      enabled: true,
    },
    
    // Memory operations
    {
      id: "memory-read-safe",
      description: "Allow memory read operations",
      category: "memory",
      actionPattern: "^(get|recall|search|list)$",
      riskLevel: "SAFE",
      decision: "allow",
      enabled: true,
    },
    {
      id: "memory-write-audit",
      description: "Audit memory write operations",
      category: "memory",
      actionPattern: "^(set|remember|log)$",
      riskLevel: "LOW",
      decision: "audit_only",
      enabled: true,
    },
  ],
};

// ============================================================================
// Governance Engine
// ============================================================================

export class GovernanceEngine {
  private policyPath: string;
  private policy: GovernanceConfig;
  private auditLogFile: string;

  constructor(policyPath: string) {
    this.policyPath = policyPath;
    this.policy = this.loadPolicy();
    this.auditLogFile = this.policy.auditLogPath;
    
    // Ensure audit log directory exists
    const auditDir = path.dirname(this.auditLogFile);
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
  }

  private loadPolicy(): GovernanceConfig {
    if (fs.existsSync(this.policyPath)) {
      try {
        const content = fs.readFileSync(this.policyPath, "utf-8");
        return JSON.parse(content) as GovernanceConfig;
      } catch (error) {
        console.error(`[Governance] Failed to load policy from ${this.policyPath}:`, error);
        console.error("[Governance] Using default policy");
      }
    }
    
    // Create default policy file
    fs.writeFileSync(this.policyPath, JSON.stringify(DEFAULT_POLICY, null, 2), "utf-8");
    console.log(`[Governance] Created default policy at ${this.policyPath}`);
    return DEFAULT_POLICY;
  }

  public reloadPolicy(): void {
    this.policy = this.loadPolicy();
  }

  public evaluate(context: ActionContext): GovernanceDecision {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    // Find matching rule
    let matchedRule: PolicyRule | undefined;
    for (const rule of this.policy.rules) {
      if (!rule.enabled) continue;
      
      // Check category
      if (rule.category !== context.category) continue;
      
      // Check action pattern
      const actionRegex = new RegExp(rule.actionPattern, 'i');
      if (!actionRegex.test(context.action)) continue;
      
      // Check target pattern if specified
      if (rule.targetPattern && context.target) {
        const targetRegex = new RegExp(rule.targetPattern, 'i');
        if (!targetRegex.test(context.target)) continue;
      }
      
      // Check time range condition
      if (rule.conditions?.timeRange) {
        const { start, end } = rule.conditions.timeRange;
        if (currentTime < start || currentTime > end) continue;
      }
      
      matchedRule = rule;
      break;
    }

    // Determine decision
    const decision = matchedRule?.decision ?? this.policy.defaultDecision;
    const riskLevel = matchedRule?.riskLevel ?? "LOW";
    const requiresApproval = this.policy.requireApprovalForRisk.includes(riskLevel);
    
    const result: GovernanceDecision = {
      allowed: decision !== "block",
      decision,
      riskLevel,
      matchedRule,
      reason: matchedRule?.description ?? `No matching rule, using default: ${decision}`,
      requiresApproval: requiresApproval && decision === "require_approval",
      auditLogged: false,
    };

    // Audit log if enabled
    if (this.policy.auditLogEnabled) {
      this.writeAuditLog(context, result);
      result.auditLogged = true;
    }

    return result;
  }

  private writeAuditLog(context: ActionContext, decision: GovernanceDecision): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      action: context.action,
      category: context.category,
      target: context.target,
      agentId: context.agentId,
      sessionId: context.sessionId,
      decision: decision.decision,
      riskLevel: decision.riskLevel,
      matchedRuleId: decision.matchedRule?.id,
      reason: decision.reason,
    };

    try {
      // Check log size
      if (fs.existsSync(this.auditLogFile)) {
        const stats = fs.statSync(this.auditLogFile);
        const sizeMB = stats.size / (1024 * 1024);
        if (sizeMB > this.policy.maxAuditLogSizeMB) {
          // Rotate log (keep last 50%)
          const content = fs.readFileSync(this.auditLogFile, "utf-8");
          const lines = content.split("\n").filter(l => l.trim());
          const halfPoint = Math.floor(lines.length / 2);
          fs.writeFileSync(this.auditLogFile, lines.slice(halfPoint).join("\n") + "\n", "utf-8");
        }
      }

      // Append entry
      fs.appendFileSync(this.auditLogFile, JSON.stringify(logEntry) + "\n", "utf-8");
    } catch (error) {
      console.error("[Governance] Failed to write audit log:", error);
    }
  }

  public getPolicy(): GovernanceConfig {
    return { ...this.policy };
  }

  public getRules(): PolicyRule[] {
    return this.policy.rules.map(r => ({ ...r }));
  }

  public getRecentDecisions(limit: number = 50): GovernanceDecision[] {
    if (!fs.existsSync(this.auditLogFile)) return [];
    
    try {
      const content = fs.readFileSync(this.auditLogFile, "utf-8");
      const lines = content.split("\n").filter(l => l.trim()).slice(-limit);
      return lines.map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Tools
// ============================================================================

export function createGovernanceEvaluateTool(engine: GovernanceEngine): AnyAgentTool {
  return {
    name: "lumina_governance_evaluate",
    label: "Lumina Governance Evaluate",
    description:
      "Evaluates a pending action against the governance policy. Returns whether the action is allowed, " +
      "blocked, or requires approval. Use BEFORE executing actions with side-effects.",
    parameters: Type.Object({
      action: Type.String({ description: "Action name (e.g., 'delete', 'kill', 'execute')" }),
      category: Type.Union(
        [Type.Literal("file"), Type.Literal("process"), Type.Literal("network"), Type.Literal("browser"),
         Type.Literal("shell"), Type.Literal("clipboard"), Type.Literal("ui"), Type.Literal("memory"),
         Type.Literal("skill"), Type.Literal("custom")],
        { description: "Action category" },
      ),
      target: Type.Optional(Type.String({ description: "Target path, URL, or identifier" })),
      agentId: Type.Optional(Type.String({ description: "Agent ID for audit trail" })),
      sessionId: Type.Optional(Type.String({ description: "Session ID for audit trail" })),
    }),
    async execute(_id, params) {
      const context: ActionContext = {
        action: params.action,
        category: params.category as ActionCategory,
        target: params.target,
        agentId: params.agentId,
        sessionId: params.sessionId,
      };
      
      const decision = engine.evaluate(context);
      return jsonResult(decision);
    },
  };
}

export function createGovernancePolicyTool(engine: GovernanceEngine): AnyAgentTool {
  return {
    name: "lumina_governance_policy",
    label: "Lumina Governance Policy",
    description:
      "View and manage the governance policy. Actions: get (view current policy), " +
      "reload (reload from disk), rules (list all rules), recent (recent audit decisions).",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("get"), Type.Literal("reload"), Type.Literal("rules"), Type.Literal("recent")],
        { description: "Policy action" },
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 50, description: "Limit for recent decisions" })),
    }),
    async execute(_id, params) {
      switch (params.action) {
        case "get":
          return jsonResult({ ok: true, policy: engine.getPolicy() });
        case "reload":
          engine.reloadPolicy();
          return jsonResult({ ok: true, message: "Policy reloaded", rules: engine.getRules().length });
        case "rules":
          return jsonResult({ ok: true, rules: engine.getRules() });
        case "recent":
          return jsonResult({ ok: true, decisions: engine.getRecentDecisions(params.limit ?? 50) });
        default:
          return jsonResult({ ok: false, error: "Unknown action" });
      }
    },
  };
}

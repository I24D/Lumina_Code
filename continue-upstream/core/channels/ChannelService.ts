import fs from "node:fs";
import path from "node:path";

import {
  getContinueGlobalPath,
  setConfigFilePermissions,
} from "../util/paths.js";

export type LuminaChannelId = "whatsapp_desktop" | "phone_link";
export type LuminaChannelMode = "manual" | "suggest";

export interface LuminaChannelConfig {
  id: LuminaChannelId;
  label: string;
  enabled: boolean;
  mode: LuminaChannelMode;
  trustedSenders: string[];
  /** Fixed safety invariant: neither Full Access nor a model may disable it. */
  requireExplicitApproval: true;
}

export interface LuminaChannelSnapshot {
  version: 1;
  channels: LuminaChannelConfig[];
  updatedAt: string;
}

export interface LuminaChannelPatch {
  enabled?: boolean;
  mode?: LuminaChannelMode;
  trustedSenders?: string[];
}

export interface ChannelIngressDecision {
  allowed: boolean;
  reason: "allowed" | "disabled" | "manual_only" | "untrusted_sender";
}

const LABELS: Record<LuminaChannelId, string> = {
  whatsapp_desktop: "WhatsApp Desktop",
  phone_link: "Enlace móvil",
};

function normalizeSender(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function sanitizeSenders(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const unique = new Map<string, string>();
  for (const value of values.slice(0, 100)) {
    if (typeof value !== "string") continue;
    const display = value
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120);
    const key = normalizeSender(display);
    if (key && !unique.has(key)) unique.set(key, display);
  }
  return [...unique.values()];
}

function defaults(now: string): LuminaChannelSnapshot {
  return {
    version: 1,
    updatedAt: now,
    channels: (Object.keys(LABELS) as LuminaChannelId[]).map((id) => ({
      id,
      label: LABELS[id],
      enabled: true,
      mode: "manual",
      trustedSenders: [],
      requireExplicitApproval: true,
    })),
  };
}

function normalizeSnapshot(value: unknown, now: string): LuminaChannelSnapshot {
  const base = defaults(now);
  const raw = value as Partial<LuminaChannelSnapshot> | undefined;
  if (!raw || !Array.isArray(raw.channels)) return base;
  return {
    ...base,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    channels: base.channels.map((channel) => {
      const stored = raw.channels!.find((item) => item?.id === channel.id);
      if (!stored) return channel;
      return {
        ...channel,
        enabled:
          typeof stored.enabled === "boolean"
            ? stored.enabled
            : channel.enabled,
        mode: stored.mode === "suggest" ? "suggest" : "manual",
        trustedSenders: sanitizeSenders(stored.trustedSenders),
        requireExplicitApproval: true,
      };
    }),
  };
}

/** Durable channel policy shared by tools, background ingress and the GUI. */
export class ChannelService {
  constructor(
    private readonly filePath = path.join(
      getContinueGlobalPath(),
      "lumina-channels.json",
    ),
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(): LuminaChannelSnapshot {
    try {
      if (!fs.existsSync(this.filePath))
        return defaults(this.now().toISOString());
      return normalizeSnapshot(
        JSON.parse(fs.readFileSync(this.filePath, "utf8")),
        this.now().toISOString(),
      );
    } catch {
      return defaults(this.now().toISOString());
    }
  }

  update(
    id: LuminaChannelId,
    patch: LuminaChannelPatch,
  ): LuminaChannelSnapshot {
    const current = this.get();
    const channel = current.channels.find((item) => item.id === id);
    if (!channel) throw new Error(`Canal desconocido: ${id}`);
    const nextChannel: LuminaChannelConfig = {
      ...channel,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(patch.mode === "manual" || patch.mode === "suggest"
        ? { mode: patch.mode }
        : {}),
      ...(patch.trustedSenders
        ? { trustedSenders: sanitizeSenders(patch.trustedSenders) }
        : {}),
      requireExplicitApproval: true,
    };
    const next: LuminaChannelSnapshot = {
      version: 1,
      updatedAt: this.now().toISOString(),
      channels: current.channels.map((item) =>
        item.id === id ? nextChannel : item,
      ),
    };
    this.save(next);
    return next;
  }

  assertEnabled(id: LuminaChannelId): void {
    const channel = this.get().channels.find((item) => item.id === id);
    if (!channel?.enabled) {
      throw new Error(`${LABELS[id]} está desactivado en Conexiones.`);
    }
  }

  authorizeIngress(
    id: LuminaChannelId,
    sender: string,
  ): ChannelIngressDecision {
    const channel = this.get().channels.find((item) => item.id === id);
    if (!channel?.enabled) return { allowed: false, reason: "disabled" };
    if (channel.mode !== "suggest") {
      return { allowed: false, reason: "manual_only" };
    }
    const senderKey = normalizeSender(sender);
    const trusted = channel.trustedSenders.some(
      (candidate) => normalizeSender(candidate) === senderKey,
    );
    return trusted
      ? { allowed: true, reason: "allowed" }
      : { allowed: false, reason: "untrusted_sender" };
  }

  hasSuggestionsEnabled(): boolean {
    return this.get().channels.some(
      (channel) =>
        channel.enabled &&
        channel.mode === "suggest" &&
        channel.trustedSenders.length > 0,
    );
  }

  private save(snapshot: LuminaChannelSnapshot): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(temporary, this.filePath);
    setConfigFilePermissions(this.filePath);
  }
}

let shared: ChannelService | undefined;

export function getChannelService(): ChannelService {
  shared ??= new ChannelService();
  return shared;
}

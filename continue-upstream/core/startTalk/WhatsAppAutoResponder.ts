import {
  BridgeNotificationMonitor,
  type BridgeNotificationMonitorOptions,
} from "./BridgeNotificationMonitor.js";
import { validateAutomaticReplyText } from "./PhoneLinkNotificationPolicy.js";
import type { StartTalkNotificationAccess } from "./types.js";
import {
  classifyWhatsAppNotification,
  type WhatsAppReplyCandidate,
  type WhatsAppSource,
} from "./WhatsAppNotificationPolicy.js";

// WhatsApp suggestion monitor. It watches incoming Windows notifications
// (WhatsApp Desktop + Enlace móvil) through the same AMSI-safe bridge monitor the
// voice assistant uses, and — for DIRECT chats only, never groups — drafts a short
// reply for trusted contacts. It NEVER sends: delivery remains a normal Lumina
// tool call and therefore requires the user's explicit approval.

const DEFER_SENTINEL = "DEFERIR";
const SENDER_COOLDOWN_MS = 25_000;
const GLOBAL_WINDOW_MS = 60_000;
const MAX_REPLIES_PER_WINDOW = 6;
const MAX_TRACKED_SENDERS = 200;

/** Prompt pieces handed to the generator (Claude Code) to draft one reply. */
export interface ReplyPrompt {
  system: string;
  user: string;
}

/**
 * Drafts the reply text. Injected by the owner (Core wires this to the Claude
 * Code CLI). Returns the raw reply, or null when it could not produce one.
 */
export type ReplyGenerator = (prompt: ReplyPrompt) => Promise<string | null>;

export type AutoReplyOutcome = "suggested" | "deferred" | "blocked" | "failed";

export interface AutoReplyAuditEntry {
  at: string;
  source: WhatsAppSource;
  sender: string;
  incoming: string;
  outcome: AutoReplyOutcome;
  reply?: string;
  detail?: string;
}

export interface WhatsAppAutoResponderOptions {
  /** Drafts the reply text (Core wires this to Claude Code). */
  generateReply: ReplyGenerator;
  /** Overrides the Windows Bridge base URL (defaults to env / 127.0.0.1:8765). */
  bridgeUrl?: string;
  /** Name the assistant answers as (defaults to LUMINA_OWNER_NAME or "el usuario"). */
  ownerName?: string;
  /** Must explicitly admit this channel/sender before a draft is generated. */
  authorizeCandidate?: (
    candidate: WhatsAppReplyCandidate,
  ) => boolean | Promise<boolean>;
  /** Called for every action so the owner is always informed. */
  onAudit?: (entry: AutoReplyAuditEntry) => void;
  /** Access-status changes from the underlying monitor (allowed/denied/…). */
  onStatus?: (status: StartTalkNotificationAccess, message?: string) => void;
  pollIntervalMs?: number;
  logger?: (message: string) => void;
}

export class WhatsAppAutoResponder {
  private readonly monitor: BridgeNotificationMonitor;
  private readonly ownerName: string;
  private started = false;
  private inFlight = false;
  private readonly lastReplyBySender = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;

  constructor(private readonly options: WhatsAppAutoResponderOptions) {
    this.ownerName =
      options.ownerName?.trim() ||
      process.env.LUMINA_OWNER_NAME?.trim() ||
      "el usuario";
    const monitorOptions: BridgeNotificationMonitorOptions = {
      onNotification: (notification) => {
        void this.handleNotification(notification);
      },
      onStatus: (status, message) => this.options.onStatus?.(status, message),
      bridgeUrl: options.bridgeUrl,
      pollIntervalMs: options.pollIntervalMs,
    };
    this.monitor = new BridgeNotificationMonitor(monitorOptions);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.log(`WhatsApp suggestion monitor online as "${this.ownerName}".`);
    this.monitor.start();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.monitor.stop();
    this.lastReplyBySender.clear();
  }

  private log(message: string): void {
    this.options.logger?.(`[whatsapp-autoreply] ${message}`);
  }

  private audit(entry: AutoReplyAuditEntry): void {
    try {
      this.options.onAudit?.(entry);
    } catch {
      // Auditing must never break the responder.
    }
  }

  private allowSend(senderKey: string): boolean {
    const now = Date.now();
    if (now - this.windowStart > GLOBAL_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= MAX_REPLIES_PER_WINDOW) {
      return false;
    }
    const last = this.lastReplyBySender.get(senderKey);
    if (last !== undefined && now - last < SENDER_COOLDOWN_MS) {
      return false;
    }
    return true;
  }

  private markSent(senderKey: string): void {
    const now = Date.now();
    this.lastReplyBySender.set(senderKey, now);
    this.windowCount += 1;
    if (this.lastReplyBySender.size > MAX_TRACKED_SENDERS) {
      // Drop the oldest half so the map stays bounded.
      const entries = [...this.lastReplyBySender.entries()].sort(
        (a, b) => a[1] - b[1],
      );
      for (const [key] of entries.slice(0, entries.length >> 1)) {
        this.lastReplyBySender.delete(key);
      }
    }
  }

  private async handleNotification(
    notification: Parameters<
      BridgeNotificationMonitorOptions["onNotification"]
    >[0],
  ): Promise<void> {
    const candidate = classifyWhatsAppNotification(notification);
    if (!candidate) {
      return; // Not WhatsApp — nothing to do.
    }
    const authorized = await this.options.authorizeCandidate?.(candidate);
    if (authorized !== true) {
      this.log(`Ignored untrusted/manual-only sender "${candidate.sender}".`);
      return;
    }
    if (!candidate.eligible) {
      // Groups and empty/aggregated toasts are dropped silently (the owner asked
      // to stay out of groups). Sensitive direct messages are surfaced so the
      // owner can handle them personally.
      if (candidate.reason === "sensitive_blocked") {
        this.audit({
          at: new Date().toISOString(),
          source: candidate.source,
          sender: candidate.sender,
          incoming: candidate.message,
          outcome: "deferred",
          detail: "Mensaje sensible — requiere tu atención.",
        });
      }
      return;
    }

    const senderKey = candidate.sender.toLowerCase();
    if (!this.allowSend(senderKey)) {
      this.log(`Rate-limited reply to "${candidate.sender}".`);
      return;
    }
    // Serialize: one reply at a time keeps WhatsApp Desktop focus deterministic.
    if (this.inFlight) {
      this.log(`Busy; skipping "${candidate.sender}" this round.`);
      return;
    }
    this.inFlight = true;
    try {
      await this.replyTo(candidate, senderKey);
    } catch (error) {
      this.audit({
        at: new Date().toISOString(),
        source: candidate.source,
        sender: candidate.sender,
        incoming: candidate.message,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async replyTo(
    candidate: WhatsAppReplyCandidate,
    senderKey: string,
  ): Promise<void> {
    const draft = await this.compose(candidate);
    if (draft === null || draft.toUpperCase().includes(DEFER_SENTINEL)) {
      this.audit({
        at: new Date().toISOString(),
        source: candidate.source,
        sender: candidate.sender,
        incoming: candidate.message,
        outcome: "deferred",
        detail: "El asistente prefirió que respondas tú.",
      });
      return;
    }

    const validation = validateAutomaticReplyText(draft);
    if (!validation.ok) {
      this.audit({
        at: new Date().toISOString(),
        source: candidate.source,
        sender: candidate.sender,
        incoming: candidate.message,
        outcome: "blocked",
        reply: draft,
        detail: `Bloqueado por política: ${validation.error}`,
      });
      return;
    }

    this.markSent(senderKey);
    this.audit({
      at: new Date().toISOString(),
      source: candidate.source,
      sender: candidate.sender,
      incoming: candidate.message,
      outcome: "suggested",
      reply: validation.text,
      detail: "Borrador local; no enviado.",
    });
  }

  private async compose(
    candidate: WhatsAppReplyCandidate,
  ): Promise<string | null> {
    const system = [
      `Redacta un borrador opcional para que ${this.ownerName} responda un mensaje directo (1 a 1). No envías nada y no debes asumir autorización.`,
      `Propón 1-2 frases breves y cálidas en primera persona, en el MISMO idioma del mensaje.`,
      "Los mensajes sociales (saludos, agradecimientos, felicitaciones, small talk) SÍ se contestan con naturalidad.",
      `Responde EXACTAMENTE la palabra ${DEFER_SENTINEL} (y nada más) SOLO si el mensaje pide una decisión o logística concreta (planes, horarios, citas, compromisos), dinero/pagos/códigos/contraseñas/datos sensibles, o información que no puedes saber con certeza.`,
      "No inventes hechos, horarios, cifras ni compromisos. Nunca incluyas enlaces ni códigos.",
      "Devuelve SOLO el texto de la respuesta, sin comillas ni explicaciones.",
    ].join("\n");
    const user = `Contacto: ${candidate.sender}\nMensaje: ${candidate.message}`;

    try {
      const text = await this.options.generateReply({ system, user });
      return text && text.trim() ? text.trim() : null;
    } catch (error) {
      this.log(
        `compose failed for "${candidate.sender}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

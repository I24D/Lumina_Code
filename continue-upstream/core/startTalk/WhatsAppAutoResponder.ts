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

// Autonomous WhatsApp assistant. It watches incoming Windows notifications
// (WhatsApp Desktop + Enlace móvil) through the same AMSI-safe bridge monitor the
// voice assistant uses, and — for DIRECT chats only, never groups — drafts a short
// reply with the configured chat model and sends it back through the Windows
// Bridge. Every action is reported to the owner (audit), and the model may return
// the sentinel DEFERIR to bounce anything it should not answer on its own.

const DEFER_SENTINEL = "DEFERIR";
const SENDER_COOLDOWN_MS = 25_000;
const GLOBAL_WINDOW_MS = 60_000;
const MAX_REPLIES_PER_WINDOW = 6;
const SEND_TIMEOUT_MS = 60_000;
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

export type AutoReplyOutcome = "sent" | "deferred" | "blocked" | "failed";

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
  /** When true, drafts and audits replies but never actually sends them. */
  dryRun?: boolean;
  /** Called for every action so the owner is always informed. */
  onAudit?: (entry: AutoReplyAuditEntry) => void;
  /** Access-status changes from the underlying monitor (allowed/denied/…). */
  onStatus?: (status: StartTalkNotificationAccess, message?: string) => void;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  logger?: (message: string) => void;
}

function bridgeBaseUrl(explicit?: string): string {
  const configured =
    explicit?.trim() ||
    process.env.LUMINA_WINDOWS_BRIDGE_URL?.trim() ||
    process.env.LUMINA_BRIDGE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/u, "");
  }
  const port = process.env.LUMINA_BRIDGE_PORT?.trim() || "8765";
  return `http://127.0.0.1:${port}`;
}

export class WhatsAppAutoResponder {
  private readonly monitor: BridgeNotificationMonitor;
  private readonly base: string;
  private readonly ownerName: string;
  private readonly dryRun: boolean;
  private readonly fetchFn: typeof fetch;
  private started = false;
  private inFlight = false;
  private readonly lastReplyBySender = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;

  constructor(private readonly options: WhatsAppAutoResponderOptions) {
    this.base = bridgeBaseUrl(options.bridgeUrl);
    this.ownerName =
      options.ownerName?.trim() ||
      process.env.LUMINA_OWNER_NAME?.trim() ||
      "el usuario";
    this.dryRun =
      options.dryRun ??
      /^(1|true|yes|on)$/iu.test(
        process.env.LUMINA_WHATSAPP_AUTOREPLY_DRYRUN ?? "",
      );
    this.fetchFn = options.fetchFn ?? fetch;

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
    this.log(
      `WhatsApp auto-responder online (${this.dryRun ? "dry-run" : "live"}) as "${this.ownerName}".`,
    );
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

    if (this.dryRun) {
      this.markSent(senderKey);
      this.audit({
        at: new Date().toISOString(),
        source: candidate.source,
        sender: candidate.sender,
        incoming: candidate.message,
        outcome: "sent",
        reply: validation.text,
        detail: "dry-run (no enviado)",
      });
      return;
    }

    const result = await this.send(candidate, validation.text);
    if (result.ok) {
      this.markSent(senderKey);
      this.audit({
        at: new Date().toISOString(),
        source: candidate.source,
        sender: candidate.sender,
        incoming: candidate.message,
        outcome: "sent",
        reply: validation.text,
      });
    } else {
      this.audit({
        at: new Date().toISOString(),
        source: candidate.source,
        sender: candidate.sender,
        incoming: candidate.message,
        outcome: "failed",
        reply: validation.text,
        detail: result.error,
      });
    }
  }

  private async compose(
    candidate: WhatsAppReplyCandidate,
  ): Promise<string | null> {
    const system = [
      `Actúa como el asistente personal de ${this.ownerName} contestando WhatsApp POR ${this.ownerName} un mensaje de un contacto directo (1 a 1). En esta tarea NO eres un asistente de programación.`,
      `Contesta breve (1-2 frases), cálido y en primera persona como si fueras ${this.ownerName}, en el MISMO idioma del mensaje.`,
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

  private async send(
    candidate: WhatsAppReplyCandidate,
    text: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (candidate.source === "whatsapp_desktop") {
      const result = await this.bridgePost("/whatsapp/reply", {
        contact: candidate.sender,
        message: text,
      });
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error ?? "whatsapp_reply_failed" };
    }

    const n = candidate.notification;
    const result = await this.bridgePost("/phone_link/reply", {
      notificationId: n.id,
      // The bridge validator requires the Phone Link app id + conversationKind
      // to accept the reply (see validatePhoneLinkReplyRequest). Without them,
      // every WhatsApp-via-Enlace-móvil send is rejected source_is_not_phone_link.
      appUserModelId: n.appUserModelId,
      conversationKind: n.conversationKind,
      mobileApp: n.mobileApp,
      sender: n.sender,
      message: n.message,
      textElements: n.textElements,
      replyEligibility: n.replyEligibility,
      replyText: text,
    });
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? "phone_link_reply_failed" };
  }

  private async bridgePost(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = (await response
        .json()
        .catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) {
        return { ok: false, error: data.error ?? `HTTP ${response.status}` };
      }
      return { ok: data.ok === true, error: data.error };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        error: timedOut
          ? `bridge_timeout_after_${SEND_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

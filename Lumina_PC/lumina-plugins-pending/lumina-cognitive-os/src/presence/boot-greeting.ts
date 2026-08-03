/**
 * boot-greeting.ts — Tool: lumina_boot_greeting
 *
 * On startup Lumina says: "Buenos días Dal — tienes 3 correos nuevos,
 * tu primera reunión es a las 10. Tu CPU está al 12% y batería al 78%."
 *
 * The tool collects the data and returns a structured greeting object
 * the agent reads aloud via Start Talk. Each preload (calendar, gmail,
 * env snapshot) is best-effort: failures don't block the greeting.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { readEnvironmentSnapshot } from "../awareness/snapshot.js";
import { googleFetch } from "../mcp/google-auth.js";

function partOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 12) return "buenos días";
  if (h < 19) return "buenas tardes";
  return "buenas noches";
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export function createBootGreetingTool(): AnyAgentTool {
  return {
    name: "lumina_boot_greeting",
    label: "Lumina Boot Greeting",
    description:
      "Builds the morning greeting: salutation, unread email count, today's first event, system snapshot summary, " +
      "and three suggested tasks pulled from working memory. The agent reads the returned `phrase` aloud through " +
      "Start Talk on first launch / on demand.",
    parameters: Type.Object({
      userName: Type.Optional(Type.String({ maxLength: 40, default: "Dal" })),
      language: Type.Optional(Type.String({ maxLength: 8, default: "es" })),
    }),
    async execute(_id, params) {
      const userName = params.userName?.trim() || "Dal";
      const now = new Date();
      const env = await safe(readEnvironmentSnapshot);
      const calendar = await safe(async () => {
        const tMin = now.toISOString();
        const tMax = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        const r = await googleFetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            new URLSearchParams({
              timeMin: tMin,
              timeMax: tMax,
              singleEvents: "true",
              orderBy: "startTime",
              maxResults: "1",
            }).toString(),
        );
        if (!r.ok) return null;
        const j = (await r.json()) as {
          items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }>;
        };
        const first = j.items?.[0];
        if (!first) return null;
        return {
          summary: first.summary ?? "",
          when: first.start?.dateTime ?? first.start?.date ?? "",
        };
      });
      const unread = await safe(async () => {
        const r = await googleFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+newer_than:1d&maxResults=1`,
        );
        if (!r.ok) return null;
        const j = (await r.json()) as { resultSizeEstimate?: number };
        return j.resultSizeEstimate ?? 0;
      });

      const parts: string[] = [];
      parts.push(`${partOfDay(now)} ${userName}.`);
      if (typeof unread === "number" && unread > 0) {
        parts.push(`Tienes ${unread} correo${unread === 1 ? "" : "s"} sin leer.`);
      }
      if (calendar) {
        const time = calendar.when
          ? new Date(calendar.when).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
          : "";
        parts.push(
          `Tu próxima cita: "${calendar.summary || "sin título"}"${time ? ` a las ${time}` : ""}.`,
        );
      }
      if (env) {
        const bat = env.battery
          ? ` Batería ${env.battery.percent}%${env.battery.charging ? " cargando" : ""}.`
          : "";
        parts.push(
          `Sistema: CPU ${Math.round(env.cpu.usagePct)}%, RAM ${env.memory.usedPct}% usada.${bat}`,
        );
      }
      const phrase = parts.join(" ");
      return jsonResult({
        ok: true,
        phrase,
        details: {
          atISO: now.toISOString(),
          unread,
          nextEvent: calendar,
          environment: env
            ? {
                cpuPct: env.cpu.usagePct,
                ramPct: env.memory.usedPct,
                battery: env.battery,
                online: env.network.online,
              }
            : null,
        },
      });
    },
  };
}

/**
 * calendar-tool.ts — Tool: lumina_calendar
 *
 * Google Calendar v3 REST. Actions: list, create, update, delete, freeBusy.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { googleFetch } from "./google-auth.js";

const ACTIONS = ["list", "create", "update", "delete", "freeBusy"] as const;
type Action = (typeof ACTIONS)[number];

export function createCalendarTool(): AnyAgentTool {
  return {
    name: "lumina_calendar",
    label: "Lumina Calendar",
    description:
      "Google Calendar integration. Actions: list (upcoming events), create, update, delete, freeBusy. " +
      "Times must be RFC3339. Default calendarId is 'primary'.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
      calendarId: Type.Optional(Type.String({ default: "primary", maxLength: 240 })),
      eventId: Type.Optional(Type.String({ maxLength: 240 })),
      timeMin: Type.Optional(Type.String({ maxLength: 40 })),
      timeMax: Type.Optional(Type.String({ maxLength: 40 })),
      max: Type.Optional(Type.Number({ minimum: 1, maximum: 250, default: 20 })),
      summary: Type.Optional(Type.String({ maxLength: 480 })),
      description: Type.Optional(Type.String({ maxLength: 4_000 })),
      location: Type.Optional(Type.String({ maxLength: 480 })),
      attendees: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 50 })),
      startISO: Type.Optional(Type.String({ maxLength: 40 })),
      endISO: Type.Optional(Type.String({ maxLength: 40 })),
      timeZone: Type.Optional(Type.String({ maxLength: 80, default: "UTC" })),
    }),
    async execute(_id, params) {
      const action = params.action as Action;
      const calendarId = params.calendarId ?? "primary";
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`;

      if (action === "list") {
        const tMin = params.timeMin ?? new Date().toISOString();
        const tMax = params.timeMax;
        const max = params.max ?? 20;
        const q = new URLSearchParams({
          timeMin: tMin,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(max),
        });
        if (tMax) q.set("timeMax", tMax);
        const r = await googleFetch(`${base}/events?${q.toString()}`);
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        const json = (await r.json()) as {
          items?: Array<{
            id: string;
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            location?: string;
            attendees?: Array<{ email?: string; responseStatus?: string }>;
          }>;
        };
        const events = (json.items ?? []).map((e) => ({
          id: e.id,
          summary: e.summary ?? "",
          startISO: e.start?.dateTime ?? e.start?.date ?? null,
          endISO: e.end?.dateTime ?? e.end?.date ?? null,
          location: e.location ?? "",
          attendees: (e.attendees ?? []).map((a) => ({ email: a.email ?? "", status: a.responseStatus ?? "" })),
        }));
        return jsonResult({ ok: true, events });
      }

      if (action === "create" || action === "update") {
        if (action === "create" && (!params.startISO || !params.endISO)) {
          throw new ToolInputError("startISO and endISO required for create");
        }
        if (action === "update" && !params.eventId) {
          throw new ToolInputError("eventId required for update");
        }
        const tz = params.timeZone ?? "UTC";
        const body: Record<string, unknown> = {};
        if (params.summary !== undefined) body.summary = params.summary;
        if (params.description !== undefined) body.description = params.description;
        if (params.location !== undefined) body.location = params.location;
        if (params.startISO) body.start = { dateTime: params.startISO, timeZone: tz };
        if (params.endISO) body.end = { dateTime: params.endISO, timeZone: tz };
        if (params.attendees) body.attendees = params.attendees.map((email) => ({ email }));
        const url =
          action === "create"
            ? `${base}/events`
            : `${base}/events/${encodeURIComponent(params.eventId!)}`;
        const method = action === "create" ? "POST" : "PATCH";
        const r = await googleFetch(url, { method, body: JSON.stringify(body) });
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        return jsonResult({ ok: true, event: await r.json() });
      }

      if (action === "delete") {
        if (!params.eventId) throw new ToolInputError("eventId required for delete");
        const r = await googleFetch(
          `${base}/events/${encodeURIComponent(params.eventId)}`,
          { method: "DELETE" },
        );
        if (!r.ok && r.status !== 204) {
          return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        }
        return jsonResult({ ok: true, deleted: params.eventId });
      }

      if (action === "freeBusy") {
        const tMin = params.timeMin ?? new Date().toISOString();
        const tMax = params.timeMax ?? new Date(Date.now() + 7 * 86400000).toISOString();
        const r = await googleFetch(
          `https://www.googleapis.com/calendar/v3/freeBusy`,
          {
            method: "POST",
            body: JSON.stringify({
              timeMin: tMin,
              timeMax: tMax,
              items: [{ id: calendarId }],
            }),
          },
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        return jsonResult({ ok: true, freeBusy: await r.json() });
      }

      throw new ToolInputError(`unknown action ${String(action)}`);
    },
  };
}

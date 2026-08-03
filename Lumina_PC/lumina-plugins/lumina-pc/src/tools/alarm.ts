import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { bridgePost } from "../utils/windows-bridge.js";

const alarmActions = Type.Union([
  Type.Literal("create"),
  Type.Literal("list"),
  Type.Literal("cancel"),
  Type.Literal("test"),
]);

const alarmRepeats = Type.Union([
  Type.Literal("once"),
  Type.Literal("daily"),
  Type.Literal("weekly"),
]);

export function createAlarmTool(): AnyAgentTool {
  return {
    name: "lumina_alarm",
    description:
      "Creates, lists, cancels, or tests native Windows alarms through Lumina Windows Bridge. " +
      "Use this when the user asks for a real PC alarm, wake-up alarm, reminder that must sound, " +
      "or anything that should be registered in Windows instead of only remembered in OpenClaw chat. " +
      "The Bridge creates Windows Scheduled Tasks under \\Lumina\\ with WakeToRun, toast alarm UI, speech, and repeated sound.",
    parameters: Type.Object({
      action: alarmActions,
      id: Type.Optional(
        Type.String({
          description: "Stable alarm id. Required for cancel. Example: wake-up-7am.",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: "Alarm title shown by Windows.",
          maxLength: 80,
        }),
      ),
      message: Type.Optional(
        Type.String({
          description: "Alarm message spoken/shown by Windows.",
          maxLength: 400,
        }),
      ),
      timeIso: Type.Optional(
        Type.String({
          description:
            "Local or ISO date/time for create. Example: 2026-06-26T07:00:00-04:00.",
        }),
      ),
      timeLocal: Type.Optional(
        Type.String({
          description:
            "Alternative local date/time for create if timeIso is not provided. Example: 2026-06-26 07:00.",
        }),
      ),
      repeat: Type.Optional(alarmRepeats),
      daysOfWeek: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("Sunday"),
            Type.Literal("Monday"),
            Type.Literal("Tuesday"),
            Type.Literal("Wednesday"),
            Type.Literal("Thursday"),
            Type.Literal("Friday"),
            Type.Literal("Saturday"),
          ]),
          {
            description: "Days for weekly alarms. Leave empty for every day when repeat=daily.",
          },
        ),
      ),
      durationSec: Type.Optional(
        Type.Number({
          description: "How long the alarm sound loop should run. Default 300 seconds.",
          minimum: 3,
          maximum: 1800,
        }),
      ),
    }),
    ownerOnly: true,
    async execute(_toolCallId: string, params) {
      const response = await bridgePost("/alarms", {
        action: params.action,
        ...(params.id ? { id: params.id } : {}),
        ...(params.title ? { title: params.title } : {}),
        ...(params.message ? { message: params.message } : {}),
        ...(params.timeIso ? { timeIso: params.timeIso } : {}),
        ...(params.timeLocal ? { timeLocal: params.timeLocal } : {}),
        ...(params.repeat ? { repeat: params.repeat } : {}),
        ...(params.daysOfWeek ? { daysOfWeek: params.daysOfWeek } : {}),
        ...(params.durationSec ? { durationSec: params.durationSec } : {}),
      });
      return jsonResult({
        ok: response.ok === true,
        via: "lumina-windows-bridge",
        ...response,
      });
    },
  };
}

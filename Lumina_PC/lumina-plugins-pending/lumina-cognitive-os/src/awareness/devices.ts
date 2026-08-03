/**
 * devices.ts — Connected cameras, microphones and Bluetooth devices.
 *
 * We use Get-PnpDevice with sensible class filters because Win32_PnPEntity
 * is too noisy. The result is a flat list of `{class, name, status}`.
 */
import { runPowerShellJson } from "../shared/powershell.js";

export type DeviceInfo = {
  readonly class: "camera" | "microphone" | "speaker" | "bluetooth" | "usb";
  readonly name: string;
  readonly status: string;
};

type Raw = {
  FriendlyName?: string;
  Status?: string;
  Class?: string;
};

const QUERIES: ReadonlyArray<{ class: DeviceInfo["class"]; psClass: string }> = [
  { class: "camera", psClass: "Camera" },
  { class: "microphone", psClass: "AudioEndpoint" }, // both mics + speakers come from this class
  { class: "bluetooth", psClass: "Bluetooth" },
];

export async function readDevices(timeoutMs = 8_000): Promise<DeviceInfo[]> {
  if (process.platform !== "win32") return [];
  const all: DeviceInfo[] = [];
  for (const q of QUERIES) {
    const r = await runPowerShellJson<Raw | Raw[]>(
      `Get-PnpDevice -Class ${q.psClass} -PresentOnly -ErrorAction SilentlyContinue | Select-Object FriendlyName, Status, Class`,
      timeoutMs,
    );
    if (!r.ok) continue;
    const list = Array.isArray(r.data) ? r.data : r.data === null ? [] : [r.data];
    for (const row of list) {
      const name = row.FriendlyName ?? "unknown";
      const status = row.Status ?? "unknown";
      const isMic = q.class === "microphone" && /microphone|mic|capture/i.test(name);
      const isSpeaker = q.class === "microphone" && /speaker|render|headphone/i.test(name);
      const klass: DeviceInfo["class"] = isSpeaker
        ? "speaker"
        : isMic
          ? "microphone"
          : q.class;
      all.push({ class: klass, name, status });
    }
  }
  return all;
}

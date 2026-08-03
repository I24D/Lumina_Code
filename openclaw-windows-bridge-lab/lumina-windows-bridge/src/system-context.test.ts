import assert from "node:assert/strict";
import test from "node:test";

import {
  collectWindowsSystemContext,
  resetSystemContextCachesForTests,
} from "./system-context.ts";

const SNAPSHOT = {
  timezone: { id: "Eastern Standard Time", displayName: "Eastern Time" },
  culture: { name: "es-MX", displayName: "Spanish (Mexico)" },
  homeRegion: { countryCode: "MX", countryName: "Mexico", geoId: 166 },
  networkProfiles: [
    {
      name: "Lumina WiFi",
      interfaceAlias: "Wi-Fi",
      category: "Private",
      ipv4Connectivity: "Internet",
      ipv6Connectivity: "NoTraffic",
    },
  ],
  adapters: [{ name: "Wi-Fi", status: "Up", linkSpeed: "400 Mbps" }],
  battery: { chargePercent: 87, batteryStatus: 2, status: "OK" },
  operatingSystem: { caption: "Windows 11 Pro", buildNumber: "26200" },
  storage: [{ drive: "C:", totalBytes: 1000, freeBytes: 250 }],
  privacy: { location: "Allow", camera: "Allow", microphone: "Deny", notifications: 1 },
  services: [
    { capability: "location", name: "lfsvc", status: "Running", startType: "Manual" },
    { capability: "wifi", name: "WlanSvc", status: "Running", startType: "Automatic" },
  ],
};

test("normalizes clock, Wi-Fi, power, storage, and permissions", async () => {
  resetSystemContextCachesForTests();
  const context = await collectWindowsSystemContext({
    runPowerShell: async () => JSON.stringify(SNAPSHOT),
    env: {
      LUMINA_LOCATION_CITY: "Configured City",
      LUMINA_LOCATION_COUNTRY: "Configured Country",
    },
    now: new Date("2026-07-18T04:00:00.000Z"),
  });

  assert.equal((context.network as any).wifi.ssid, "Lumina WiFi");
  assert.equal((context.network as any).online, true);
  assert.equal((context.power as any).batteryPercent, 87);
  assert.equal((context.power as any).state, "charging");
  assert.equal((context.storage as any[])[0].usedPercent, 75);
  assert.equal((context.permissions as any).microphone, "denied");
  assert.equal((context.permissions as any).notifications, "allowed");
  assert.deepEqual((context.services as any[])[0], SNAPSHOT.services[0]);
  assert.equal((context.location as any).source, "configured");
});

test("uses coarse network location without retaining public IP metadata", async () => {
  resetSystemContextCachesForTests();
  const context = await collectWindowsSystemContext({
    runPowerShell: async () => JSON.stringify(SNAPSHOT),
    env: { LUMINA_NETWORK_GEOLOCATION: "true" },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          ip: "203.0.113.10",
          city: "Greeneville",
          region: "Tennessee",
          country: "United States",
          country_code: "US",
          latitude: 36.16,
          longitude: -82.83,
          timezone: { id: "America/New_York" },
        }),
        { status: 200 },
      ),
    now: new Date("2026-07-18T04:00:00.000Z"),
  });

  assert.equal((context.location as any).source, "network");
  assert.equal((context.location as any).approximate, true);
  assert.equal(JSON.stringify(context).includes("203.0.113.10"), false);
});

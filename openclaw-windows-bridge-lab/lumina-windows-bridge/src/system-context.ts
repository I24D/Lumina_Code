import { networkInterfaces, userInfo } from "node:os";

export type SystemContextCommandRunner = (
  command: string,
  timeoutMs?: number,
) => Promise<string>;

export interface WindowsSystemContextOptions {
  runPowerShell: SystemContextCommandRunner;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}

type PowerShellSystemSnapshot = {
  adapters?: Array<{
    name?: string;
    description?: string;
    status?: string;
    linkSpeed?: string;
  }>;
  battery?: {
    chargePercent?: number;
    batteryStatus?: number;
    status?: string;
  } | null;
  culture?: {
    name?: string;
    displayName?: string;
  };
  homeRegion?: {
    countryCode?: string;
    countryName?: string;
    geoId?: number;
  };
  networkProfiles?: Array<{
    name?: string;
    interfaceAlias?: string;
    category?: string;
    ipv4Connectivity?: string;
    ipv6Connectivity?: string;
  }>;
  operatingSystem?: {
    caption?: string;
    version?: string;
    buildNumber?: string;
    architecture?: string;
    lastBootAt?: string;
  };
  privacy?: {
    location?: string;
    camera?: string;
    microphone?: string;
    notifications?: number | null;
  };
  services?: Array<{
    capability?: string;
    name?: string;
    status?: string;
    startType?: string;
  }>;
  storage?: Array<{
    drive?: string;
    label?: string;
    totalBytes?: number;
    freeBytes?: number;
  }>;
  timezone?: {
    id?: string;
    displayName?: string;
    daylightName?: string;
  };
};

type ApproximateLocation = {
  source: "configured" | "network" | "windows_region";
  approximate: boolean;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
};

const NETWORK_GEOLOCATION_TTL_MS = 30 * 60 * 1000;
let networkLocationCache:
  | { expiresAt: number; value: ApproximateLocation | undefined }
  | undefined;

const SYSTEM_CONTEXT_PS = String.raw`
$ErrorActionPreference = 'Stop'

function Get-ConsentValue([string]$capability) {
  try {
    return (Get-ItemProperty -Path ("HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\" + $capability) -ErrorAction Stop).Value
  } catch {
    return 'Unknown'
  }
}

function Get-CapabilityService([string]$capability, [string]$name) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $service) {
    return [ordered]@{ capability = $capability; name = $name; status = 'Unavailable'; startType = 'Unknown' }
  }
  return [ordered]@{
    capability = $capability
    name = $service.Name
    status = "$($service.Status)"
    startType = "$($service.StartType)"
  }
}

$timezone = Get-TimeZone
$culture = Get-Culture
$region = [System.Globalization.RegionInfo]::CurrentRegion
$homeLocation = Get-WinHomeLocation -ErrorAction SilentlyContinue
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
  [ordered]@{
    name = $_.Name
    interfaceAlias = $_.InterfaceAlias
    category = "$($_.NetworkCategory)"
    ipv4Connectivity = "$($_.IPv4Connectivity)"
    ipv6Connectivity = "$($_.IPv6Connectivity)"
  }
})
$batteryItem = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$battery = if ($batteryItem) {
  [ordered]@{
    chargePercent = [int]$batteryItem.EstimatedChargeRemaining
    batteryStatus = [int]$batteryItem.BatteryStatus
    status = "$($batteryItem.Status)"
  }
} else { $null }
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
$storage = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
  [ordered]@{
    drive = $_.DeviceID
    label = $_.VolumeName
    totalBytes = [double]$_.Size
    freeBytes = [double]$_.FreeSpace
  }
})
$toastEnabled = try {
  (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction Stop).ToastEnabled
} catch { $null }
$services = @(
  Get-CapabilityService 'location' 'lfsvc'
  Get-CapabilityService 'wifi' 'WlanSvc'
  Get-CapabilityService 'notifications' 'WpnService'
  Get-CapabilityService 'audio' 'Audiosrv'
  Get-CapabilityService 'bluetooth' 'BthServ'
)

[ordered]@{
  timezone = [ordered]@{
    id = $timezone.Id
    displayName = $timezone.DisplayName
    daylightName = $timezone.DaylightName
  }
  culture = [ordered]@{
    name = $culture.Name
    displayName = $culture.DisplayName
  }
  homeRegion = [ordered]@{
    countryCode = $region.TwoLetterISORegionName
    countryName = $region.EnglishName
    geoId = if ($homeLocation) { [int]$homeLocation.GeoId } else { $null }
  }
  networkProfiles = $profiles
  adapters = @()
  battery = $battery
  operatingSystem = [ordered]@{
    caption = $os.Caption
    version = $os.Version
    buildNumber = $os.BuildNumber
    architecture = $os.OSArchitecture
    lastBootAt = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToString('o') } else { $null }
  }
  storage = $storage
  services = $services
  privacy = [ordered]@{
    location = Get-ConsentValue 'location'
    camera = Get-ConsentValue 'webcam'
    microphone = Get-ConsentValue 'microphone'
    notifications = $toastEnabled
  }
} | ConvertTo-Json -Compress -Depth 6
`.trim();

function arrayOf<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readConfiguredLocation(env: NodeJS.ProcessEnv): ApproximateLocation | undefined {
  const city = env.LUMINA_LOCATION_CITY?.trim();
  const region = env.LUMINA_LOCATION_REGION?.trim();
  const country = env.LUMINA_LOCATION_COUNTRY?.trim();
  const countryCode = env.LUMINA_LOCATION_COUNTRY_CODE?.trim();
  const latitude = optionalNumber(env.LUMINA_LOCATION_LATITUDE);
  const longitude = optionalNumber(env.LUMINA_LOCATION_LONGITUDE);
  if (!city && !region && !country && !countryCode && latitude === undefined && longitude === undefined) {
    return undefined;
  }
  return {
    source: "configured",
    approximate: latitude === undefined || longitude === undefined,
    city,
    region,
    country,
    countryCode,
    latitude,
    longitude,
    timezone: env.LUMINA_LOCATION_TIMEZONE?.trim(),
  };
}

function networkGeolocationEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.LUMINA_NETWORK_GEOLOCATION?.trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
}

async function readNetworkLocation(
  fetchImpl: typeof fetch,
  now: Date,
): Promise<ApproximateLocation | undefined> {
  if (networkLocationCache && networkLocationCache.expiresAt > now.getTime()) {
    return networkLocationCache.value;
  }

  let value: ApproximateLocation | undefined;
  try {
    const response = await fetchImpl("https://ipwho.is/", {
      headers: { "user-agent": "Lumina-Windows-Bridge/1.0" },
      signal: AbortSignal.timeout(4_000),
    });
    if (response.ok) {
      const raw = (await response.json()) as Record<string, unknown>;
      const timezone = raw.timezone as Record<string, unknown> | undefined;
      if (raw.success !== false) {
        value = {
          source: "network",
          approximate: true,
          city: typeof raw.city === "string" ? raw.city : undefined,
          region: typeof raw.region === "string" ? raw.region : undefined,
          country: typeof raw.country === "string" ? raw.country : undefined,
          countryCode: typeof raw.country_code === "string" ? raw.country_code : undefined,
          latitude: typeof raw.latitude === "number" ? raw.latitude : undefined,
          longitude: typeof raw.longitude === "number" ? raw.longitude : undefined,
          timezone: typeof timezone?.id === "string" ? timezone.id : undefined,
        };
      }
    }
  } catch {
    value = undefined;
  }

  networkLocationCache = {
    expiresAt: now.getTime() + NETWORK_GEOLOCATION_TTL_MS,
    value,
  };
  return value;
}

function localNetworkAddresses() {
  return Object.entries(networkInterfaces()).flatMap(([interfaceName, entries]) =>
    (entries ?? [])
      .filter((entry) => !entry.internal)
      .map((entry) => ({
        interfaceName,
        family: entry.family,
        address: entry.address,
      })),
  );
}

function localIsoString(value: Date): string {
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const minutes = String(absoluteOffset % 60).padStart(2, "0");
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .replace("Z", "");
  return `${local}${sign}${hours}:${minutes}`;
}

function isConnected(profile: PowerShellSystemSnapshot["networkProfiles"] extends Array<infer T> ? T : never) {
  return profile.ipv4Connectivity === "Internet" || profile.ipv6Connectivity === "Internet";
}

function batteryState(status: number | undefined): string | undefined {
  if (status === 2 || status === 6 || status === 7 || status === 8 || status === 9) return "charging";
  if (status === 1 || status === 3 || status === 4 || status === 5) return "on_battery";
  if (status === 11) return "fully_charged";
  return status === undefined ? undefined : "unknown";
}

function permissionState(value: string | undefined): "allowed" | "denied" | "unknown" {
  if (value?.toLowerCase() === "allow") return "allowed";
  if (value?.toLowerCase() === "deny") return "denied";
  return "unknown";
}

export async function collectWindowsSystemContext(
  options: WindowsSystemContextOptions,
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const raw = await options.runPowerShell(SYSTEM_CONTEXT_PS, 15_000);
  const snapshot = JSON.parse(raw || "{}") as PowerShellSystemSnapshot;
  const profiles = arrayOf(snapshot.networkProfiles);
  const adapters = arrayOf(snapshot.adapters);
  const storage = arrayOf(snapshot.storage);
  const services = arrayOf(snapshot.services);
  const wifiProfile = profiles.find((profile) =>
    /wi-?fi|wireless|wlan/iu.test(profile.interfaceAlias ?? ""),
  );
  const configuredLocation = readConfiguredLocation(env);
  const networkLocation =
    configuredLocation || !networkGeolocationEnabled(env)
      ? undefined
      : await readNetworkLocation(options.fetchImpl ?? fetch, now);
  const regionLocation: ApproximateLocation | undefined = snapshot.homeRegion
    ? {
        source: "windows_region",
        approximate: true,
        country: snapshot.homeRegion.countryName,
        countryCode: snapshot.homeRegion.countryCode,
      }
    : undefined;
  const location = configuredLocation ?? networkLocation ?? regionLocation;
  const currentUser = userInfo();

  return {
    ok: true,
    capturedAt: now.toISOString(),
    clock: {
      localIso: localIsoString(now),
      utcIso: now.toISOString(),
      localDisplay: new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }).format(now),
      ianaTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      windowsTimezone: snapshot.timezone,
      locale: snapshot.culture,
    },
    location: {
      ...location,
      permission: permissionState(snapshot.privacy?.location),
      precise: location?.source === "configured" && location.approximate === false,
      settingsUri: "ms-settings:privacy-location",
      note:
        location?.source === "network"
          ? "Approximate network location; it can be wrong when using a VPN or mobile ISP."
          : location?.source === "windows_region"
            ? "Windows regional setting, not the device's live coordinates."
            : undefined,
    },
    network: {
      online: profiles.some(isConnected),
      wifi: wifiProfile
        ? {
            connected: isConnected(wifiProfile),
            ssid: wifiProfile.name,
            interfaceName: wifiProfile.interfaceAlias,
          }
        : { connected: false },
      profiles,
      adapters,
      addresses: localNetworkAddresses(),
      settingsUri: "ms-settings:network-status",
      wifiSettingsUri: "ms-settings:network-wifi",
    },
    power: snapshot.battery
      ? {
          batteryPercent: snapshot.battery.chargePercent,
          state: batteryState(snapshot.battery.batteryStatus),
          status: snapshot.battery.status,
          settingsUri: "ms-settings:powersleep",
        }
      : { batteryPresent: false, settingsUri: "ms-settings:powersleep" },
    operatingSystem: snapshot.operatingSystem,
    storage: storage.map((drive) => ({
      ...drive,
      usedPercent:
        drive.totalBytes && drive.freeBytes !== undefined
          ? Math.round(((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100)
          : undefined,
    })),
    session: {
      username: currentUser.username,
      homeDirectory: currentUser.homedir,
    },
    services,
    permissions: {
      location: permissionState(snapshot.privacy?.location),
      camera: permissionState(snapshot.privacy?.camera),
      microphone: permissionState(snapshot.privacy?.microphone),
      notifications:
        snapshot.privacy?.notifications === 1
          ? "allowed"
          : snapshot.privacy?.notifications === 0
            ? "denied"
            : "unknown",
      settings: {
        location: "ms-settings:privacy-location",
        camera: "ms-settings:privacy-webcam",
        microphone: "ms-settings:privacy-microphone",
        notifications: "ms-settings:notifications",
      },
    },
  };
}

export function resetSystemContextCachesForTests(): void {
  networkLocationCache = undefined;
}

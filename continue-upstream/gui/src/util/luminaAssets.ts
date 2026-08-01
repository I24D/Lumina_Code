declare global {
  interface Window {
    luminaAvatarUrl?: string;
    luminaWorkingUrl?: string;
    luminaCodePreferences?: Record<string, string>;
  }
}

export function getLuminaAssetUrl(fileName: string): string {
  if (window.vscMediaUrl) {
    return `${window.vscMediaUrl}/${fileName}`;
  }

  if (import.meta.env.DEV) {
    return `${window.location.origin}/${fileName}`;
  }

  return `/${fileName}`;
}

export {};

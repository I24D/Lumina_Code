import { ContextItem } from "../..";
import { fileURLToPath } from "node:url";
import {
  callLuminaBridge,
  resolveLuminaBridgeUrl,
  type LuminaBridgeCallArgs,
} from "../../luminaBridge/index.js";
import { ToolImpl } from ".";

function getBodyType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function getEndpointArg(args: Record<string, unknown>): string {
  const endpoint = args.endpoint;
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new Error(
      [
        "lumina_windows_bridge requires a non-empty string endpoint.",
        `Received endpoint: ${JSON.stringify(endpoint)}.`,
        `Received body type: ${getBodyType(args.body)}.`,
        'Correct format: {"endpoint":"/health","body":{}}',
      ].join(" "),
    );
  }

  return endpoint.trim();
}

export function normalizeLuminaBridgeToolBody(
  args: Record<string, unknown>,
  endpoint: string,
): Record<string, unknown> {
  const body = args.body;
  if (body === undefined || body === null || body === "") {
    return {};
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      [
        "lumina_windows_bridge body must be a JSON object, or empty for GET endpoints.",
        `Endpoint received: ${endpoint}.`,
        `Body type received: ${getBodyType(body)}.`,
        `Body value received: ${JSON.stringify(body)}.`,
        'Correct format: {"endpoint":"/health","body":{}}',
      ].join(" "),
    );
  }

  return body as Record<string, unknown>;
}

function formatBridgeOutput(endpoint: string, data: unknown): ContextItem[] {
  return [
    {
      name: "Lumina Windows Bridge",
      description: endpoint,
      content: JSON.stringify(data, null, 2),
      status: "Bridge call completed",
    },
  ];
}

function workspaceUriToFilePath(uri: string): string | undefined {
  if (!uri.trim()) {
    return undefined;
  }

  if (!uri.includes("://")) {
    return uri;
  }

  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function addWorkspaceContext(
  body: Record<string, unknown>,
  workspaceDirs: string[],
): Record<string, unknown> {
  const workspacePaths = workspaceDirs
    .map(workspaceUriToFilePath)
    .filter((path): path is string => Boolean(path));
  const workspaceDir = workspacePaths[0];
  if (!workspaceDir) {
    return body;
  }

  return {
    vscodeWorkspaceDirs: workspaceDirs,
    workspacePaths,
    workspaceDir,
    cwd: workspaceDir,
    ...body,
  };
}

export const luminaWindowsBridgeImpl: ToolImpl = async (args, extras) => {
  const endpoint = getEndpointArg(args);
  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  const body = normalizeLuminaBridgeToolBody(args, endpoint);
  const fallbackBridgeUrl = resolveLuminaBridgeUrl(workspaceDirs);
  const callArgs: LuminaBridgeCallArgs = {
    endpoint: endpoint as LuminaBridgeCallArgs["endpoint"],
    body: addWorkspaceContext(body, workspaceDirs),
    bridgeUrl:
      typeof args.bridgeUrl === "string" && args.bridgeUrl.trim()
        ? args.bridgeUrl.trim()
        : undefined,
  };

  const data = await callLuminaBridge(extras.fetch, callArgs, fallbackBridgeUrl);
  return formatBridgeOutput(endpoint, data);
};

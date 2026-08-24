export const RUNTIME_API_VERSION = "1.0.0";

export const runtimeOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Lumina Code Runtime API",
    version: RUNTIME_API_VERSION,
    description:
      "Stable local API for Lumina Code sessions, permissions, events, and delegated work.",
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        responses: { "200": { description: "Runtime health" } },
      },
    },
    "/state": {
      get: {
        operationId: "getState",
        responses: { "200": { description: "Current runtime state" } },
      },
    },
    "/events": {
      get: {
        operationId: "streamEvents",
        responses: {
          "200": {
            description: "Server-sent runtime event stream",
            content: { "text/event-stream": {} },
          },
        },
      },
    },
    "/sessions/{id}/children": {
      get: {
        operationId: "listChildSessions",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "Delegated child sessions" } },
      },
    },
    "/messages": {
      post: {
        operationId: "queueMessage",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string", minLength: 1 } },
              },
            },
          },
        },
        responses: {
          "202": { description: "Message queued" },
          "400": { description: "Invalid message" },
        },
      },
    },
    "/permissions": {
      post: {
        operationId: "resolvePermission",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["requestId", "approved"],
                properties: {
                  requestId: { type: "string", minLength: 1 },
                  approved: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Permission resolved" },
          "400": { description: "No matching permission request" },
        },
      },
    },
    "/pause": {
      post: {
        operationId: "pauseRun",
        responses: { "200": { description: "Pause result" } },
      },
    },
    "/diff": {
      get: {
        operationId: "getDiff",
        responses: {
          "200": { description: "Git diff" },
          "404": { description: "No Git repository" },
        },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        responses: { "200": { description: "OpenAPI contract" } },
      },
    },
  },
} as const;

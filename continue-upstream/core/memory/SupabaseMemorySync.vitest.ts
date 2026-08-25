import { describe, expect, it, vi } from "vitest";

import { emptyMemorySnapshot } from "./MemoryPersistence.js";
import {
  getMemorySyncStatus,
  SupabaseMemorySync,
} from "./SupabaseMemorySync.js";

describe("SupabaseMemorySync", () => {
  it("stays explicitly local when no Supabase settings exist", () => {
    expect(getMemorySyncStatus({})).toEqual({
      configured: false,
      provider: "local",
      state: "local",
    });
    expect(
      getMemorySyncStatus({ url: "https://project.supabase.co" }),
    ).toMatchObject({
      configured: false,
      provider: "supabase",
      state: "error",
    });
  });

  it("pulls with user auth, merges, then upserts without sending user_id", async () => {
    const remote = {
      ...emptyMemorySnapshot(),
      experiences: [
        {
          id: "remote",
          goal: "Remote experience",
          summary: "Synced from another device",
          outcome: "success" as const,
          toolNames: [],
          tags: [],
          createdAt: "2026-08-24T00:00:00.000Z",
        },
      ],
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ payload: remote }]), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sync = new SupabaseMemorySync(
      {
        url: "https://project.supabase.co",
        publishableKey: "sb_publishable_example",
        accessToken: "user-jwt",
        namespace: "laptop",
      },
      request,
    );
    const merged = await sync.sync(emptyMemorySnapshot());

    expect(merged.experiences[0].id).toBe("remote");
    const [getUrl, getInit] = request.mock.calls[0];
    expect(String(getUrl)).toContain("namespace=eq.laptop");
    expect((getInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer user-jwt",
    );
    const [, postInit] = request.mock.calls[1];
    const body = JSON.parse(String(postInit?.body));
    expect(body.namespace).toBe("laptop");
    expect(body.user_id).toBeUndefined();
    expect((postInit?.headers as Record<string, string>).Prefer).toContain(
      "merge-duplicates",
    );
  });

  it("rejects insecure remote endpoints before sending credentials", () => {
    expect(
      () =>
        new SupabaseMemorySync({
          url: "http://example.com",
          publishableKey: "key",
          accessToken: "token",
        }),
    ).toThrow(/HTTPS/i);
  });
});

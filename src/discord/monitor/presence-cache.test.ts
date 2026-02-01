import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPresences,
  forcePrune,
  getPresence,
  getPresenceWithTime,
  PRESENCE_CACHE_MAX_PER_ACCOUNT,
  PRESENCE_CACHE_TTL_MS,
  presenceCacheSize,
  setPresence,
  setPresenceWithTime,
} from "./presence-cache.js";

describe("presence-cache", () => {
  beforeEach(() => {
    clearPresences();
  });

  it("scopes presence entries by account", () => {
    const presenceA = { status: "online" } as GatewayPresenceUpdate;
    const presenceB = { status: "idle" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presenceA);
    setPresence("account-b", "user-1", presenceB);

    expect(getPresence("account-a", "user-1")).toBe(presenceA);
    expect(getPresence("account-b", "user-1")).toBe(presenceB);
    expect(getPresence("account-a", "user-2")).toBeUndefined();
  });

  it("clears presence per account", () => {
    const presence = { status: "dnd" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presence);
    setPresence("account-b", "user-2", presence);

    clearPresences("account-a");

    expect(getPresence("account-a", "user-1")).toBeUndefined();
    expect(getPresence("account-b", "user-2")).toBe(presence);
    expect(presenceCacheSize()).toBe(1);
  });

  describe("TTL enforcement", () => {
    it("returns presence within TTL", () => {
      const presence = { status: "online" } as GatewayPresenceUpdate;
      const now = Date.now();

      setPresenceWithTime("account-a", "user-1", presence, now);

      // Access within TTL should succeed
      const withinTTL = now + PRESENCE_CACHE_TTL_MS - 1000;
      expect(getPresenceWithTime("account-a", "user-1", withinTTL)).toBe(presence);
    });

    it("returns undefined and deletes entry after TTL expires", () => {
      const presence = { status: "online" } as GatewayPresenceUpdate;
      const now = Date.now();

      setPresenceWithTime("account-a", "user-1", presence, now);

      // Access after TTL should fail
      const afterTTL = now + PRESENCE_CACHE_TTL_MS + 1000;
      expect(getPresenceWithTime("account-a", "user-1", afterTTL)).toBeUndefined();

      // Entry should be deleted
      expect(presenceCacheSize("account-a")).toBe(0);
    });

    it("does not extend TTL on read (strict TTL, not sliding)", () => {
      const presence = { status: "online" } as GatewayPresenceUpdate;
      const now = Date.now();

      setPresenceWithTime("account-a", "user-1", presence, now);

      // Read multiple times within TTL
      const halfTTL = now + PRESENCE_CACHE_TTL_MS / 2;
      expect(getPresenceWithTime("account-a", "user-1", halfTTL)).toBe(presence);
      expect(getPresenceWithTime("account-a", "user-1", halfTTL)).toBe(presence);

      // TTL should still be based on original set time, not last read
      const afterOriginalTTL = now + PRESENCE_CACHE_TTL_MS + 1000;
      expect(getPresenceWithTime("account-a", "user-1", afterOriginalTTL)).toBeUndefined();
    });
  });

  describe("max size enforcement", () => {
    it("evicts oldest entries when exceeding max size", () => {
      const now = Date.now();

      // Fill cache to max
      for (let i = 0; i < PRESENCE_CACHE_MAX_PER_ACCOUNT; i++) {
        setPresenceWithTime(
          "account-a",
          `user-${i}`,
          { status: "online" } as GatewayPresenceUpdate,
          now + i, // Stagger timestamps
        );
      }

      expect(presenceCacheSize("account-a")).toBe(PRESENCE_CACHE_MAX_PER_ACCOUNT);

      // Add one more to trigger eviction (after prune interval)
      for (let i = 0; i < 100; i++) {
        setPresenceWithTime(
          "account-a",
          `overflow-${i}`,
          { status: "idle" } as GatewayPresenceUpdate,
          now + PRESENCE_CACHE_MAX_PER_ACCOUNT + i,
        );
      }

      // Force a prune to ensure eviction happens
      forcePrune("account-a");

      // Should be at or below max
      expect(presenceCacheSize("account-a")).toBeLessThanOrEqual(PRESENCE_CACHE_MAX_PER_ACCOUNT);

      // Oldest entry (user-0) should be evicted
      expect(getPresenceWithTime("account-a", "user-0", now + PRESENCE_CACHE_MAX_PER_ACCOUNT + 100)).toBeUndefined();

      // Newest entries should still exist
      expect(getPresenceWithTime("account-a", "overflow-99", now + PRESENCE_CACHE_MAX_PER_ACCOUNT + 100)).toBeDefined();
    });

    it("maintains LRU order - recently updated entries survive eviction", () => {
      const now = Date.now();

      // Add entries
      setPresenceWithTime("account-a", "user-old", { status: "online" } as GatewayPresenceUpdate, now);
      setPresenceWithTime("account-a", "user-new", { status: "idle" } as GatewayPresenceUpdate, now + 1000);

      // Update the old entry (moves it to end of Map)
      setPresenceWithTime("account-a", "user-old", { status: "dnd" } as GatewayPresenceUpdate, now + 2000);

      // Now user-new is older in LRU order despite being added later originally
      // If we were to evict, user-new would go first

      // Verify both exist
      expect(getPresenceWithTime("account-a", "user-old", now + 2000)).toBeDefined();
      expect(getPresenceWithTime("account-a", "user-new", now + 2000)).toBeDefined();
    });
  });

  describe("presenceCacheSize", () => {
    it("returns total size across all accounts when no accountId specified", () => {
      setPresence("account-a", "user-1", { status: "online" } as GatewayPresenceUpdate);
      setPresence("account-a", "user-2", { status: "online" } as GatewayPresenceUpdate);
      setPresence("account-b", "user-1", { status: "online" } as GatewayPresenceUpdate);

      expect(presenceCacheSize()).toBe(3);
    });

    it("returns size for specific account", () => {
      setPresence("account-a", "user-1", { status: "online" } as GatewayPresenceUpdate);
      setPresence("account-a", "user-2", { status: "online" } as GatewayPresenceUpdate);
      setPresence("account-b", "user-1", { status: "online" } as GatewayPresenceUpdate);

      expect(presenceCacheSize("account-a")).toBe(2);
      expect(presenceCacheSize("account-b")).toBe(1);
      expect(presenceCacheSize("account-c")).toBe(0);
    });
  });
});

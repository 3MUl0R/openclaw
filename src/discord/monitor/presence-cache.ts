import type { GatewayPresenceUpdate } from "discord-api-types/v10";

/**
 * In-memory cache of Discord user presence data.
 * Populated by PRESENCE_UPDATE gateway events when the GuildPresences intent is enabled.
 *
 * Implements TTL and max size bounds to prevent unbounded memory growth.
 * See: https://github.com/openclaw/openclaw/issues/6019
 */

/** TTL for presence entries (1 hour). */
const TTL_MS = 60 * 60 * 1000;

/** Maximum entries per account to prevent memory exhaustion. */
const MAX_ENTRIES_PER_ACCOUNT = 10_000;

type PresenceEntry = {
  data: GatewayPresenceUpdate;
  timestamp: number;
};

type AccountCache = {
  entries: Map<string, PresenceEntry>;
};

const presenceCache = new Map<string, AccountCache>();

function resolveAccountKey(accountId?: string): string {
  return accountId ?? "default";
}

function getOrCreateAccountCache(accountKey: string): AccountCache {
  let accountCache = presenceCache.get(accountKey);
  if (!accountCache) {
    accountCache = { entries: new Map() };
    presenceCache.set(accountKey, accountCache);
  }
  return accountCache;
}

/**
 * Remove expired entries from the cache.
 * Called periodically during set/get operations.
 */
function pruneExpired(cache: AccountCache, now: number): void {
  const cutoff = now - TTL_MS;
  for (const [userId, entry] of cache.entries) {
    if (entry.timestamp < cutoff) {
      cache.entries.delete(userId);
    }
  }
}

/**
 * Evict oldest entries if cache exceeds max size.
 * Uses LRU-style eviction (oldest timestamp first).
 */
function enforceMaxSize(cache: AccountCache): void {
  if (cache.entries.size <= MAX_ENTRIES_PER_ACCOUNT) {
    return;
  }

  // Sort by timestamp and remove oldest entries
  const sorted = [...cache.entries.entries()].sort(
    (a, b) => a[1].timestamp - b[1].timestamp,
  );

  const toRemove = sorted.slice(0, cache.entries.size - MAX_ENTRIES_PER_ACCOUNT);
  for (const [userId] of toRemove) {
    cache.entries.delete(userId);
  }
}

/** Update cached presence for a user. */
export function setPresence(
  accountId: string | undefined,
  userId: string,
  data: GatewayPresenceUpdate,
): void {
  const accountKey = resolveAccountKey(accountId);
  const cache = getOrCreateAccountCache(accountKey);
  const now = Date.now();

  // Update or insert entry
  cache.entries.set(userId, { data, timestamp: now });

  // Periodic maintenance: prune expired and enforce max size
  // Only run when cache is getting large to avoid overhead
  if (cache.entries.size > MAX_ENTRIES_PER_ACCOUNT) {
    pruneExpired(cache, now);
    enforceMaxSize(cache);
  }
}

/** Get cached presence for a user. Returns undefined if not cached or expired. */
export function getPresence(
  accountId: string | undefined,
  userId: string,
): GatewayPresenceUpdate | undefined {
  const cache = presenceCache.get(resolveAccountKey(accountId));
  if (!cache) {
    return undefined;
  }

  const entry = cache.entries.get(userId);
  if (!entry) {
    return undefined;
  }

  // Check if expired
  const now = Date.now();
  if (now - entry.timestamp > TTL_MS) {
    cache.entries.delete(userId);
    return undefined;
  }

  // Update timestamp on access (LRU behavior)
  entry.timestamp = now;
  return entry.data;
}

/** Clear cached presence data. */
export function clearPresences(accountId?: string): void {
  if (accountId) {
    presenceCache.delete(resolveAccountKey(accountId));
    return;
  }
  presenceCache.clear();
}

/** Get the number of cached presence entries. */
export function presenceCacheSize(accountId?: string): number {
  if (accountId) {
    return presenceCache.get(resolveAccountKey(accountId))?.entries.size ?? 0;
  }
  let total = 0;
  for (const cache of presenceCache.values()) {
    total += cache.entries.size;
  }
  return total;
}

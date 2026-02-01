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

/** Prune frequency - only prune every N sets to amortize cost. */
const PRUNE_INTERVAL = 100;

type PresenceEntry = {
  data: GatewayPresenceUpdate;
  /** Timestamp when the presence was last updated (not accessed). */
  updatedAt: number;
};

type AccountCache = {
  entries: Map<string, PresenceEntry>;
  /** Counter for amortized pruning. */
  setCount: number;
};

const presenceCache = new Map<string, AccountCache>();

function resolveAccountKey(accountId?: string): string {
  return accountId ?? "default";
}

function getOrCreateAccountCache(accountKey: string): AccountCache {
  let accountCache = presenceCache.get(accountKey);
  if (!accountCache) {
    accountCache = { entries: new Map(), setCount: 0 };
    presenceCache.set(accountKey, accountCache);
  }
  return accountCache;
}

/**
 * Remove expired entries from the cache.
 * O(n) but only called periodically via amortized pruning.
 */
function pruneExpired(cache: AccountCache, now: number): void {
  const cutoff = now - TTL_MS;
  for (const [userId, entry] of cache.entries) {
    if (entry.updatedAt < cutoff) {
      cache.entries.delete(userId);
    }
  }
}

/**
 * Evict oldest entries if cache exceeds max size.
 * Uses Map insertion order for O(1) amortized LRU - oldest entries are first.
 */
function enforceMaxSize(cache: AccountCache): void {
  // Delete from the front (oldest) until within bounds
  while (cache.entries.size > MAX_ENTRIES_PER_ACCOUNT) {
    const oldestKey = cache.entries.keys().next().value;
    if (oldestKey === undefined) break;
    cache.entries.delete(oldestKey);
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

  // Delete then set to move to end of Map (maintains LRU order)
  cache.entries.delete(userId);
  cache.entries.set(userId, { data, updatedAt: now });

  // Amortized maintenance: prune and enforce max size periodically
  cache.setCount++;
  if (cache.setCount >= PRUNE_INTERVAL) {
    cache.setCount = 0;
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

  // Check if expired (strict TTL - not updated on read)
  const now = Date.now();
  if (now - entry.updatedAt > TTL_MS) {
    cache.entries.delete(userId);
    return undefined;
  }

  // Note: We intentionally do NOT update the timestamp on read.
  // TTL is based on when the presence was last updated by Discord,
  // not when it was last accessed.
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

/**
 * Exported for testing: allows injecting a custom "now" timestamp.
 * @internal
 */
export function setPresenceWithTime(
  accountId: string | undefined,
  userId: string,
  data: GatewayPresenceUpdate,
  now: number,
): void {
  const accountKey = resolveAccountKey(accountId);
  const cache = getOrCreateAccountCache(accountKey);

  cache.entries.delete(userId);
  cache.entries.set(userId, { data, updatedAt: now });

  cache.setCount++;
  if (cache.setCount >= PRUNE_INTERVAL) {
    cache.setCount = 0;
    pruneExpired(cache, now);
    enforceMaxSize(cache);
  }
}

/**
 * Exported for testing: get presence with custom "now" for TTL check.
 * @internal
 */
export function getPresenceWithTime(
  accountId: string | undefined,
  userId: string,
  now: number,
): GatewayPresenceUpdate | undefined {
  const cache = presenceCache.get(resolveAccountKey(accountId));
  if (!cache) {
    return undefined;
  }

  const entry = cache.entries.get(userId);
  if (!entry) {
    return undefined;
  }

  if (now - entry.updatedAt > TTL_MS) {
    cache.entries.delete(userId);
    return undefined;
  }

  return entry.data;
}

/**
 * Exported for testing: force a prune cycle.
 * @internal
 */
export function forcePrune(accountId?: string): void {
  const now = Date.now();
  if (accountId) {
    const cache = presenceCache.get(resolveAccountKey(accountId));
    if (cache) {
      pruneExpired(cache, now);
      enforceMaxSize(cache);
    }
  } else {
    for (const cache of presenceCache.values()) {
      pruneExpired(cache, now);
      enforceMaxSize(cache);
    }
  }
}

/** Exported constants for testing. */
export const PRESENCE_CACHE_TTL_MS = TTL_MS;
export const PRESENCE_CACHE_MAX_PER_ACCOUNT = MAX_ENTRIES_PER_ACCOUNT;

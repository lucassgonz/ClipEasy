/** LRU-ish blob URL cache to avoid re-fetching the same asset and to revoke safely. */

const cache = new Map<string, string>();
const MAX_ENTRIES = 3;

function key(projectId: string, assetId: string): string {
  return `${projectId}:${assetId}`;
}

export function getCachedMediaUrl(
  projectId: string,
  assetId: string,
): string | undefined {
  return cache.get(key(projectId, assetId));
}

export function setCachedMediaUrl(
  projectId: string,
  assetId: string,
  url: string,
): void {
  const k = key(projectId, assetId);
  const prev = cache.get(k);
  if (prev && prev !== url) URL.revokeObjectURL(prev);
  if (cache.has(k)) cache.delete(k);
  cache.set(k, url);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const oldUrl = cache.get(oldest);
    cache.delete(oldest);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
}

export function releaseCachedMedia(
  projectId: string,
  assetId?: string,
): void {
  if (assetId) {
    const k = key(projectId, assetId);
    const url = cache.get(k);
    if (url) {
      URL.revokeObjectURL(url);
      cache.delete(k);
    }
    return;
  }
  for (const [k, url] of cache) {
    if (k.startsWith(`${projectId}:`)) {
      URL.revokeObjectURL(url);
      cache.delete(k);
    }
  }
}

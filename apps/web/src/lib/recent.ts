/**
 * Sender-side share index, kept in LocalStorage.
 *
 * Reason: v1 has no account / login. Edit tokens live only in the URL fragment
 * the user gets back at upload time. If they don't bookmark that URL we'd
 * lose them. LocalStorage gives a per-browser fallback list so they can find
 * shares they made on this device, including the edit URL.
 *
 * Trade-off: cross-device users still need to keep their edit URL. This is
 * documented; v2 may add account-based recovery.
 */

const KEY = 'qhs.recent.v1';
const MAX = 50;

export interface RecentShare {
  slug: string;
  shareUrl: string;
  editUrl: string; // includes #edit=<token>
  createdAt: string; // ISO
}

export function loadRecent(): RecentShare[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentShare[]) : [];
  } catch {
    return [];
  }
}

export function rememberShare(s: Omit<RecentShare, 'createdAt'>): void {
  if (typeof localStorage === 'undefined') return;
  const existing = loadRecent().filter((r) => r.slug !== s.slug);
  const next: RecentShare[] = [
    { ...s, createdAt: new Date().toISOString() },
    ...existing,
  ].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function forgetShare(slug: string): void {
  if (typeof localStorage === 'undefined') return;
  const next = loadRecent().filter((r) => r.slug !== slug);
  localStorage.setItem(KEY, JSON.stringify(next));
}

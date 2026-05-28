// Local persistence of edit tokens at ~/.qhs/shares.json.
//
// Mirrors the "Recent on this device" pattern from the web dashboard: tokens
// stay on the user's machine, never on our server. Shared format with the
// Claude Code skill, so MCP and skill can see the same history.
//
// Concurrency: read-modify-write, last write wins. Acceptable because the
// realistic concurrency is "user runs MCP and skill at the same time", which
// would only race when they both call qhs_share within the same millisecond.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface StoredShare {
  slug: string;
  editToken: string;
  shareUrl: string;
  editUrl: string;
  createdAt: string;
  title?: string;
}

interface Store {
  version: 1;
  shares: StoredShare[];
}

const STORE_PATH = join(homedir(), '.qhs', 'shares.json');

async function loadStore(): Promise<Store> {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !Array.isArray(parsed.shares)) {
      return { version: 1, shares: [] };
    }
    return parsed as Store;
  } catch (err) {
    // ENOENT or parse failure → start fresh.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, shares: [] };
    }
    // Corrupt file: don't blow away silently. Surface so user can investigate.
    throw new Error(`Failed to read ${STORE_PATH}: ${(err as Error).message}`);
  }
}

async function saveStore(store: Store): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

export async function rememberShare(share: StoredShare): Promise<void> {
  const store = await loadStore();
  // De-dupe on slug — if same slug shows up twice (shouldn't happen but
  // belt-and-braces), keep the latest entry.
  store.shares = store.shares.filter((s) => s.slug !== share.slug);
  store.shares.unshift(share);
  // Cap at 200 to keep file small; older entries fall off.
  if (store.shares.length > 200) store.shares.length = 200;
  await saveStore(store);
}

export async function findShare(slug: string): Promise<StoredShare | null> {
  const store = await loadStore();
  return store.shares.find((s) => s.slug === slug) ?? null;
}

export async function forgetShare(slug: string): Promise<void> {
  const store = await loadStore();
  store.shares = store.shares.filter((s) => s.slug !== slug);
  await saveStore(store);
}

export async function listShares(): Promise<StoredShare[]> {
  const store = await loadStore();
  return store.shares;
}

export const STORAGE_PATH = STORE_PATH;

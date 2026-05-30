#!/usr/bin/env node
// Standalone CLI helper for the qhs Claude Code skill.
//
// Zero external deps — uses only Node built-ins (>= 18). Talks to the hosted
// qhs API and persists edit tokens at ~/.qhs/shares.json. Same store format
// as the MCP server, so installing both is fine: they see each other's shares.
//
// Endpoint is hardcoded to the production worker. QHS_ENDPOINT env var exists
// for internal dev only — intentionally undocumented in SKILL.md so end users
// don't bypass the hosted service.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ENDPOINT = process.env.QHS_ENDPOINT ?? 'https://api.qhs.fyi';
const STORE_PATH = join(homedir(), '.qhs', 'shares.json');
const USER_AGENT = 'qhs-skill/0.2.0';

// ---------- storage -----------------------------------------------------------

async function loadStore() {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.shares)) {
      return { version: 1, shares: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, shares: [] };
    throw new Error(`Failed to read ${STORE_PATH}: ${err.message}`);
  }
}

async function saveStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

async function rememberShare(share) {
  const store = await loadStore();
  store.shares = store.shares.filter((s) => s.slug !== share.slug);
  store.shares.unshift(share);
  if (store.shares.length > 200) store.shares.length = 200;
  await saveStore(store);
}

async function findShare(slug) {
  const store = await loadStore();
  return store.shares.find((s) => s.slug === slug) ?? null;
}

async function forgetShare(slug) {
  const store = await loadStore();
  store.shares = store.shares.filter((s) => s.slug !== slug);
  await saveStore(store);
}

// ---------- http client -------------------------------------------------------

async function call(path, init) {
  const r = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`qhs ${init.method ?? 'GET'} ${path} → ${r.status}: ${text}`);
  }
  return r.json();
}

// ---------- input helpers -----------------------------------------------------

async function readHtmlArg(arg) {
  if (!arg) throw new Error('Missing file argument. Use - for stdin.');
  if (arg === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  return await readFile(arg, 'utf8');
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, ...rest] = arg.slice(2).split('=');
      flags[k] = rest.length > 0 ? rest.join('=') : true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ---------- commands ----------------------------------------------------------

const commands = {
  async share(argv) {
    const { flags, positional } = parseFlags(argv);
    const html = await readHtmlArg(positional[0]);
    const r = await call('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    await rememberShare({
      slug: r.slug,
      editToken: r.editToken,
      shareUrl: r.shareUrl,
      editUrl: r.editUrl,
      createdAt: new Date().toISOString(),
      title: flags.title,
    });
    console.log(JSON.stringify(r, null, 2));
  },

  async edit(argv) {
    const { flags, positional } = parseFlags(argv);
    const slug = positional[0];
    if (!slug) throw new Error('Usage: qhs edit <slug> <file|->');
    const html = await readHtmlArg(positional[1]);
    const token = flags['edit-token'] ?? (await findShare(slug))?.editToken;
    if (!token) {
      throw new Error(
        `No edit token for "${slug}" in ${STORE_PATH}. Pass --edit-token=<value> from the share's edit URL.`,
      );
    }
    const r = await call('/api/edit/' + encodeURIComponent(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, editToken: token }),
    });
    console.log(JSON.stringify(r, null, 2));
  },

  async delete(argv) {
    const { flags, positional } = parseFlags(argv);
    const slug = positional[0];
    if (!slug) throw new Error('Usage: qhs delete <slug>');
    const token = flags['edit-token'] ?? (await findShare(slug))?.editToken;
    if (!token) {
      throw new Error(
        `No edit token for "${slug}". Pass --edit-token=<value> from the share's edit URL.`,
      );
    }
    const r = await call('/api/share/' + encodeURIComponent(slug), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken: token }),
    });
    await forgetShare(slug);
    console.log(JSON.stringify(r, null, 2));
  },

  async stats(argv) {
    const { positional } = parseFlags(argv);
    const slug = positional[0];
    if (!slug) throw new Error('Usage: qhs stats <slug>');
    const r = await call('/api/share/' + encodeURIComponent(slug) + '/stats', {
      method: 'GET',
    });
    console.log(JSON.stringify(r, null, 2));
  },

  async list() {
    const store = await loadStore();
    console.log(JSON.stringify({ shares: store.shares }, null, 2));
  },
};

// ---------- entry -------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.error('Usage: qhs <share|edit|delete|stats|list> [args]');
  console.error('');
  console.error('  qhs share <file|->              [--title="label"]');
  console.error('  qhs edit <slug> <file|->        [--edit-token=...]');
  console.error('  qhs delete <slug>               [--edit-token=...]');
  console.error('  qhs stats <slug>');
  console.error('  qhs list');
  process.exit(1);
}

try {
  await commands[cmd](rest);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

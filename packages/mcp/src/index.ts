#!/usr/bin/env node
// MCP server for quick-html-sharing.
//
// Runs over stdio (the standard MCP transport). The launching client
// (Claude Desktop, Cursor, Codex CLI, etc.) spawns this binary via npx and
// communicates over the spawned process's stdin/stdout.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { deleteShare, editHtml, getStats, uploadHtml } from './client.js';
import { findShare, listShares, rememberShare, forgetShare, STORAGE_PATH } from './storage.js';

const server = new McpServer({
  name: 'quick-html-share',
  version: '0.2.1',
});

// ---------- qhs_share ---------------------------------------------------------
server.tool(
  'qhs_share',
  [
    'Upload an HTML document (or self-contained snippet) and get back a public,',
    "unguessable shareable URL plus a private edit URL. Use this whenever the user",
    "wants to share, preview, demo, publish, or 'send a link for' some HTML they",
    "wrote/generated. Typical triggers: 'share this HTML', 'give me a link to send',",
    "'put this online', 'publish this page', 'preview in browser', 'send to a friend'.",
    '',
    'The share URL is unguessable (~62 bits of entropy) and acts as a soft secret —',
    'only people with the link can view. No login required for viewers.',
    '',
    'IMPORTANT: After calling this, tell the user the editUrl is private and they',
    'should save it themselves — it is the only way to update or delete the share',
    'later. The token is also persisted locally at ~/.qhs/shares.json so qhs_edit',
    'and qhs_delete can find it.',
  ].join(' '),
  {
    html: z.string().min(1).describe('The full HTML document or self-contained snippet to publish.'),
    title: z
      .string()
      .optional()
      .describe('Optional local-only label to help the user identify this share later. Not sent to server.'),
  },
  async ({ html, title }) => {
    const r = await uploadHtml(html);
    await rememberShare({
      slug: r.slug,
      editToken: r.editToken,
      shareUrl: r.shareUrl,
      editUrl: r.editUrl,
      createdAt: new Date().toISOString(),
      title,
    });
    return {
      content: [
        {
          type: 'text',
          text: [
            `Shared! Slug: ${r.slug}`,
            ``,
            `Share URL (give this out):`,
            `  ${r.shareUrl}`,
            ``,
            `Edit URL (private — save it; needed to update or delete later):`,
            `  ${r.editUrl}`,
            ``,
            `Stats: https://api.qhs.fyi/api/share/${r.slug}/stats`,
          ].join('\n'),
        },
      ],
    };
  },
);

// ---------- qhs_edit ----------------------------------------------------------
server.tool(
  'qhs_edit',
  [
    'Replace the HTML at a previously shared slug. Use when the user wants to update',
    "a share they already created — e.g. 'fix the typo on the page I shared',",
    "'update that demo with the new code'. The shareUrl stays the same; viewers",
    'who already loaded the page need to refresh.',
    '',
    'Requires an edit token in ~/.qhs/shares.json (populated when qhs_share or the',
    'companion Claude Code skill created the share). If the slug is unknown, ask the',
    'user to paste their edit URL — the part after #edit= is the token.',
  ].join(' '),
  {
    slug: z.string().regex(/^[a-z0-9]{8,16}$/, 'Slug must be 8-16 lowercase alphanumerics.'),
    html: z.string().min(1),
    editToken: z
      .string()
      .optional()
      .describe('Override the locally-stored edit token. Pass this if the user supplied a fresh edit URL.'),
  },
  async ({ slug, html, editToken }) => {
    const token = editToken ?? (await findShare(slug))?.editToken;
    if (!token) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `No edit token found for slug "${slug}" in ${STORAGE_PATH}. ` +
              `Ask the user to paste the edit URL (the part after #edit= is the token) ` +
              `and call qhs_edit again with the editToken argument.`,
          },
        ],
      };
    }
    await editHtml(slug, html, token);
    return {
      content: [
        {
          type: 'text',
          text: `Updated ${slug}. Viewers who already loaded the share need to refresh to see the change.`,
        },
      ],
    };
  },
);

// ---------- qhs_delete --------------------------------------------------------
server.tool(
  'qhs_delete',
  [
    'Permanently delete a previously shared HTML. After this, the share URL returns',
    "404. Use when the user says 'delete my share', 'take that page down',",
    "'remove the demo I posted'. Requires an edit token (same as qhs_edit).",
    '',
    'Idempotent: re-deleting an already-deleted slug returns ok.',
  ].join(' '),
  {
    slug: z.string().regex(/^[a-z0-9]{8,16}$/),
    editToken: z.string().optional(),
  },
  async ({ slug, editToken }) => {
    const token = editToken ?? (await findShare(slug))?.editToken;
    if (!token) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `No edit token found for slug "${slug}". Ask the user to paste the ` +
              `edit URL and pass editToken explicitly.`,
          },
        ],
      };
    }
    await deleteShare(slug, token);
    await forgetShare(slug);
    return {
      content: [{ type: 'text', text: `Deleted ${slug}. The share URL now returns 404.` }],
    };
  },
);

// ---------- qhs_stats ---------------------------------------------------------
server.tool(
  'qhs_stats',
  [
    'Get view statistics for a share: total view count, last viewed time, created time,',
    "and whether the share is deleted. Use when the user asks 'did anyone see my share',",
    "'how many views', 'check who looked at it', 'is the demo getting traffic'.",
    '',
    'No edit token required — anyone with the slug can read stats (matches the',
    'product’s "link is the secret" model).',
  ].join(' '),
  {
    slug: z.string().regex(/^[a-z0-9]{8,16}$/),
  },
  async ({ slug }) => {
    const stats = await getStats(slug);
    return {
      content: [
        {
          type: 'text',
          text: [
            `Slug: ${stats.slug}`,
            `Created: ${stats.createdAt}`,
            `Views: ${stats.views}`,
            `Last viewed: ${stats.lastViewedAt ?? 'never'}`,
            `Deleted: ${stats.deleted ? 'yes' : 'no'}`,
          ].join('\n'),
        },
      ],
    };
  },
);

// ---------- qhs_list ----------------------------------------------------------
// Bonus tool: lets the user (via the LLM) recover slugs they shared from this
// machine but can't remember. Reads ~/.qhs/shares.json only — never hits the
// server, never reveals shares created from other machines.
server.tool(
  'qhs_list',
  [
    'List shares this machine has created via qhs_share or the companion skill.',
    "Use when the user asks 'what have I shared', 'list my shares', 'show recent",
    "links'. Returns slug + shareUrl + createdAt + optional title from local",
    'storage only (~/.qhs/shares.json). Does NOT include shares created from other',
    'machines.',
  ].join(' '),
  {},
  async () => {
    const shares = await listShares();
    if (shares.length === 0) {
      return { content: [{ type: 'text', text: 'No shares stored on this machine yet.' }] };
    }
    const lines = shares.map((s, i) => {
      const label = s.title ? ` — ${s.title}` : '';
      return `${i + 1}. ${s.slug}${label}\n   ${s.shareUrl}\n   created ${s.createdAt}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

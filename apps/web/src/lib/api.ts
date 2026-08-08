import type {
  ClaimResponse,
  MySharesResponse,
  RestoreResponse,
  ShareStats,
  UploadResponse,
  VersionListResponse,
} from '@qhs/shared';

const API_BASE = (import.meta.env.PUBLIC_API_BASE as string | undefined) ?? '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: 'invalid_response', message: text };
  }
  if (!res.ok) {
    const e = data as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/**
 * Sync key travels ONLY in the Authorization header — NEVER a path/query, where
 * it would leak into request logs (mirrors the worker's iron rule).
 */
function bearer(syncKey: string): Record<string, string> {
  return { Authorization: `Bearer ${syncKey}` };
}

/**
 * D20: when a sync key exists on this device, upload auto-attaches it so the new
 * share is enrolled into My Shares at INSERT time. No new UI; absence of a key
 * is the legacy (unenrolled) path, byte-for-byte unchanged.
 */
export async function uploadHtml(html: string, syncKey?: string): Promise<UploadResponse> {
  return call<UploadResponse>('/upload', {
    method: 'POST',
    body: JSON.stringify({ html }),
    headers: syncKey ? bearer(syncKey) : undefined,
  });
}

export async function listMyShares(
  syncKey: string,
  cursor?: string | null,
): Promise<MySharesResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return call<MySharesResponse>(`/my-shares${qs}`, {
    method: 'GET',
    headers: bearer(syncKey),
  });
}

export async function claimShares(syncKey: string, editTokens: string[]): Promise<ClaimResponse> {
  return call<ClaimResponse>('/my-shares/claim', {
    method: 'POST',
    headers: bearer(syncKey),
    body: JSON.stringify({ editTokens }),
  });
}

/**
 * Owner-key delete (no edit token needed). The worker's DELETE takes the
 * owner-key path whenever a Bearer is present — body is ignored — so the share
 * must already be owned by this key (everything in the My Shares list is).
 */
export async function deleteShareWithKey(
  slug: string,
  syncKey: string,
): Promise<{ slug: string; ok: true }> {
  return call(`/share/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: bearer(syncKey),
  });
}

export async function editHtml(
  slug: string,
  html: string,
  editToken: string,
): Promise<{ slug: string; ok: true }> {
  return call(`/edit/${encodeURIComponent(slug)}`, {
    method: 'POST',
    body: JSON.stringify({ html, editToken }),
  });
}

export async function deleteShare(
  slug: string,
  editToken: string,
): Promise<{ slug: string; ok: true }> {
  return call(`/share/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    body: JSON.stringify({ editToken }),
  });
}

export async function getStats(slug: string): Promise<ShareStats> {
  return call(`/share/${encodeURIComponent(slug)}/stats`, {
    method: 'GET',
  });
}

/**
 * Version endpoints take either credential. Exactly one is sent: a sync key
 * goes in the Authorization header, an edit token in the body. Never both —
 * the worker treats the bearer as authoritative and ignores a body token, so
 * sending both would silently hide which one actually authorized the call.
 */
export type VersionCredentials = { editToken: string } | { syncKey: string };

function credentialParts(creds: VersionCredentials): {
  headers?: Record<string, string>;
  body: string;
} {
  return 'syncKey' in creds
    ? { headers: bearer(creds.syncKey), body: '{}' }
    : { body: JSON.stringify({ editToken: creds.editToken }) };
}

export async function listVersions(
  slug: string,
  creds: VersionCredentials,
): Promise<VersionListResponse> {
  const { headers, body } = credentialParts(creds);
  return call<VersionListResponse>(`/share/${encodeURIComponent(slug)}/versions`, {
    method: 'POST',
    headers,
    body,
  });
}

/**
 * Returns the raw source of an old version as text, not rendered HTML — the
 * point is to let the sender read a version before republishing it to everyone
 * holding the link.
 */
export async function getVersionSource(
  slug: string,
  version: number,
  creds: VersionCredentials,
): Promise<string> {
  const { headers, body } = credentialParts(creds);
  const res = await fetch(`${API_BASE}/share/${encodeURIComponent(slug)}/versions/${version}/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: { error?: string; message?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON error body; fall through to the generic message.
    }
    throw new ApiError(res.status, parsed.error ?? 'error', parsed.message ?? `HTTP ${res.status}`);
  }
  return res.text();
}

export async function restoreVersion(
  slug: string,
  version: number,
  creds: VersionCredentials,
): Promise<RestoreResponse> {
  const { headers, body } = credentialParts(creds);
  return call<RestoreResponse>(`/share/${encodeURIComponent(slug)}/versions/${version}/restore`, {
    method: 'POST',
    headers,
    body,
  });
}

export async function reportShare(
  slug: string,
  reason: string,
  reporterEmail?: string,
): Promise<{ slug: string; ok: true; deduped?: boolean }> {
  return call(`/report/${encodeURIComponent(slug)}`, {
    method: 'POST',
    body: JSON.stringify({ reason, reporterEmail }),
  });
}

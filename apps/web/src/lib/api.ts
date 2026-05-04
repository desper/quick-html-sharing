import type { ShareStats, UploadResponse } from '@qhs/shared';

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

export async function uploadHtml(html: string): Promise<UploadResponse> {
  return call<UploadResponse>('/upload', {
    method: 'POST',
    body: JSON.stringify({ html }),
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

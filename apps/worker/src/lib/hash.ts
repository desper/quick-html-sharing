/** Returns sha256 of a string as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Hashes a client IP with a per-environment salt.
 *
 * Why salt: if logs leak, raw sha256(ip) is reversible (the whole IPv4 space is
 * 2^32). Adding a server-only salt makes the hash useless without the salt too.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${ip}`);
}

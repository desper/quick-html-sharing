import { describe, expect, it } from 'vitest';
import { isBotUserAgent } from '../src/lib/bot';

/**
 * Real UA strings. The false-positive half of this suite matters more than the
 * true-positive half: misclassifying a person deletes a view the sender was
 * waiting for, and they have no way to tell it happened.
 */
const BOTS = [
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  'Twitterbot/1.0',
  'TelegramBot (like TwitterBot)',
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; LinkedInBot/1.0; +http://www.linkedin.com)',
  // Caught by the generic bot.html self-identification, not a brand rule —
  // Pinterest's in-app browser reuses the brand name (see HUMANS below).
  'Pinterest/0.2 (+http://www.pinterest.com/bot.html)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)',
  'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'curl/8.4.0',
  'Wget/1.21.4',
  'python-requests/2.31.0',
  'Go-http-client/2.0',
  'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
  'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36',
];

const HUMANS = [
  // Desktop browsers
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  // Mobile
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  // In-app browsers — a real person reading inside a social app. These share
  // brand names with the same platforms' unfurl crawlers, which is exactly
  // why the crawler patterns are anchored with a trailing slash.
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.113',
];

describe('isBotUserAgent', () => {
  it.each(BOTS)('flags %s', (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it.each(HUMANS)('does not flag %s', (ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });

  it('treats a missing UA as human', () => {
    // A false positive silently destroys a real view; a false negative just
    // inflates the count by one. Bias toward the recoverable error.
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
  });

  it('matches regardless of case', () => {
    expect(isBotUserAgent('SLACKBOT-LINKEXPANDING 1.0')).toBe(true);
  });
});

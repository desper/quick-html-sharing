/**
 * Bot / link-preview detection for view counting.
 *
 * Why this exists: the moment a share link is pasted into Slack, Discord,
 * Twitter, iMessage or WhatsApp, the platform's unfurl crawler fetches the
 * page to build a preview card. Without filtering, the sender sees "3 views"
 * before a single human has opened it — which makes the whole viewer-analytics
 * promise untrustworthy.
 *
 * Deliberately conservative: a false positive silently deletes a real human
 * view, which is worse than counting one crawler. So we only match on explicit
 * self-identification in the User-Agent, and treat a missing UA as human
 * (real browsers always send one, but a false negative is the cheaper error).
 *
 * Bot views are still recorded — they are excluded from `views` and reported
 * separately as `botViews`, so "nobody has opened it, but Slack previewed it
 * twice" stays a visible, explainable state instead of a mysterious zero.
 */

/**
 * Matches on:
 *  - Named unfurl crawlers for the chat apps people actually paste links into.
 *  - Named search-engine crawlers.
 *  - Generic self-identifying tokens (bot / crawler / spider / slurp).
 *  - Scripted HTTP clients that are never a human reading a page.
 *
 * `facebookexternalhit` covers Facebook, Instagram and (in practice) some
 * WhatsApp fetches; WhatsApp is listed separately because it also sends its
 * own token.
 */
const BOT_UA_PATTERN = new RegExp(
  [
    // Chat / social link unfurlers
    'slackbot',
    'discordbot',
    'twitterbot',
    'telegrambot',
    // Trailing slash because WhatsApp's unfurl fetch is "WhatsApp/2.x" while
    // the brand also appears in other contexts. Pinterest is deliberately NOT
    // listed: its in-app browser sends "[Pinterest/iOS]" (a real person) and
    // its crawler self-identifies via bot.html, which `bot\b` already catches.
    'whatsapp/',
    'facebookexternalhit',
    'linkedinbot',
    'redditbot',
    'skypeuripreview',
    'embedly',
    'iframely',
    'nuzzel',
    'vkshare',
    'flipboardproxy',
    // Search / infrastructure crawlers
    'googlebot',
    'google-inspectiontool',
    'bingbot',
    'yandexbot',
    'duckduckbot',
    'baiduspider',
    'applebot',
    'ahrefsbot',
    'semrushbot',
    'petalbot',
    'bytespider',
    // AI crawlers
    'gptbot',
    'oai-searchbot',
    'chatgpt-user',
    'claudebot',
    'anthropic-ai',
    'perplexitybot',
    'ccbot',
    // Generic self-identification
    'bot\\b',
    'crawler',
    'spider',
    'slurp',
    'headlesschrome',
    'phantomjs',
    'monitoring',
    'uptimerobot',
    'pingdom',
    // Scripted clients
    'curl/',
    'wget',
    'python-requests',
    'python-urllib',
    'go-http-client',
    'node-fetch',
    'axios/',
    'okhttp',
    'libwww-perl',
    'java/',
  ].join('|'),
  'i',
);

/**
 * True when the User-Agent identifies a crawler, link unfurler or scripted
 * client rather than a person with a browser.
 *
 * A missing or empty UA returns false on purpose — see the module comment.
 */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return BOT_UA_PATTERN.test(ua);
}

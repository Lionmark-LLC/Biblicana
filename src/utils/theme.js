// Shared embed chrome. Accent color and footer text are configured via the
// EMBEDCOLOR and EMBEDFOOTERTEXT env vars so prod and dev can look distinct.

import { readFileSync } from 'node:fs';

const DEFAULT_ACCENT = 0x083459;

// The version users see on every card, read from package.json once at
// startup. It used to live only in EMBEDFOOTERTEXT in the droplet's .env, a
// second copy of the version that no commit, diff or test could see: it
// shipped stale at v1.6.0 and read v1.5.1 in prod until someone noticed.
// Now bumping package.json in the release PR is the whole job.
export const APP_VERSION = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

// Same wording prod's EMBEDFOOTERTEXT carries, so removing that variable
// changes nothing a user sees except that the version stays current.
export function defaultFooter(version = APP_VERSION) {
    return `Biblicana v${version} by BlueBerean`;
}

// Canonical external URLs for the BlueBerean site and legal pages. Exported
// so every surface that needs them (welcome card, /support, /config ai, /help)
// reads from one source of truth. Intentionally NOT used in message footers —
// Discord's hyperlink styling clashes with the bot's accent color, so legal
// links live only in the dedicated panels above.
// www is canonical: the apex 301s to it (Cloudflare, since 2026-09-29).
export const PRIVACY_URL = 'https://www.blueberean.com/privacy';
export const TERMS_URL = 'https://www.blueberean.com/terms';
export const SUPPORT_INVITE = 'https://discord.gg/uwFz5vQE';

export function accentColor() {
    if (!process.env.EMBEDCOLOR) return DEFAULT_ACCENT;
    // Tolerate common env-var variants: "#0090FF", "0x0090FF", "0090FF".
    // parseInt("#0090FF", 16) returns NaN silently — strip the prefix
    // first, then fall back to the default if the remaining chars aren't
    // valid hex. Prevents the "I set the color but it's still teal" trap.
    const raw = process.env.EMBEDCOLOR.trim().replace(/^#|^0x/i, '');
    const parsed = parseInt(raw, 16);
    return Number.isFinite(parsed) ? parsed : DEFAULT_ACCENT;
}

// Footer text for EmbedBuilder.setFooter. Never undefined: discord.js rejects
// `text: undefined`, which made /stats throw on any machine whose .env lacks
// EMBEDFOOTERTEXT (a fresh clone, a test run) before it could reply.
// EMBEDFOOTERTEXT, when set, still overrides the whole footer (the prod
// droplet has it until Kenneth removes it; local dev uses it to mark cards
// as dev). Unset or blank, the footer carries package.json's version.
export function footerFor(env = process.env, version = APP_VERSION) {
    return env.EMBEDFOOTERTEXT?.trim() || defaultFooter(version);
}

export function footerText() {
    return footerFor();
}

// Build a small-text footer line. `suffix` is shown after a separator when
// provided. Result already includes the `-#` markdown that renders as footer
// text in a V2 TextDisplay component.
export function footerLine(suffix = '') {
    const base = footerText();
    return suffix ? `-# ${base} | ${suffix}` : `-# ${base}`;
}

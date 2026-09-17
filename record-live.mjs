// Records the LIVE Cal.com app decrypting real sealed bookings through minidauth.
// Logs in as pro@example.com (user 4, holds crm-reader), opens the bookings list, and
// captures the decrypted titles/attendees that the app opened via the sidecar /open path.
import { chromium } from 'playwright';
import { readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const EMAIL = 'pro@example.com';
const PASSWORD = 'Password123!';
const W = 1280, H = 800;
const outDir = '/home/sasha/cal-minidauth/demo-video/live';
try { rmSync(outDir, { recursive: true, force: true }); } catch {}
mkdirSync(outDir, { recursive: true });

// A visible cursor: Playwright video does not capture the OS pointer, so inject a dot that
// tracks mouse events, and drive real page.mouse moves so it glides on screen.
const CURSOR = `
(() => {
  if (window.__cur) return;
  const d = document.createElement('div');
  d.id = '__cur';
  d.style.cssText = 'position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(99,139,255,.55);border:2px solid #2b5bff;box-shadow:0 0 8px rgba(43,91,255,.8);pointer-events:none;transition:transform .05s linear;left:0;top:0';
  document.documentElement.appendChild(d);
  window.__cur = d;
  window.addEventListener('mousemove', e => { d.style.left = e.clientX+'px'; d.style.top = e.clientY+'px'; }, true);
})();`;

const browser = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb', '--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  // Match the account timezone (Europe/London) so Cal's "update your timezone?" prompt never fires.
  timezoneId: 'Europe/London',
  locale: 'en-GB',
  recordVideo: { dir: outDir, size: { width: W, height: H } },
});
const page = await context.newPage();
page.on('framenavigated', () => page.addScriptTag({ content: CURSOR }).catch(() => {}));

const glide = async (x, y, steps = 24) => { await page.mouse.move(x, y, { steps }); await page.waitForTimeout(250); };

try {
  // --- scene 1: what Postgres actually stores (real ciphertext) ---
  await page.goto('file:///home/sasha/cal-minidauth/db-view.html', { waitUntil: 'load', timeout: 30000 });
  await page.addScriptTag({ content: CURSOR }).catch(() => {});
  await page.waitForTimeout(1200);
  await glide(560, 300); await page.waitForTimeout(900);
  await glide(760, 430); await page.waitForTimeout(900);
  await glide(600, 560); await page.waitForTimeout(3200);

  // --- scene 2: sign in as the authorised user ---
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.addScriptTag({ content: CURSOR }).catch(() => {});
  await page.waitForTimeout(1500);
  await glide(640, 300);
  const email = page.locator('input[name="email"], input#email, input[type="email"]').first();
  await email.waitFor({ timeout: 30000 });
  await email.click(); await page.waitForTimeout(300); await email.type(EMAIL, { delay: 45 });
  const pass = page.locator('input[name="password"], input#password, input[type="password"]').first();
  await pass.click(); await page.waitForTimeout(300); await pass.type(PASSWORD, { delay: 45 });
  await page.waitForTimeout(400);
  const signin = page.locator('button[type="submit"]').first();
  await glide(640, 430); await signin.click();

  // --- land (no timezone modal now), then straight to the bookings list ---
  await page.waitForTimeout(4000);
  // safety net in case the prompt still appears
  const dismiss = async () => {
    const btn = page.getByRole('button', { name: /Don't update/i }).first();
    if (await btn.count().catch(() => 0)) { await btn.click().catch(() => {}); await page.waitForTimeout(400); }
  };
  await dismiss();

  // --- bookings: the app opens the sealed title/description via the sidecar /open here ---
  await page.goto(`${BASE}/bookings/upcoming`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.addScriptTag({ content: CURSOR }).catch(() => {});
  // wait for the decrypted rows to render
  await page.waitForFunction(() => /30min|Yoga|Seeded/i.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
  await dismiss();
  await page.waitForTimeout(2500);

  // dwell on the decrypted list: glide down the titles, pause, scroll, pause
  await glide(560, 240); await page.waitForTimeout(900);
  await glide(600, 350); await page.waitForTimeout(900);
  await glide(560, 520); await page.waitForTimeout(900);
  await page.mouse.wheel(0, 320); await page.waitForTimeout(1600);
  await glide(600, 430); await page.waitForTimeout(900);
  await glide(560, 560); await page.waitForTimeout(1200);
  await page.mouse.wheel(0, -320); await page.waitForTimeout(1400);
  await glide(560, 300); await page.waitForTimeout(2500);

  console.log('URL at end:', page.url());
} catch (e) {
  console.log('FLOW ERROR:', String(e.message || e).split('\n')[0]);
}

await context.close(); // flush video
await browser.close();

const files = readdirSync(outDir).filter(f => f.endsWith('.webm'));
if (files.length) { renameSync(`${outDir}/${files[0]}`, `${outDir}/minidauth-cal-live.webm`); console.log('VIDEO:', `${outDir}/minidauth-cal-live.webm`); }
else console.log('NO VIDEO');

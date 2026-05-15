// scripts/login.js
// 自动登录 betadash.lunes.host，进入服务器 trde，触发保活（截图含 WARNING 文字即成功）
import { chromium } from '@playwright/test';
import fs from 'fs';

const LOGIN_URL = 'https://betadash.lunes.host/login';
const DASHBOARD_URL = 'https://betadash.lunes.host';

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

const screenshot = (name) => `./${name}.png`;

async function main() {
  const username = envOrThrow('LUNES_EMAIL');
  const password = envOrThrow('LUNES_PASSWORD');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  try {
    // ── 1. 打开登录页 ──────────────────────────────────────────────
    console.log('[1] 打开登录页:', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    // 检测人机验证
    const humanCheck = page.locator('text=/Verify you are human|需要验证|安全检查/i').first();
    if (await humanCheck.count()) {
      await page.screenshot({ path: screenshot('01-captcha'), fullPage: true });
      console.error('[ERR] 检测到人机验证，无法继续');
      process.exitCode = 2;
      return;
    }

    // ── 2. 填写邮箱和密码 ──────────────────────────────────────────
    console.log('[2] 填写登录信息');
    // betadash 使用 email 字段
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
    const passInput  = page.locator('input[type="password"]').first();

    await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    await emailInput.fill(username);
    await passInput.fill(password);

    await page.screenshot({ path: screenshot('02-before-login'), fullPage: true });

    // ── 3. 点击登录按钮 ────────────────────────────────────────────
    console.log('[3] 点击登录按钮');
    // Cloudflare Turnstile checkbox 如果存在，先勾
    try {
      const cfFrame = page.frameLocator('iframe[src*="challenges.cloudflare"]').first();
      const cfBox = cfFrame.locator('input[type="checkbox"]');
      if (await cfBox.count()) {
        await cfBox.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
      }
    } catch { /* turnstile 不一定存在，忽略 */ }

    const submitBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 15_000 });

    await Promise.all([
      page.waitForNavigation({ timeout: 45_000, waitUntil: 'networkidle' }).catch(() => {}),
      submitBtn.click({ timeout: 10_000 })
    ]);

    await page.waitForTimeout(2000);
    const afterLoginUrl = page.url();
    console.log('[3] 登录后 URL:', afterLoginUrl);
    await page.screenshot({ path: screenshot('03-after-login'), fullPage: true });

    // 判断是否登录成功（不在登录页即视为成功）
    if (/\/login/i.test(afterLoginUrl)) {
      console.error('[ERR] 仍在登录页，登录失败');
      process.exitCode = 1;
      return;
    }

    console.log('[3] ✅ 登录成功！');

    // ── 4. 跳转到 Dashboard 首页，向下滚动 ────────────────────────
    console.log('[4] 前往 Dashboard 首页并滚动');
    if (!afterLoginUrl.startsWith(DASHBOARD_URL)) {
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 30_000 });
    }
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: screenshot('04-dashboard-scrolled'), fullPage: true });

    // ── 5. 进入服务器 trde ─────────────────────────────────────────
    console.log('[5] 寻找服务器 trde 链接');

    // 先尝试直接通过文字找
    let serverLink = page.locator('a:has-text("trde"), [href*="/servers/"]').first();

    // 若文字找不到，尝试找含 trde 的卡片内的跳转图标
    if (!(await serverLink.count())) {
      serverLink = page.locator('text=trde').first();
    }

    if (await serverLink.count()) {
      await serverLink.scrollIntoViewIfNeeded();
      await serverLink.click({ timeout: 10_000 });
    } else {
      // fallback：直接导航到已知 URL（从截图 Image 4 可见 /servers/75729）
      console.log('[5] 未找到文字链接，直接跳转已知 URL');
      await page.goto('https://betadash.lunes.host/servers/75729', {
        waitUntil: 'networkidle',
        timeout: 30_000
      });
    }

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const serverUrl = page.url();
    console.log('[5] 当前 URL:', serverUrl);
    await page.screenshot({ path: screenshot('05-server-page'), fullPage: true });

    // ── 6. 检查 WARNING 横幅 ───────────────────────────────────────
    console.log('[6] 检查 WARNING 横幅');
    const warningBanner = page.locator('text=/WARNING.*FREE SERVERS WILL BE DELETED/i').first();

    if (await warningBanner.count()) {
      console.log('[6] ✅ WARNING 横幅已出现，保活访问成功！');
    } else {
      console.log('[6] ⚠️  未找到 WARNING 横幅，但页面已加载（可能版本已变更）');
    }

    // 最终截图（全页，确保横幅可见）
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    const finalShot = screenshot('06-final-keepalive');
    await page.screenshot({ path: finalShot, fullPage: true });
    console.log('[6] 最终截图已保存：', finalShot);

    process.exitCode = 0;

  } catch (e) {
    console.error('[ERR] 异常：', e?.message ?? String(e));
    try { await page.screenshot({ path: screenshot('99-error'), fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();

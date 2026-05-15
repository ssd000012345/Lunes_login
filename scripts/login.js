// scripts/login.js
// 自动登录 betadash.lunes.host，绕过 Cloudflare Turnstile，触发保活
// 使用 playwright-extra + stealth 插件伪装浏览器指纹

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

chromium.use(StealthPlugin());

const LOGIN_URL     = 'https://betadash.lunes.host/login';
const DASHBOARD_URL = 'https://betadash.lunes.host';

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

const screenshot = (name) => `./${name}.png`;

/** 随机 sleep，模拟人类操作节奏 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = (min = 300, max = 900) => sleep(min + Math.random() * (max - min));

/** 模拟人类打字：逐字符输入，带随机延迟 */
async function humanType(locator, text) {
  await locator.click();
  await humanDelay(100, 300);
  for (const char of text) {
    await locator.pressSequentially(char, { delay: 60 + Math.random() * 80 });
  }
}

/** 等待 Cloudflare 挑战通过（页面不再含 Turnstile iframe），最多等 N 秒 */
async function waitForCloudflarePass(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  console.log('[CF] 等待 Cloudflare 验证通过...');
  while (Date.now() < deadline) {
    // Turnstile 通过后，CF 会 302 跳转到真正的页面，iframe 消失
    const cfFrames = page.frames().filter(f => f.url().includes('challenges.cloudflare'));
    if (cfFrames.length === 0) {
      console.log('[CF] ✅ Cloudflare 已放行');
      return true;
    }
    await sleep(800);
  }
  console.warn('[CF] ⚠️  等待超时，继续尝试...');
  return false;
}

async function main() {
  const username = envOrThrow('LUNES_EMAIL');
  const password = envOrThrow('LUNES_PASSWORD');

  // ── 启动浏览器（stealth 模式）────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',  // 关键：隐藏自动化标志
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1366,768',
      '--start-maximized',
    ],
  });

  // ── 创建带完整指纹的 Context ──────────────────────────────────────
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'zh-CN,zh;q=0.9,en;q=0.8',
    timezoneId: 'Asia/Shanghai',
    // 真实浏览器都有这些权限请求，headless 默认没有
    permissions: [],
    colorScheme: 'light',
    // 模拟真实硬件并发
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  // ── 注入反检测脚本（在每个页面加载前执行）────────────────────────
  await context.addInitScript(() => {
    // 1. 隐藏 webdriver 属性
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 2. 伪造 plugins（headless Chrome 的 plugins 列表为空，容易被识别）
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin',       filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer',        filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client',            filename: 'internal-nacl-plugin', description: '' },
        ];
        arr.item = (i) => arr[i];
        arr.namedItem = (n) => arr.find(p => p.name === n) || null;
        arr.refresh = () => {};
        return arr;
      },
    });

    // 3. 伪造语言
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });

    // 4. 修复 permissions.query（stealth 插件已处理，双保险）
    const originalQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
    if (originalQuery) {
      navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }

    // 5. 隐藏 headless 标志：chrome.runtime
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }

    // 6. 伪造 screen 参数
    Object.defineProperty(screen, 'availWidth',  { get: () => 1366 });
    Object.defineProperty(screen, 'availHeight', { get: () => 728 });
  });

  const page = await context.newPage();

  try {
    // ── 1. 打开登录页 ────────────────────────────────────────────────
    console.log('[1] 打开登录页:', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 先等一下，让 CF 挑战页完全加载
    await sleep(3000);
    await page.screenshot({ path: screenshot('01-initial-page'), fullPage: true });

    // ── 2. 处理 Cloudflare Turnstile ────────────────────────────────
    // CF Turnstile 在 stealth 模式下通常会自动通过（无交互），等待它完成
    const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare'));
    if (cfFrame) {
      console.log('[2] 检测到 Cloudflare 挑战页，等待自动验证...');
      await waitForCloudflarePass(page, 30_000);
      await sleep(2000);
      await page.screenshot({ path: screenshot('02-after-cf'), fullPage: true });
    } else {
      console.log('[2] 未检测到 Cloudflare 拦截，直接进入登录页');
    }

    // ── 3. 确认登录页已加载 ──────────────────────────────────────────
    console.log('[3] 等待登录表单...');
    const emailInput = page.locator(
      'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="邮"]'
    ).first();

    // 如果表单还没出现，可能页面还在跳转，多等一会
    await emailInput.waitFor({ state: 'visible', timeout: 40_000 });

    const passInput = page.locator('input[type="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 15_000 });

    console.log('[3] ✅ 登录表单已加载');
    await page.screenshot({ path: screenshot('03-login-form'), fullPage: true });

    // ── 4. 填写邮箱和密码（模拟人类输入）────────────────────────────
    console.log('[4] 填写登录信息');
    await humanType(emailInput, username);
    await humanDelay(400, 800);
    await humanType(passInput, password);
    await humanDelay(500, 1000);

    await page.screenshot({ path: screenshot('04-before-submit'), fullPage: true });

    // ── 5. 检查 Turnstile checkbox（登录页内嵌的）────────────────────
    try {
      const turnstileFrame = page.frameLocator(
        'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
      ).first();
      const cfCheckbox = turnstileFrame.locator('input[type="checkbox"]');
      if (await cfCheckbox.count({ timeout: 3000 })) {
        console.log('[5] 发现 Turnstile checkbox，尝试点击...');
        await cfCheckbox.click({ timeout: 5000 });
        await sleep(3000);
      }
    } catch {
      // Turnstile 不一定存在，忽略
    }

    // ── 6. 提交登录 ──────────────────────────────────────────────────
    console.log('[6] 点击登录按钮');
    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Continue"), button:has-text("Login"), button:has-text("登录"), button:has-text("Sign in")'
    ).first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // 模拟鼠标移动到按钮再点击（更像人类）
    await submitBtn.hover();
    await humanDelay(200, 500);

    await Promise.all([
      page.waitForNavigation({ timeout: 45_000, waitUntil: 'networkidle' }).catch(() => {}),
      submitBtn.click(),
    ]);

    await sleep(2500);
    const afterLoginUrl = page.url();
    console.log('[6] 登录后 URL:', afterLoginUrl);
    await page.screenshot({ path: screenshot('05-after-login'), fullPage: true });

    if (/\/login/i.test(afterLoginUrl)) {
      console.error('[ERR] 仍在登录页，登录失败（凭据错误或二次验证）');
      process.exitCode = 1;
      return;
    }

    console.log('[6] ✅ 登录成功！');

    // ── 7. 前往 Dashboard ────────────────────────────────────────────
    console.log('[7] 前往 Dashboard 首页');
    if (!afterLoginUrl.startsWith(DASHBOARD_URL)) {
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 30_000 });
    }
    await sleep(1500);
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1000);
    await page.screenshot({ path: screenshot('06-dashboard'), fullPage: true });

    // ── 8. 进入服务器 trde ───────────────────────────────────────────
    console.log('[8] 寻找服务器 trde');
    let serverLink = page.locator('a:has-text("trde"), [href*="/servers/"]').first();
    if (!(await serverLink.count())) {
      serverLink = page.locator('text=trde').first();
    }

    if (await serverLink.count()) {
      await serverLink.scrollIntoViewIfNeeded();
      await serverLink.click({ timeout: 10_000 });
    } else {
      console.log('[8] 未找到文字链接，直接跳转已知 URL');
      await page.goto('https://betadash.lunes.host/servers/75729', {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
    }

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await sleep(2000);
    console.log('[8] 当前 URL:', page.url());
    await page.screenshot({ path: screenshot('07-server-page'), fullPage: true });

    // ── 9. 检查 WARNING 横幅 ─────────────────────────────────────────
    console.log('[9] 检查 WARNING 横幅');
    const warningBanner = page.locator('text=/WARNING.*FREE SERVERS WILL BE DELETED/i').first();
    if (await warningBanner.count()) {
      console.log('[9] ✅ WARNING 横幅已出现，保活访问成功！');
    } else {
      console.log('[9] ⚠️  未找到 WARNING 横幅（页面可能已更新）');
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
    await page.screenshot({ path: screenshot('08-final-keepalive'), fullPage: true });
    console.log('[9] 最终截图已保存: 08-final-keepalive.png');

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

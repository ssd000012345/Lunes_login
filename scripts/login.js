// scripts/login.js
// 自动登录 betadash.lunes.host，绕过 Cloudflare Turnstile，触发保活
// 使用 playwright-extra + stealth 插件伪装浏览器指纹

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

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

/**
 * 改进：处理页面级 Cloudflare 拦截（无 iframe 的 JS 挑战）
 * 等待 URL 改变或登录表单出现
 */
async function waitForChallengePass(page, timeoutMs = 30000) {
  const initialUrl = page.url();
  console.log('[CF] 检测可能存在的页面级 Cloudflare 挑战...');

  await page.waitForFunction(
    ({ initialUrl }) => {
      const urlChanged = window.location.href !== initialUrl;
      const hasLoginForm = !!document.querySelector('input[type="email"], input[name="email"]');
      return urlChanged || hasLoginForm;
    },
    { timeout: timeoutMs, polling: 1000 },
    { initialUrl }
  );

  await page.waitForLoadState('networkidle');
  await sleep(2000);
  console.log('[CF] 挑战处理完成，当前 URL:', page.url());
}

/**
 * 改进的表单内嵌 Turnstile 处理：
 * 1. 使用 frameLocator 精确定位 iframe
 * 2. 直接寻找复选框并点击（支持坐标点击或 evaluate 点击）
 * 3. 等待验证 token 生成作为成功标志
 */
async function handleEmbeddedTurnstile(page, timeoutMs = 35000) {
  console.log('[TS] 开始处理表单内嵌 Turnstile...');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // 定位 Turnstile iframe
      const cfFrame = page.frameLocator(
        'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
      ).first();

      // 等待 iframe 内复选框出现（不同 Turnstile 版本的 class）
      const checkbox = cfFrame.locator(
        'input[type="checkbox"], .cb-o, #checkbox, label[for="checkbox"]'
      ).first();

      if (await checkbox.count() === 0) {
        // 可能已验证成功，检查是否存在 token 字段
        const hasToken = await page.evaluate(() => {
          const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
          return tokenInput && tokenInput.value && tokenInput.value.length > 0;
        });
        if (hasToken) {
          console.log('[TS] ✅ 检测到 Turnstile token 已存在，验证已通过');
          return true;
        }
        await sleep(1000);
        continue;
      }

      // 复选框可见 -> 尝试点击
      await checkbox.waitFor({ state: 'visible', timeout: 5000 });
      console.log('[TS] 发现 Turnstile 复选框，准备点击...');

      // 方法1：尝试用 locator.click()（Playwright 自动处理坐标）
      try {
        await checkbox.click({ timeout: 3000 });
        console.log('[TS] 点击复选框成功 (click 方法)');
      } catch (clickErr) {
        // 方法2：如果常规 click 失败，获取坐标手动点击
        console.log('[TS] 常规点击失败，尝试坐标点击...');
        const box = await checkbox.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
          await sleep(200);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          console.log('[TS] 坐标点击完成');
        } else {
          // 方法3：最激进的方式，直接在 iframe 内 evaluate click
          await cfFrame.evaluate(() => {
            const cb = document.querySelector('input[type="checkbox"], .cb-o');
            if (cb) cb.click();
          });
          console.log('[TS] JS evaluate 点击完成');
        }
      }

      // 点击后等待验证完成（轮询 token 字段）
      console.log('[TS] 等待 Turnstile 验证结果...');
      const tokenGenerated = await page.waitForFunction(
        () => {
          const token = document.querySelector('input[name="cf-turnstile-response"]');
          return token && token.value && token.value.length > 0;
        },
        { timeout: 15000 }
      ).then(() => true).catch(() => false);

      if (tokenGenerated) {
        console.log('[TS] ✅ Turnstile 验证成功（token 已生成）');
        return true;
      } else {
        console.warn('[TS] 点击后未生成 token，可能验证失败，将重试');
        // 重置，稍后循环会再次尝试
        await sleep(2000);
      }

    } catch (err) {
      // iframe 可能还未加载，继续等待
      if (err.message?.includes('Timeout')) {
        console.log('[TS] 等待 iframe 或复选框超时，继续...');
      } else {
        console.warn('[TS] 处理异常:', err.message);
      }
      await sleep(1500);
    }
  }

  console.warn('[TS] ⚠️ Turnstile 处理超时，未完成验证');
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
      '--disable-blink-features=AutomationControlled',
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
    permissions: [],
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  // ── 注入反检测脚本 ────────────────────────────────────────────────
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer',             description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client',      filename: 'internal-nacl-plugin',             description: '' },
        ];
        arr.item = (i) => arr[i];
        arr.namedItem = (n) => arr.find(p => p.name === n) || null;
        arr.refresh = () => {};
        return arr;
      },
    });

    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });

    const originalQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
    if (originalQuery) {
      navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }

    if (!window.chrome) window.chrome = { runtime: {} };

    Object.defineProperty(screen, 'availWidth',  { get: () => 1366 });
    Object.defineProperty(screen, 'availHeight', { get: () => 728 });
  });

  const page = await context.newPage();

  try {
    // ── 1. 打开登录页 ────────────────────────────────────────────────
    console.log('[1] 打开登录页:', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(3000);
    await page.screenshot({ path: screenshot('01-initial-page'), fullPage: true });

    // ── 2. 处理页面级 Cloudflare 挑战（改进版）────────────────────────
    console.log('[2] 处理可能的页面级 Cloudflare 拦截...');
    await waitForChallengePass(page, 30000);
    await page.screenshot({ path: screenshot('02-after-cf-challenge'), fullPage: true });

    // ── 3. 等待登录表单加载 ──────────────────────────────────────────
    console.log('[3] 等待登录表单...');
    const emailInput = page.locator(
      'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="邮"]'
    ).first();
    await emailInput.waitFor({ state: 'visible', timeout: 40_000 });

    const passInput = page.locator('input[type="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 15_000 });
    console.log('[3] ✅ 登录表单已加载');
    await page.screenshot({ path: screenshot('03-login-form'), fullPage: true });

    // ── 4. 填写邮箱和密码 ────────────────────────────────────────────
    console.log('[4] 填写登录信息');
    await humanType(emailInput, username);
    await humanDelay(400, 800);
    await humanType(passInput, password);
    await humanDelay(500, 1000);
    await page.screenshot({ path: screenshot('04-before-submit'), fullPage: true });

    // ── 5. 处理表单内嵌 Turnstile（改进版）────────────────────────────
    const hasTurnstile = await page.locator(
      'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
    ).count();

    if (hasTurnstile > 0) {
      console.log('[5] 检测到表单内嵌 Turnstile，开始处理...');
      const tsSuccess = await handleEmbeddedTurnstile(page, 40000);
      if (tsSuccess) {
        console.log('[5] ✅ Turnstile 验证通过');
      } else {
        console.warn('[5] ⚠️ Turnstile 可能未完成，仍尝试提交');
      }
      await page.screenshot({ path: screenshot('05-after-turnstile'), fullPage: true });
    } else {
      console.log('[5] 未检测到表单内嵌 Turnstile，跳过');
    }

    // ── 6. 提交登录 ──────────────────────────────────────────────────
    console.log('[6] 点击登录按钮');
    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Continue"), button:has-text("Login"), button:has-text("登录"), button:has-text("Sign in")'
    ).first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await submitBtn.hover();
    await humanDelay(200, 500);

    await Promise.all([
      page.waitForNavigation({ timeout: 45_000, waitUntil: 'networkidle' }).catch(() => {}),
      submitBtn.click(),
    ]);

    await sleep(2500);
    const afterLoginUrl = page.url();
    console.log('[6] 登录后 URL:', afterLoginUrl);
    await page.screenshot({ path: screenshot('06-after-login'), fullPage: true });

    if (/\/login/i.test(afterLoginUrl)) {
      console.error('[ERR] 仍在登录页，登录失败（凭据错误或 Turnstile 未通过）');
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
    await page.screenshot({ path: screenshot('07-dashboard'), fullPage: true });

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
    await page.screenshot({ path: screenshot('08-server-page'), fullPage: true });

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
    await page.screenshot({ path: screenshot('09-final-keepalive'), fullPage: true });
    console.log('[9] 最终截图已保存: 09-final-keepalive.png');

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

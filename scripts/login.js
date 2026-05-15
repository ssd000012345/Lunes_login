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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = (min = 300, max = 900) => sleep(min + Math.random() * (max - min));

/** 模拟人类打字 */
async function humanType(locator, text) {
  await locator.click();
  await humanDelay(100, 300);
  for (const char of text) {
    await locator.pressSequentially(char, { delay: 60 + Math.random() * 80 });
  }
}

/**
 * 处理页面级 Cloudflare 拦截（无 iframe 的 JS 挑战）
 * 等待 URL 改变或登录表单出现，不等待 networkidle（避免超时）
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

  await sleep(1500);
  console.log('[CF] 挑战处理完成，当前 URL:', page.url());
}

/**
 * 鲁棒的 Turnstile 处理：
 * 1. 等待 "Verify you are human" 文字出现
 * 2. 定位 Turnstile iframe（多种可能的 src）
 * 3. 点击复选框（支持 iframe 内、或 Shadow DOM）
 * 4. 等待 cf-turnstile-response token 生成
 */
async function handleEmbeddedTurnstile(page, timeoutMs = 45000) {
  console.log('[TS] 开始处理 Turnstile（增强版）...');
  const startTime = Date.now();

  // 1. 等待 "Verify you are human" 文本出现（表明 Turnstile 已加载）
  try {
    await page.waitForSelector('text=/Verify you are human/i', { timeout: 10000 });
    console.log('[TS] 检测到 "Verify you are human" 文本');
  } catch (err) {
    console.warn('[TS] 未发现 "Verify you are human" 文本，可能 Turnstile 未加载或已通过');
  }

  // 2. 尝试多种方式定位 Turnstile iframe
  let cfFrame = null;
  const frameSelectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]',
    'iframe[title*="turnstile"]',
    'iframe[title*="Cloudflare"]'
  ];

  for (const selector of frameSelectors) {
    const frames = page.frames();
    const matchedFrame = frames.find(f => {
      try {
        return f.url().match(/challenges\.cloudflare|turnstile/i);
      } catch { return false; }
    });
    if (matchedFrame) {
      cfFrame = matchedFrame;
      console.log(`[TS] 通过 frame url 找到 Turnstile iframe: ${matchedFrame.url()}`);
      break;
    }
  }

  if (!cfFrame) {
    // 尝试通过 locator 获取 iframe 元素
    const iframeElement = await page.locator('iframe').filter({ hasText: /turnstile|challenge/i }).first();
    if (await iframeElement.count()) {
      const frameHandle = await iframeElement.contentFrame();
      if (frameHandle) cfFrame = frameHandle;
      console.log('[TS] 通过元素 contentFrame 找到 Turnstile iframe');
    }
  }

  if (!cfFrame) {
    console.warn('[TS] 未找到 Turnstile iframe，可能验证已被绕过或页面结构变化');
    // 即便没有 iframe，也可能 Turnstile 已自动通过，检查 token
    const hasToken = await page.evaluate(() => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      return token && token.value && token.value.length > 0;
    });
    if (hasToken) {
      console.log('[TS] 虽未找到 iframe，但已有 token，视为通过');
      return true;
    }
    return false;
  }

  // 3. 在 iframe 内定位并点击复选框
  let clicked = false;
  const checkboxSelectors = [
    'input[type="checkbox"]',
    '.cb-o',
    '#checkbox',
    'label[for="checkbox"]',
    'div[role="checkbox"]'
  ];

  for (const sel of checkboxSelectors) {
    try {
      const checkbox = await cfFrame.locator(sel).first();
      if (await checkbox.count() === 0) continue;
      await checkbox.waitFor({ state: 'visible', timeout: 3000 });
      console.log(`[TS] 找到复选框: ${sel}`);
      await checkbox.click({ timeout: 3000 });
      console.log('[TS] 点击复选框成功');
      clicked = true;
      break;
    } catch (err) {
      // 继续尝试下一个选择器
    }
  }

  if (!clicked) {
    // 最后的备选：使用坐标点击（根据经验，复选框通常在 iframe 左半部分）
    console.log('[TS] 未找到标准复选框，尝试坐标点击...');
    const frameElement = await cfFrame.frameElement();
    const box = await frameElement.boundingBox();
    if (box) {
      const clickX = box.x + box.width * 0.12;
      const clickY = box.y + box.height * 0.5;
      await page.mouse.move(clickX, clickY, { steps: 5 });
      await sleep(200);
      await page.mouse.click(clickX, clickY);
      console.log('[TS] 坐标点击完成');
      clicked = true;
    }
  }

  if (!clicked) {
    console.error('[TS] 无法点击 Turnstile 复选框');
    return false;
  }

  // 4. 等待 token 生成
  console.log('[TS] 等待 Turnstile 验证完成（token）...');
  const tokenGenerated = await page.waitForFunction(
    () => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      return token && token.value && token.value.length > 0;
    },
    { timeout: 15000, polling: 500 }
  ).then(() => true).catch(() => false);

  if (tokenGenerated) {
    console.log('[TS] ✅ Turnstile token 已生成');
    return true;
  } else {
    console.warn('[TS] 未检测到 token，验证可能失败');
    return false;
  }
}

async function main() {
  const username = envOrThrow('LUNES_EMAIL');
  const password = envOrThrow('LUNES_PASSWORD');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'zh-CN,zh;q=0.9,en;q=0.8',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    },
  });

  // 反检测脚本
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client',      filename: 'internal-nacl-plugin', description: '' },
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
    console.log('[1] 打开登录页:', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    await page.screenshot({ path: screenshot('01-initial-page'), fullPage: true });

    console.log('[2] 处理可能的页面级 Cloudflare 拦截...');
    await waitForChallengePass(page, 30000);
    await page.screenshot({ path: screenshot('02-after-cf-challenge'), fullPage: true });

    console.log('[3] 等待登录表单...');
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 40000 });
    const passInput = page.locator('input[type="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log('[3] ✅ 登录表单已加载');
    await page.screenshot({ path: screenshot('03-login-form'), fullPage: true });

    console.log('[4] 填写登录信息');
    await humanType(emailInput, username);
    await humanDelay(400, 800);
    await humanType(passInput, password);
    await humanDelay(500, 1000);
    await page.screenshot({ path: screenshot('04-before-submit'), fullPage: true });

    // --- 关键修复：始终尝试处理 Turnstile（即使检测不到 iframe 也尝试）---
    console.log('[5] 处理表单内嵌 Turnstile（强制检测）...');
    const turnstileSuccess = await handleEmbeddedTurnstile(page, 45000);
    if (turnstileSuccess) {
      console.log('[5] ✅ Turnstile 验证成功');
    } else {
      console.warn('[5] ⚠️ Turnstile 处理失败，仍尝试提交（可能会失败）');
    }
    await page.screenshot({ path: screenshot('05-after-turnstile'), fullPage: true });

    console.log('[6] 点击登录按钮');
    const submitBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Login")').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await submitBtn.hover();
    await humanDelay(200, 500);

    await Promise.all([
      page.waitForNavigation({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {}),
      submitBtn.click(),
    ]);

    await sleep(2500);
    const afterLoginUrl = page.url();
    console.log('[6] 登录后 URL:', afterLoginUrl);
    await page.screenshot({ path: screenshot('06-after-login'), fullPage: true });

    // 检查是否被 Cloudflare 再次拦截（出现 "Verifying" 或 ray id 等）
    const pageText = await page.content();
    if (pageText.includes('正在进行安全验证') || pageText.includes('Verifying') || pageText.includes('ray.id')) {
      console.error('[ERR] 登录触发了 Cloudflare 二次验证，Turnstile 可能未真正通过');
      process.exitCode = 1;
      return;
    }

    if (/\/login/i.test(afterLoginUrl)) {
      console.error('[ERR] 仍在登录页，登录失败（凭据错误或 Turnstile 未通过）');
      process.exitCode = 1;
      return;
    }

    console.log('[6] ✅ 登录成功！');

    // 后续保活操作
    console.log('[7] 前往 Dashboard 首页');
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.screenshot({ path: screenshot('07-dashboard'), fullPage: true });

    console.log('[8] 寻找服务器 trde');
    let serverLink = page.locator('a:has-text("trde"), [href*="/servers/"]').first();
    if (!(await serverLink.count())) serverLink = page.locator('text=trde').first();
    if (await serverLink.count()) {
      await serverLink.scrollIntoViewIfNeeded();
      await serverLink.click({ timeout: 10000 });
    } else {
      console.log('[8] 未找到链接，跳转已知 URL');
      await page.goto('https://betadash.lunes.host/servers/75729', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await sleep(2000);
    console.log('[8] 当前 URL:', page.url());
    await page.screenshot({ path: screenshot('08-server-page'), fullPage: true });

    console.log('[9] 检查 WARNING 横幅');
    const warningBanner = page.locator('text=/WARNING.*FREE SERVERS WILL BE DELETED/i').first();
    if (await warningBanner.count()) {
      console.log('[9] ✅ 保活成功！');
    } else {
      console.log('[9] ⚠️ 未找到横幅，但登录流程已完成');
    }
    await page.screenshot({ path: screenshot('09-final-keepalive'), fullPage: true });

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

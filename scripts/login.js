// scripts/login.js
// 自动登录 betadash.lunes.host，正确处理 Turnstile 验证流程

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

async function humanType(locator, text) {
  await locator.click();
  await humanDelay(100, 300);
  for (const char of text) {
    await locator.pressSequentially(char, { delay: 60 + Math.random() * 80 });
  }
}

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
 * 正确处理 Turnstile 的完整流程：
 * 1. 等待“正在验证...”状态结束（如果出现）
 * 2. 等待“请验证您是真人”或 checkbox 可见
 * 3. 点击 checkbox（通过多种方式）
 * 4. 等待 token 生成
 */
async function handleEmbeddedTurnstile(page, timeoutMs = 60000) {
  console.log('[TS] 开始处理 Turnstile（完整流程版）...');
  const startTime = Date.now();

  // 步骤1：如果出现“正在验证...”，等待它消失
  try {
    const verifyingText = page.locator('text=/正在验证|Verifying/i');
    if (await verifyingText.count() > 0) {
      console.log('[TS] 检测到“正在验证...”，等待验证初始化完成...');
      await verifyingText.waitFor({ state: 'hidden', timeout: 15000 });
      console.log('[TS] “正在验证...”已消失');
    }
  } catch (err) {
    console.log('[TS] 未出现“正在验证...”或已快速通过');
  }

  // 步骤2：等待“请验证您是真人”或 checkbox 出现
  console.log('[TS] 等待“请验证您是真人”或复选框出现...');
  try {
    await page.waitForSelector('text=/请验证您是真人|Verify you are human/i', { timeout: 15000 });
    console.log('[TS] 检测到“请验证您是真人”提示');
  } catch (err) {
    console.warn('[TS] 未检测到提示文字，可能已验证完成，直接检查 token');
    const hasToken = await page.evaluate(() => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      return token && token.value && token.value.length > 0;
    });
    if (hasToken) {
      console.log('[TS] 已存在 token，验证通过');
      return true;
    }
  }

  // 步骤3：定位 Turnstile iframe
  let cfFrame = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const frames = page.frames();
    cfFrame = frames.find(f => {
      try {
        return f.url().match(/challenges\.cloudflare|turnstile/i);
      } catch { return false; }
    });
    if (cfFrame) break;
    await sleep(1000);
  }

  if (!cfFrame) {
    console.error('[TS] 未找到 Turnstile iframe');
    return false;
  }
  console.log(`[TS] 找到 Turnstile iframe: ${cfFrame.url()}`);

  // 步骤4：等待 iframe 内的 checkbox 出现并可点击
  let checkboxClicked = false;
  for (let retry = 0; retry < 5 && !checkboxClicked; retry++) {
    try {
      // 在 iframe 内查找复选框并点击
      const clicked = await cfFrame.evaluate(() => {
        const selectors = [
          'input[type="checkbox"]',
          '.cb-o',
          '#checkbox',
          'label[for="checkbox"]',
          'div[role="checkbox"]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) { // 可见
            el.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log('[TS] 通过 evaluate 点击复选框成功');
        checkboxClicked = true;
        break;
      }

      // 备用：通过 Playwright locator 点击
      const checkbox = cfFrame.locator('input[type="checkbox"], .cb-o').first();
      if (await checkbox.count() > 0 && await checkbox.isVisible()) {
        await checkbox.click({ timeout: 3000 });
        console.log('[TS] 通过 locator 点击复选框成功');
        checkboxClicked = true;
        break;
      }

      console.log(`[TS] 第 ${retry+1} 次尝试未找到复选框，等待重试...`);
      await sleep(1500);
    } catch (err) {
      console.log(`[TS] 点击尝试 ${retry+1} 失败: ${err.message}`);
      await sleep(1000);
    }
  }

  if (!checkboxClicked) {
    console.error('[TS] 无法点击 Turnstile 复选框');
    // 最后尝试坐标点击
    try {
      const frameElement = await cfFrame.frameElement();
      const box = await frameElement.boundingBox();
      if (box) {
        const clickX = box.x + box.width * 0.15;
        const clickY = box.y + box.height * 0.5;
        await page.mouse.click(clickX, clickY);
        console.log('[TS] 坐标点击完成');
        checkboxClicked = true;
      }
    } catch (e) {}
  }

  if (!checkboxClicked) return false;

  // 步骤5：等待 token 生成
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
    console.warn('[TS] 未检测到 token');
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

    // 关键：处理 Turnstile
    console.log('[5] 处理 Turnstile 验证...');
    const turnstileSuccess = await handleEmbeddedTurnstile(page, 60000);
    if (turnstileSuccess) {
      console.log('[5] ✅ Turnstile 验证成功');
    } else {
      console.warn('[5] ⚠️ Turnstile 处理失败，仍尝试提交');
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

    // 检查 Cloudflare 二次验证
    const pageText = await page.content();
    if (pageText.includes('正在进行安全验证') || pageText.includes('Verifying') || pageText.includes('ray.id')) {
      console.error('[ERR] 登录触发了 Cloudflare 二次验证');
      process.exitCode = 1;
      return;
    }

    if (/\/login/i.test(afterLoginUrl)) {
      console.error('[ERR] 仍在登录页，登录失败');
      process.exitCode = 1;
      return;
    }

    console.log('[6] ✅ 登录成功！');

    // 后续保活操作
    console.log('[7] 前往 Dashboard');
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    await page.screenshot({ path: screenshot('07-dashboard'), fullPage: true });

    console.log('[8] 访问服务器页面');
    await page.goto('https://betadash.lunes.host/servers/75729', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    await page.screenshot({ path: screenshot('08-server-page'), fullPage: true });

    console.log('[9] 检查保活效果');
    const warningBanner = page.locator('text=/WARNING.*FREE SERVERS WILL BE DELETED/i').first();
    if (await warningBanner.count()) {
      console.log('[9] ✅ 保活成功，横幅已出现');
    } else {
      console.log('[9] ⚠️ 未找到横幅，但登录已成功');
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

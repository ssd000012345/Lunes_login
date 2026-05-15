// scripts/login.js
// 增强版：等待 Cloudflare Turnstile 完全加载后，通过 Shadow DOM 穿透点击

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const LOGIN_URL = 'https://betadash.lunes.host/login';
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
 * 等待 Turnstile 完全加载并点击复选框（参考 Python pydoll 成功经验）
 */
async function handleTurnstileWithShadowDOM(page, timeoutMs = 60000) {
  console.log('[TS] 等待 Turnstile 加载...');

  // 1. 等待页面中出现 “Verify you are human” 或 “请验证您是真人”
  try {
    await page.waitForSelector('text=/Verify you are human|请验证您是真人/i', { timeout: 20000 });
    console.log('[TS] ✅ 检测到验证提示文字');
  } catch (err) {
    console.warn('[TS] 未检测到提示文字，但继续尝试');
  }

  // 2. 等待包含 Cloudflare 的 Shadow Root 出现（轮询直到出现）
  const shadowRootFound = await page.waitForFunction(
    () => {
      function findCfShadowRoot(root = document) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot) {
            const html = node.shadowRoot.innerHTML || '';
            if (html.includes('challenges.cloudflare.com')) {
              return true;
            }
            const deeper = findCfShadowRoot(node.shadowRoot);
            if (deeper) return true;
          }
        }
        return false;
      }
      return findCfShadowRoot();
    },
    { timeout: 15000, polling: 500 }
  ).then(() => true).catch(() => false);

  if (!shadowRootFound) {
    console.warn('[TS] 未找到 Cloudflare Shadow Root');
  } else {
    console.log('[TS] ✅ Cloudflare Shadow Root 已出现');
  }

  // 3. 尝试点击复选框（最多 3 次）
  let clicked = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[TS] 点击复选框尝试 ${attempt}/3 ...`);
    try {
      const result = await page.evaluate(() => {
        function findCfShadowRoot(root = document) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
              const html = node.shadowRoot.innerHTML || '';
              if (html.includes('challenges.cloudflare.com')) {
                return node.shadowRoot;
              }
              const deeper = findCfShadowRoot(node.shadowRoot);
              if (deeper) return deeper;
            }
          }
          return null;
        }

        const cfShadowRoot = findCfShadowRoot();
        if (!cfShadowRoot) return { success: false, reason: 'no_shadow_root' };

        const iframe = cfShadowRoot.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (!iframe) return { success: false, reason: 'no_iframe' };

        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) return { success: false, reason: 'no_iframe_doc' };

        const body = iframeDoc.body;
        if (!body || !body.shadowRoot) return { success: false, reason: 'no_inner_shadow' };

        const innerShadow = body.shadowRoot;
        const checkbox = innerShadow.querySelector('span.cb-i, input[type="checkbox"], .cb-o, div[role="checkbox"]');
        if (!checkbox) return { success: false, reason: 'no_checkbox' };

        checkbox.click();
        return { success: true };
      });

      if (result.success) {
        console.log('[TS] ✅ Shadow DOM 点击成功');
        clicked = true;
        break;
      } else {
        console.log(`[TS] 点击失败: ${result.reason}`);
      }
    } catch (err) {
      console.log(`[TS] 点击异常: ${err.message}`);
    }
    await sleep(2000);
  }

  // 如果穿透点击失败，使用坐标点击（回退）
  if (!clicked) {
    console.log('[TS] 穿透点击失败，使用坐标点击...');
    try {
      const iframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
      if (await iframe.count()) {
        const box = await iframe.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          const clickX = box.x + box.width * 0.2;
          const clickY = box.y + box.height * 0.5;
          console.log(`[TS] 坐标点击: (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
          await page.mouse.move(clickX, clickY, { steps: 5 });
          await sleep(200);
          await page.mouse.click(clickX, clickY);
          clicked = true;
          console.log('[TS] 坐标点击完成');
        }
      }
    } catch (err) {
      console.error(`[TS] 坐标点击失败: ${err.message}`);
    }
  }

  if (!clicked) {
    console.error('[TS] 无法点击 Turnstile 复选框');
    return false;
  }

  // 4. 等待验证 token 出现
  console.log('[TS] 等待 Turnstile 验证结果...');
  const tokenFound = await page.waitForFunction(
    () => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      return token && token.value && token.value.length > 0;
    },
    { timeout: 20000, polling: 500 }
  ).then(() => true).catch(() => false);

  if (tokenFound) {
    console.log('[TS] ✅ Turnstile 验证成功');
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

    console.log('[5] 处理 Turnstile 验证...');
    const turnstileSuccess = await handleTurnstileWithShadowDOM(page, 60000);
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

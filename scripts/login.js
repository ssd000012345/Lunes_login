// scripts/login.js
// 使用 Shadow DOM 穿透 + 精确点击 Cloudflare Turnstile（参考 Python pydoll 成功经验）

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
 * 使用浏览器 evaluate 穿透 Shadow DOM 点击 Turnstile 复选框
 * 完全参考 Python 脚本中 manual_cf_click 的逻辑
 */
async function handleTurnstileWithShadowDOM(page, timeoutMs = 30000) {
  console.log('[TS] 开始尝试 Shadow DOM 穿透点击...');

  // 等待“Verify you are human”文本出现（确保 Turnstile 已加载）
  try {
    await page.waitForSelector('text=/Verify you are human|请验证您是真人/i', { timeout: 15000 });
    console.log('[TS] ✅ 检测到验证提示文字');
  } catch (err) {
    console.warn('[TS] 未检测到提示文字，但继续尝试');
  }

  const clicked = await page.evaluate(async () => {
    // 递归查找包含 challenges.cloudflare.com 的 Shadow Root
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
    if (!cfShadowRoot) {
      console.warn('[evaluate] 未找到 Cloudflare Shadow Root');
      return false;
    }

    // 在 Shadow Root 中查找 iframe
    const iframe = cfShadowRoot.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (!iframe) {
      console.warn('[evaluate] 未找到 iframe');
      return false;
    }

    // 进入 iframe 的 contentDocument
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) {
      console.warn('[evaluate] 无法访问 iframe contentDocument');
      return false;
    }

    // 获取 iframe 内部的 body，然后获取其 Shadow Root
    const body = iframeDoc.body;
    if (!body || !body.shadowRoot) {
      console.warn('[evaluate] iframe body 无 Shadow Root');
      return false;
    }

    const innerShadow = body.shadowRoot;
    // 查找复选框元素（Python 中使用的是 'span.cb-i'）
    const checkbox = innerShadow.querySelector('span.cb-i, input[type="checkbox"], .cb-o');
    if (!checkbox) {
      console.warn('[evaluate] 未找到复选框元素');
      return false;
    }

    // 点击复选框
    checkbox.click();
    console.log('[evaluate] 已点击复选框');
    return true;
  }).catch(err => {
    console.error('[TS] evaluate 执行失败:', err);
    return false;
  });

  if (!clicked) {
    console.warn('[TS] Shadow DOM 穿透点击失败，回退到坐标点击...');
    // 回退策略：使用之前可靠的坐标点击逻辑（如果希望保留）
    // 尝试获取 iframe 进行坐标点击
    try {
      const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
      if (cfFrame) {
        const frameElement = await cfFrame.frameElement();
        const box = await frameElement.boundingBox();
        if (box) {
          const clickX = box.x + box.width * 0.18;
          const clickY = box.y + box.height * 0.5;
          await page.mouse.move(clickX, clickY, { steps: 5 });
          await sleep(200);
          await page.mouse.click(clickX, clickY);
          console.log('[TS] 回退坐标点击完成');
        }
      }
    } catch (e) {
      console.error('[TS] 回退坐标点击失败', e);
    }
  }

  // 等待 token 生成（验证结果）
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
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
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
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
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
    Object.defineProperty(screen, 'availWidth', { get: () => 1366 });
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
    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]')
      .first();
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

    // 核心：处理 Turnstile
    console.log('[5] 处理 Turnstile 验证（Shadow DOM 穿透）...');
    const turnstileSuccess = await handleTurnstileWithShadowDOM(page, 45000);
    if (turnstileSuccess) {
      console.log('[5] ✅ Turnstile 验证成功');
    } else {
      console.warn('[5] ⚠️ Turnstile 处理失败，仍尝试提交');
    }
    await page.screenshot({ path: screenshot('05-after-turnstile'), fullPage: true });

    console.log('[6] 点击登录按钮');
    const submitBtn = page
      .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Login")')
      .first();
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
      console.error('[ERR] 登录触发了 Cloudflare 二次验证，Turnstile 可能未通过');
      process.exitCode = 1;
      return;
    }

    if (/\/login/i.test(afterLoginUrl)) {
      console.error('[ERR] 仍在登录页，登录失败');
      process.exitCode = 1;
      return;
    }

    console.log('[6] ✅ 登录成功！');

    // 保活后续操作
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
    try {
      await page.screenshot({ path: screenshot('99-error'), fullPage: true });
    } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();

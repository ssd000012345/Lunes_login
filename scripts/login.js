// scripts/login.js
// 终极版：处理 Cloudflare Turnstile（自适应查找复选框 + 精确坐标点击）

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
 * 改进版：在 Turnstile iframe 内查找复选框并点击
 * 支持：角色查找、aria-label、通用元素、坐标点击
 */
async function handleEmbeddedTurnstile(page, timeoutMs = 60000) {
  console.log('[TS] 开始处理 Turnstile（终极版）...');

  // 1. 等待“Verify you are human”文本出现（确保 Turnstile 已就绪）
  try {
    await page.waitForSelector('text=/Verify you are human|请验证您是真人/i', { timeout: 15000 });
    console.log('[TS] ✅ 检测到验证提示文字');
  } catch (err) {
    console.warn('[TS] 未检测到提示文字，但继续尝试处理 iframe');
  }

  // 2. 获取 Turnstile iframe
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

  // 3. 等待 iframe 内部 body 加载完成
  try {
    await cfFrame.waitForSelector('body', { timeout: 10000 });
    console.log('[TS] iframe 内容已加载');
  } catch (err) {
    console.warn('[TS] iframe body 未就绪，仍尝试操作');
  }

  // 4. 定义点击策略
  let clicked = false;

  // 策略1：通过 evaluate 查找复选框元素（不使用固定选择器，而是通过特征识别）
  try {
    const found = await cfFrame.evaluate(() => {
      // 递归查找所有元素，寻找可能是复选框的元素
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const role = el.getAttribute('role');
        const ariaLabel = el.getAttribute('aria-label');
        const className = el.className;
        const id = el.id;
        // 匹配条件：role="checkbox" 或 aria-label 包含 checkbox/verify 或 class 包含 cb/checkbox
        if (role === 'checkbox' ||
            (ariaLabel && /checkbox|verify/i.test(ariaLabel)) ||
            (className && /cb|checkbox|turnstile/i.test(className)) ||
            (id && /checkbox/i.test(id))) {
          // 确保元素可见且可点击
          if (el.offsetParent !== null) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (found) {
      console.log('[TS] 策略1成功：通过元素特征点击复选框');
      clicked = true;
    } else {
      console.log('[TS] 策略1未找到复选框');
    }
  } catch (err) {
    console.log(`[TS] 策略1失败: ${err.message}`);
  }

  // 策略2：使用精确坐标点击（推荐，成功率最高）
  if (!clicked) {
    console.log('[TS] 策略2：使用坐标点击');
    try {
      const frameElement = await cfFrame.frameElement();
      const box = await frameElement.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        // Turnstile 复选框通常在 iframe 左侧 15%～20% 处，垂直居中
        const clickX = box.x + box.width * 0.18;
        const clickY = box.y + box.height * 0.5;
        console.log(`[TS] 坐标点击位置: (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
        // 模拟人类移动鼠标
        await page.mouse.move(clickX - 30, clickY - 10, { steps: 5 });
        await sleep(100 + Math.random() * 200);
        await page.mouse.move(clickX, clickY, { steps: 8 });
        await sleep(100 + Math.random() * 150);
        await page.mouse.click(clickX, clickY);
        console.log('[TS] 坐标点击完成');
        clicked = true;
      } else {
        console.warn('[TS] 无法获取 iframe 位置');
      }
    } catch (err) {
      console.error(`[TS] 坐标点击失败: ${err.message}`);
    }
  }

  if (!clicked) {
    console.error('[TS] 所有点击方式均失败');
    return false;
  }

  // 5. 等待验证完成（token 生成）
  console.log('[TS] 等待 Turnstile 验证完成（token）...');
  const tokenGenerated = await page.waitForFunction(
    () => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      return token && token.value && token.value.length > 0;
    },
    { timeout: 20000, polling: 500 }
  ).then(() => true).catch(() => false);

  if (tokenGenerated) {
    console.log('[TS] ✅ Turnstile token 已生成');
    return true;
  } else {
    // 若 token 未生成，再额外等待 3 秒检查是否自动通过
    await sleep(3000);
    const hasToken = await page.evaluate(() => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      return token && token.value && token.value.length > 0;
    });
    if (hasToken) {
      console.log('[TS] ✅ Turnstile token 已生成（延迟）');
      return true;
    }
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

    // 处理 Turnstile
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

    // 检查是否被 Cloudflare 二次拦截
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

    // 保活后续流程
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

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
 * 等待页面级 Cloudflare 拦截通过（整页跳转型）
 */
async function waitForCloudflarePass(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  console.log('[CF] 等待 Cloudflare 页面验证通过...');
  while (Date.now() < deadline) {
    const cfFrames = page.frames().filter(f => f.url().includes('challenges.cloudflare'));
    if (cfFrames.length === 0) {
      console.log('[CF] ✅ Cloudflare 页面拦截已放行');
      return true;
    }
    await sleep(800);
  }
  console.warn('[CF] ⚠️  等待超时，继续尝试...');
  return false;
}

/**
 * 处理表单内嵌的 Cloudflare Turnstile
 *
 * 核心思路：
 * - Turnstile 的 checkbox 在 Shadow DOM / iframe 内，不能直接 .click()
 * - 用 page.mouse 模拟真实鼠标点击 iframe 的 checkbox 区域
 * - 通过检测 iframe 内 #success div 的 display 样式判断是否通过
 */
async function handleEmbeddedTurnstile(page, timeoutMs = 35_000) {
  console.log('[TS] 开始处理表单内嵌 Turnstile...');
  const deadline = Date.now() + timeoutMs;
  let clickAttempts = 0;

  while (Date.now() < deadline) {
    try {
      const cfIframeLocator = page.locator(
        'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
      ).first();

      // 用 frameLocator 进入 iframe 内部检查状态
      const cfIframe = page.frameLocator(
        'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
      ).first();

      // ── 检查是否已成功 ──────────────────────────────────────────
      // Turnstile 成功后 #success 的 style 变为 display:grid
      const successStyle = await cfIframe.locator('#success')
        .getAttribute('style', { timeout: 1500 })
        .catch(() => null);

      if (successStyle && successStyle.includes('grid')) {
        console.log('[TS] ✅ Turnstile 验证成功（#success 可见）');
        return true;
      }

      // ── 检查是否在验证中（转圈）──────────────────────────────────
      const verifyingStyle = await cfIframe.locator('#verifying')
        .getAttribute('style', { timeout: 1500 })
        .catch(() => null);

      if (verifyingStyle && verifyingStyle.includes('grid')) {
        console.log('[TS] Turnstile 验证中，等待结果...');
        await sleep(2000);
        continue;
      }

      // ── 检查是否出现可点击的 checkbox ────────────────────────────
      // 状态：display:flex 的 .cb-o 容器内有 checkbox label
      const cbStyle = await cfIframe.locator('.cb-o, #AWWzG3')
        .getAttribute('style', { timeout: 1500 })
        .catch(() => null);

      const needsClick = cbStyle && (cbStyle.includes('flex') || cbStyle.includes('grid'));

      if (needsClick && clickAttempts < 3) {
        clickAttempts++;
        console.log(`[TS] 检测到交互式 checkbox，第 ${clickAttempts} 次模拟点击...`);

        // 获取 iframe 的屏幕坐标
        const box = await cfIframeLocator.boundingBox().catch(() => null);
        if (box) {
          // Turnstile checkbox 在 iframe 左侧约 1/6 处，垂直居中
          const clickX = box.x + box.width * 0.12;
          const clickY = box.y + box.height * 0.5;

          // 模拟自然鼠标轨迹
          await page.mouse.move(
            clickX + 80 + Math.random() * 40,
            clickY + 15 + Math.random() * 10,
            { steps: 12 }
          );
          await sleep(150 + Math.random() * 200);
          await page.mouse.move(clickX, clickY, { steps: 8 });
          await sleep(80 + Math.random() * 120);
          await page.mouse.click(clickX, clickY);

          console.log('[TS] 已点击，等待 Turnstile 响应...');
          await sleep(4000); // Turnstile 动画 + 验证需要时间
          continue;
        }
      }

      // ── 检查是否因失败需要重试 ───────────────────────────────────
      const failStyle = await cfIframe.locator('#fail')
        .getAttribute('style', { timeout: 1500 })
        .catch(() => null);

      if (failStyle && failStyle.includes('grid')) {
        console.warn('[TS] Turnstile 验证失败，等待自动重置...');
        clickAttempts = 0; // 重置点击计数，准备重试
        await sleep(3000);
        continue;
      }

    } catch (err) {
      // iframe 可能还在加载，继续等
    }

    await sleep(1200);
  }

  console.warn('[TS] ⚠️  Turnstile 处理超时');
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

    // ── 2. 处理页面级 CF 拦截 ────────────────────────────────────────
    const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare'));
    if (cfFrame) {
      console.log('[2] 检测到 Cloudflare 页面拦截，等待自动验证...');
      await waitForCloudflarePass(page, 30_000);
      await sleep(2000);
      await page.screenshot({ path: screenshot('02-after-cf'), fullPage: true });
    } else {
      console.log('[2] 未检测到 Cloudflare 页面拦截，直接进入登录页');
    }

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

    // ── 5. 处理表单内嵌 Turnstile（关键修复）────────────────────────
    const hasTurnstile = await page.locator(
      'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
    ).count();

    if (hasTurnstile > 0) {
      console.log('[5] 检测到表单内嵌 Turnstile，处理中...');
      const tsSuccess = await handleEmbeddedTurnstile(page, 35_000);
      if (tsSuccess) {
        console.log('[5] ✅ Turnstile 验证通过');
      } else {
        console.warn('[5] ⚠️  Turnstile 可能未验证完成，仍尝试提交');
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

"""
scripts/login.py

移植自 runfreecloud 的 pydoll 登录逻辑：
  - 使用 pydoll（非 Playwright）原生 Shadow DOM API 穿透 Cloudflare Turnstile
  - headless=False + Xvfb 虚拟显示器（GitHub Actions 环境）
  - 内置 expect_and_bypass_cloudflare_captcha()
  - 手动 Shadow DOM 穿透点击 span.cb-i（与 runfree 完全一致）
  - 登录成功后访问 /servers/75729，截图 WARNING 横幅
"""

import asyncio
import os
import logging
import random
import time
from pathlib import Path
from pydoll.browser.chromium import Chrome
from pydoll.browser.options import ChromiumOptions

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

EMAIL    = os.environ["LUNES_EMAIL"]
PASSWORD = os.environ["LUNES_PASSWORD"]

BASE_URL   = "https://betadash.lunes.host"
LOGIN_URL  = f"{BASE_URL}/login"
SERVER_URL = f"{BASE_URL}/servers/75729"

SHOT_DIR = Path("./screenshots")
SHOT_DIR.mkdir(exist_ok=True)

# ── 工具函数（完全照搬 runfree 逻辑）────────────────────────────────────────

async def take_screenshot(tab, name):
    try:
        path = str(SHOT_DIR / f"{name}.png")
        await tab.take_screenshot(path=path)
        log.info(f"📸 截图: {path}")
    except Exception as e:
        log.warning(f"截图失败: {e}")

async def get_text(tab):
    try:
        result = await tab.execute_script("return document.body.innerText")
        if isinstance(result, dict):
            return result.get("result", {}).get("result", {}).get("value", "")
        return str(result)
    except:
        return ""

async def get_url(tab):
    try:
        result = await tab.execute_script("return window.location.href")
        if isinstance(result, dict):
            return result.get("result", {}).get("result", {}).get("value", "")
        return str(result)
    except:
        return ""

async def human_delay(min_s=0.4, max_s=1.2):
    await asyncio.sleep(random.uniform(min_s, max_s))

async def wait_for_url_contains(tab, keyword, timeout=15):
    for _ in range(timeout * 2):
        url = await get_url(tab)
        if keyword in url:
            return True
        await asyncio.sleep(0.5)
    return False

# ── Chromium 浏览器创建（移植自 runfree，去掉 proxy 参数）────────────────────

def _find_chromium():
    candidates = [
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
    ]
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            log.info(f"找到 Chromium: {p}")
            return p
    return None

async def create_browser():
    opts = ChromiumOptions()
    opts.headless = False          # ← 关键：配合 Xvfb 非 headless 运行，绕过 CF 指纹
    path = _find_chromium()
    if path:
        opts.binary_location = path

    opts.add_argument("--window-size=1366,768")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--exclude-switches=enable-automation")
    opts.add_argument("--disable-infobars")
    opts.add_argument(
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    opts.browser_preferences = {
        "credentials_enable_service": False,
        "profile": {
            "password_manager_enabled": False,
            "default_content_setting_values": {"notifications": 2},
        },
        "intl": {"accept_languages": "zh-CN,zh,en-US,en"},
    }

    browser = await Chrome(options=opts).__aenter__()
    tab = await browser.start()

    # 注入指纹伪装
    try:
        await tab.execute_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
        )
    except:
        pass

    return browser, tab

# ── Cloudflare 手动 Shadow DOM 穿透点击（完整复制 runfree 逻辑）──────────────

async def manual_cf_click(tab, timeout=20):
    """
    pydoll 原生 API：
      find_shadow_roots() → 遍历 Shadow Root → 找 CF iframe → 穿透到内层 Shadow → 点 span.cb-i
    这是 runfreecloud 成功的核心。
    """
    log.info("尝试 Shadow DOM 穿透点击 Cloudflare Turnstile...")
    for i in range(timeout):
        body = await get_text(tab)
        # 如果页面已经不是 CF 拦截页，直接返回
        if "verify you are human" not in body.lower() and (
            "email" in body.lower() or "sign in" in body.lower() or "password" in body.lower()
        ):
            log.info("✅ 页面已跳过 CF 验证")
            return True

        try:
            # ① 获取所有 Shadow Root（pydoll 专有 API）
            shadow_roots = await tab.find_shadow_roots(deep=False)
            cf_shadow = None
            for sr in shadow_roots:
                try:
                    html = await sr.inner_html
                    if "challenges.cloudflare.com" in html:
                        cf_shadow = sr
                        break
                except:
                    pass

            if cf_shadow is None:
                log.info(f"第{i+1}s: 未找到 CF Shadow Root，等待...")
                await asyncio.sleep(1)
                continue

            log.info("✅ 找到 CF Shadow Root")

            # ② 在 Shadow Root 里找 CF iframe
            iframe_el = await cf_shadow.query(
                'iframe[src*="challenges.cloudflare.com"]', timeout=3
            )

            # ③ 进入 iframe body → 内层 Shadow Root → 点击 span.cb-i
            body_el      = await iframe_el.find(tag_name="body", timeout=3)
            inner_shadow = await body_el.get_shadow_root(timeout=3)
            checkbox     = await inner_shadow.query("span.cb-i", timeout=3)
            await checkbox.click()

            log.info("✅ 已点击 Turnstile checkbox，等待验证结果...")
            await asyncio.sleep(4)

            # 验证是否通过
            body2 = await get_text(tab)
            if "verify you are human" not in body2.lower():
                log.info("✅ Turnstile 验证通过！")
                return True
            log.info("验证后仍是 CF 页面，继续等待...")

        except Exception as e:
            log.info(f"第{i+1}s: {e}")

        await asyncio.sleep(1)

    log.error("Cloudflare Turnstile 验证超时")
    return False

async def ensure_cf_passed(tab, url):
    """导航到 url，用 pydoll 内置方法 + 手动点击双保险绕过 CF"""
    try:
        # pydoll 内置 CF 绕过（runfree 同款）
        async with tab.expect_and_bypass_cloudflare_captcha():
            await tab.go_to(url)
    except Exception as e:
        log.warning(f"内置 CF 绕过异常（可能无需绕过）: {e}")
        await tab.go_to(url)

    await asyncio.sleep(2)
    body = await get_text(tab)
    if "verify you are human" in body.lower():
        log.info("内置绕过未生效，启动手动 Shadow DOM 穿透点击...")
        return await manual_cf_click(tab)
    return True

# ── 主登录流程 ────────────────────────────────────────────────────────────────

async def login(tab):
    log.info("[1] 打开登录页...")
    if not await ensure_cf_passed(tab, LOGIN_URL):
        log.error("CF 验证失败")
        return False

    await take_screenshot(tab, "01-login-page")

    # 找邮箱输入框
    log.info("[2] 填写邮箱...")
    try:
        email_el = await tab.find(tag_name="input", type="email", timeout=10)
    except:
        try:
            email_el = await tab.find(tag_name="input", name="email", timeout=5)
        except:
            email_el = await tab.query('input[placeholder*="mail" i]', timeout=5)

    await email_el.click()
    await human_delay()
    await email_el.type_text(EMAIL, humanize=True)
    await human_delay()

    # 找密码输入框
    log.info("[2] 填写密码...")
    pass_el = await tab.find(tag_name="input", type="password", timeout=5)
    await pass_el.click()
    await human_delay(0.3, 0.7)
    await pass_el.type_text(PASSWORD, humanize=True)
    await human_delay()

    await take_screenshot(tab, "02-before-turnstile")

    # Turnstile：先等页面内 iframe 出现，再用 Shadow DOM 穿透
    log.info("[3] 处理登录页内嵌 Turnstile...")
    await asyncio.sleep(2)
    body = await get_text(tab)
    if "verify you are human" in body.lower() or "cloudflare" in body.lower():
        cf_ok = await manual_cf_click(tab, timeout=30)
        if not cf_ok:
            log.warning("Turnstile 处理失败，仍尝试提交")
    else:
        log.info("[3] 未检测到 Turnstile，直接提交")

    await take_screenshot(tab, "03-after-turnstile")

    # 提交登录
    log.info("[4] 点击登录按钮...")
    try:
        btn = await tab.query(
            'button[type="submit"], button:has-text("Continue"), button:has-text("Login")',
            timeout=5
        )
    except:
        btn = await tab.find(tag_name="button", timeout=5)

    await btn.click()
    log.info("[4] 已点击，等待跳转...")

    # 等待离开登录页
    for _ in range(20):
        url = await get_url(tab)
        if "/login" not in url:
            log.info(f"[4] ✅ 登录成功，当前 URL: {url}")
            return True
        await asyncio.sleep(1)

    url = await get_url(tab)
    log.error(f"[4] 登录后仍在: {url}")
    await take_screenshot(tab, "04-login-failed")
    return False

# ── 主流程 ────────────────────────────────────────────────────────────────────

async def main():
    browser, tab = await create_browser()
    try:
        await take_screenshot(tab, "00-start")

        if not await login(tab):
            log.error("❌ 登录失败")
            raise SystemExit(1)

        await take_screenshot(tab, "05-dashboard")

        # 访问服务器 trde
        log.info("[5] 访问服务器 trde...")
        await ensure_cf_passed(tab, SERVER_URL)
        await asyncio.sleep(2)

        body = await get_text(tab)
        url  = await get_url(tab)
        log.info(f"[5] 当前 URL: {url}")

        if "FREE SERVERS WILL BE DELETED" in body:
            log.info("[5] ✅ WARNING 横幅已出现，保活成功！")
        elif "trde" in body or "efbff607" in body:
            log.info("[5] ✅ 服务器页面已加载，保活成功！")
        else:
            log.warning("[5] ⚠️  未确认服务器页面，请查看截图")

        await take_screenshot(tab, "06-server-warning")
        log.info("✅ 全部完成！")

    except SystemExit:
        raise
    except Exception as e:
        log.exception(e)
        try:
            await take_screenshot(tab, "99-error")
        except:
            pass
        raise SystemExit(1)
    finally:
        await asyncio.sleep(3)
        try:
            await browser.__aexit__(None, None, None)
        except:
            pass

if __name__ == "__main__":
    asyncio.run(main())

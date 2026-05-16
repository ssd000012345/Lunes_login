"""
scripts/login.py - pydoll + Xvfb，Shadow DOM 穿透 Cloudflare Turnstile
"""

import asyncio
import os
import logging
import random
from pathlib import Path
from pydoll.browser.chromium import Chrome
from pydoll.browser.options import ChromiumOptions

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

EMAIL     = os.environ["LUNES_EMAIL"]
PASSWORD  = os.environ["LUNES_PASSWORD"]
SERVER_ID = os.environ["LUNES_SERVER_ID"]   # 在仓库 Secrets 里配置，例如 75729

BASE_URL   = "https://betadash.lunes.host"
LOGIN_URL  = f"{BASE_URL}/login"
SERVER_URL = f"{BASE_URL}/servers/{SERVER_ID}"

SHOT_DIR = Path("./screenshots")
SHOT_DIR.mkdir(exist_ok=True)

# ── 工具函数 ──────────────────────────────────────────────────────────────────

async def take_screenshot(tab, name):
    try:
        path = str(SHOT_DIR / f"{name}.png")
        await tab.take_screenshot(path=path)
        log.info(f"📸 截图: {path}")
    except Exception as e:
        log.warning(f"截图失败: {e}")

async def js_val(tab, script):
    result = await tab.execute_script(script)
    if isinstance(result, dict):
        return result.get("result", {}).get("result", {}).get("value")
    return result

async def get_text(tab):
    try:
        return await js_val(tab, "return document.body.innerText") or ""
    except:
        return ""

async def get_url(tab):
    try:
        return await js_val(tab, "return window.location.href") or ""
    except:
        return ""

async def human_delay(min_s=0.4, max_s=1.2):
    await asyncio.sleep(random.uniform(min_s, max_s))

# ── Chromium 创建 ─────────────────────────────────────────────────────────────

def _find_chromium():
    for p in ["/usr/bin/chromium-browser", "/usr/bin/chromium",
              "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            log.info(f"找到 Chromium: {p}")
            return p
    return None

async def create_browser():
    opts = ChromiumOptions()
    opts.headless = False
    path = _find_chromium()
    if path:
        opts.binary_location = path

    opts.add_argument("--window-size=1366,900")   # 加高窗口，确保按钮不被截断
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
        "profile": {"password_manager_enabled": False},
    }

    browser = await Chrome(options=opts).__aenter__()
    tab = await browser.start()
    try:
        await tab.execute_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
        )
    except:
        pass
    return browser, tab

# ── Cloudflare Shadow DOM 穿透点击 ────────────────────────────────────────────

async def manual_cf_click(tab, timeout=20):
    log.info("尝试 Shadow DOM 穿透点击 Cloudflare Turnstile...")
    for i in range(timeout):
        body = await get_text(tab)
        if "verify you are human" not in body.lower() and (
            "email" in body.lower() or "sign in" in body.lower() or "password" in body.lower()
        ):
            log.info("✅ CF 验证已通过")
            return True
        try:
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
            iframe_el    = await cf_shadow.query('iframe[src*="challenges.cloudflare.com"]', timeout=3)
            body_el      = await iframe_el.find(tag_name="body", timeout=3)
            inner_shadow = await body_el.get_shadow_root(timeout=3)
            checkbox     = await inner_shadow.query("span.cb-i", timeout=3)
            await checkbox.click()
            log.info("✅ 已点击 Turnstile checkbox，等待验证...")
            await asyncio.sleep(4)

            body2 = await get_text(tab)
            if "verify you are human" not in body2.lower():
                log.info("✅ Turnstile 验证通过！")
                return True
            log.info("验证后仍是 CF 页面，继续...")
        except Exception as e:
            log.info(f"第{i+1}s: {e}")
        await asyncio.sleep(1)

    log.error("Cloudflare Turnstile 验证超时")
    return False

async def ensure_cf_passed(tab, url):
    try:
        async with tab.expect_and_bypass_cloudflare_captcha():
            await tab.go_to(url)
    except Exception as e:
        log.warning(f"内置 CF 绕过异常: {e}")
        await tab.go_to(url)

    await asyncio.sleep(2)
    body = await get_text(tab)
    if "verify you are human" in body.lower():
        log.info("内置绕过未生效，启动手动 Shadow DOM 穿透...")
        return await manual_cf_click(tab)
    return True

# ── 点击提交按钮（核心修复）──────────────────────────────────────────────────

async def click_submit_button(tab):
    """
    先滚动页面让按钮完全进入视口，再用 JS 获取按钮坐标，
    最后用 pydoll mouse.click 模拟真实鼠标点击。
    """
    # 步骤1：用 JS 滚动到按钮并获取其中心坐标（不做可见性过滤，直接找 button）
    coords_json = await js_val(tab, """
        (function() {
            // 优先找 type=submit
            var btn = document.querySelector('button[type="submit"]');
            // 再找含关键字的按钮
            if (!btn) {
                var all = Array.from(document.querySelectorAll('button'));
                var kw = ['continue', 'dashboard', 'login', 'sign in'];
                btn = all.find(b => kw.some(k => b.textContent.trim().toLowerCase().includes(k)));
            }
            if (!btn) btn = document.querySelector('button');
            if (!btn) return null;
            // 先滚动让它进入视口
            btn.scrollIntoView({block: 'center', behavior: 'instant'});
            var r = btn.getBoundingClientRect();
            return JSON.stringify({
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                text: btn.textContent.trim().substring(0, 50)
            });
        })()
    """)

    if not coords_json:
        log.error("[4] JS 未找到任何 button 元素")
        return False

    import json
    coords = json.loads(coords_json)
    log.info(f"[4] 找到按钮: '{coords['text']}' 坐标: ({coords['x']}, {coords['y']})")

    # 步骤2：等一下让滚动完成
    await asyncio.sleep(0.5)

    # 步骤3：用 pydoll mouse 真实鼠标点击坐标
    try:
        await tab.mouse.move(coords['x'], coords['y'])
        await asyncio.sleep(0.2)
        await tab.mouse.click(coords['x'], coords['y'])
        log.info(f"[4] ✅ 鼠标点击完成: ({coords['x']}, {coords['y']})")
        return True
    except Exception as e:
        log.warning(f"[4] 鼠标点击失败: {e}，改用 JS click...")
        # 降级：直接 JS click
        result = await js_val(tab, """
            (function() {
                var btn = document.querySelector('button[type="submit"]') || document.querySelector('button');
                if (btn) { btn.click(); return btn.textContent.trim(); }
                return null;
            })()
        """)
        if result:
            log.info(f"[4] JS click 降级成功: '{result}'")
            return True
        return False

# ── 登录流程 ──────────────────────────────────────────────────────────────────

async def login(tab):
    log.info("[1] 打开登录页...")
    if not await ensure_cf_passed(tab, LOGIN_URL):
        log.error("CF 验证失败")
        return False

    await take_screenshot(tab, "01-login-page")

    # 填邮箱
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

    # 填密码
    log.info("[2] 填写密码...")
    pass_el = await tab.find(tag_name="input", type="password", timeout=5)
    await pass_el.click()
    await human_delay(0.3, 0.7)
    await pass_el.type_text(PASSWORD, humanize=True)
    await human_delay()

    await take_screenshot(tab, "02-before-turnstile")

    # 处理 Turnstile
    log.info("[3] 处理登录页内嵌 Turnstile...")
    await asyncio.sleep(2)
    body = await get_text(tab)
    if "verify you are human" in body.lower() or "请验证" in body:
        cf_ok = await manual_cf_click(tab, timeout=30)
        if not cf_ok:
            log.warning("Turnstile 处理失败，仍尝试提交")
    else:
        log.info("[3] 未检测到 Turnstile，直接提交")

    # Turnstile 通过后等待一下，让 Success! 状态稳定
    await asyncio.sleep(1)
    await take_screenshot(tab, "03-after-turnstile")

    # 点击登录按钮
    log.info("[4] 点击登录按钮...")
    clicked = await click_submit_button(tab)
    if not clicked:
        log.error("[4] 无法点击登录按钮")
        await take_screenshot(tab, "04-no-button")
        return False

    await take_screenshot(tab, "04-after-click")

    # 等待离开登录页
    log.info("[4] 等待跳转...")
    for _ in range(25):
        url = await get_url(tab)
        if "/login" not in url and url.startswith("http"):
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

        log.info(f"[5] 访问服务器 {SERVER_ID}...")
        await ensure_cf_passed(tab, SERVER_URL)
        await asyncio.sleep(2)

        body = await get_text(tab)
        url  = await get_url(tab)
        log.info(f"[5] 当前 URL: {url}")

        if "FREE SERVERS WILL BE DELETED" in body:
            log.info("[5] ✅ WARNING 横幅已出现，保活成功！")
        elif SERVER_ID in url:
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

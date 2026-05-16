# Lunes Keepalive

自动登录 [betadash.lunes.host](https://betadash.lunes.host) 并访问你的服务器页面，防止免费服务器因长期未访问被删除。通过 GitHub Actions 每 5 天自动运行一次。

---

## 工作原理

1. 启动无头 Chromium（通过 Xvfb 模拟真实桌面，绕过 Cloudflare 指纹检测）
2. 打开登录页，填写邮箱和密码
3. 自动处理 Cloudflare Turnstile 验证（Shadow DOM 穿透点击）
4. 登录成功后跳转到你的服务器页面，完成保活
5. 全程截图上传为 Artifact，方便排查问题

---

## 快速开始

### 1. Fork 本仓库

点击右上角 **Fork**，fork 到你自己的 GitHub 账号下。

### 2. 配置 Secrets

进入你的仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加以下三个 secret：

| Secret 名称 | 说明 |
|---|---|
| `LUNES_EMAIL` | 登录 betadash 的邮箱 |
| `LUNES_PASSWORD` | 登录密码 |
| `LUNES_SERVER_ID` | 你的服务器数字 ID（见下方说明） |

**如何找到 Server ID：**
登录 betadash 后，进入你的服务器页面，地址栏 URL 类似：
https://betadash.lunes.host/servers/12345

其中 `12345` 就是你的 Server ID。

### 3. 启用 Actions

Fork 后 GitHub 默认禁用 Actions，进入 **Actions** 标签页，点击 **"I understand my workflows, go ahead and enable them"** 启用。

### 4. 手动触发测试

进入 **Actions → Betadash Keepalive → Run workflow**，手动跑一次确认配置正确。成功后会看到截图 Artifact。

---

## 自动执行计划

默认每月 1、6、11、16、21、26 日 UTC 01:00 自动运行（约每 5 天一次），覆盖 lunes 免费服务器的保活周期。

如需修改频率，编辑 `.github/workflows/keepalive.yml` 中的 `cron` 表达式。

---

## 截图 Artifact

每次运行后会上传截图，保留 7 天，可在 Actions 运行记录页面下载查看：

| 文件名 | 说明 |
|---|---|
| `00-start.png` | 浏览器启动初始状态 |
| `01-login-page.png` | 登录页加载完成 |
| `02-before-turnstile.png` | 填写表单后、提交前 |
| `03-after-turnstile.png` | Turnstile 处理后 |
| `04-after-click.png` | 点击登录按钮后 |
| `05-dashboard.png` | 登录成功，进入 Dashboard |
| `06-server-warning.png` | 访问服务器页面，保活完成 |
| `99-error.png` | 出错时的现场截图（若有） |

---

## 本地运行

```bash
# 安装依赖
pip install -r requirements.txt

# 设置环境变量
export LUNES_EMAIL=your@email.com
export LUNES_PASSWORD=yourpassword
export LUNES_SERVER_ID=12345

# 需要有显示器或 Xvfb
export DISPLAY=:99
Xvfb :99 -screen 0 1366x900x24 +extension RANDR &

python scripts/login.py
```

---

## 依赖

- Python 3.12+
- [pydoll-python](https://github.com/autoscrape-labs/pydoll) — Chromium 自动化
- Chromium / Google Chrome
- Xvfb（仅 Linux 无头环境需要）

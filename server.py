#!/usr/bin/env python3
"""SHEIN 选品定价台 —— 本地服务
- 提供页面静态文件
- POST /api/fetch  {url}  → 调 node fetch-1688.cjs（可见浏览器）抓商品
- GET  /api/status?id=xxx → 抓取进度/结果（前端轮询）
只绑 127.0.0.1，数据不出本机。
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
HERMES = os.path.join(HOME, "AppData", "Local", "hermes")
NODE_MODULES = os.path.join(HERMES, "hermes-agent", "node_modules")
PROFILE_DIR = os.path.join(ROOT, ".chrome-profile")
HOST = os.environ.get("HOST", "0.0.0.0")          # 0.0.0.0 = 局域网可访问；只想本机用就设 127.0.0.1
PORT = int(os.environ.get("PORT", "8901"))
# 抓取会在“这台机器”上弹出浏览器窗口，所以允许别人的机器触发它是个开关
ALLOW_REMOTE_FETCH = os.environ.get("ALLOW_REMOTE_FETCH", "1") != "0"
FETCH_TIMEOUT = 1800          # 单次抓取上限（秒）：人工过验证/扫码可能很慢，给足 30 分钟
# 对 1688 客气一点：同一链接先复用缓存，新链接之间留冷却，绝不并发
CACHE_TTL = int(os.environ.get("CACHE_TTL", "1800"))        # 同一 offer 的抓取结果复用时长（秒）
FETCH_COOLDOWN = int(os.environ.get("FETCH_COOLDOWN", "45"))  # 两次「真正访问 1688」之间最少间隔（秒）
AI_TIMEOUT = int(os.environ.get("AI_TIMEOUT", "120"))         # 等 DeepSeek 排变种的上限（秒），实测 5~25 秒

JOBS = {}
LOCK = threading.Lock()
CACHE = {}          # norm_url → {"at": ts, "product": {...}}
LAST_FETCH_AT = 0.0  # 上次真正请求 1688 的时间
RUNNING = {"id": None}   # 正在跑的抓取（单并发）


def norm_url(u):
    """把链接归一成缓存键：offer 页只认 offer id，其余去掉查询串"""
    m = re.search(r"offer/(\d+)\.html", u or "")
    return "offer:" + m.group(1) if m else re.sub(r"[?#].*$", "", (u or "")).rstrip("/")


def find_node():
    p = shutil.which("node")
    if p:
        return p
    for pat in ("npm-*/node.exe", "node-*/node.exe", "*/node.exe"):
        import glob
        hits = sorted(glob.glob(os.path.join(HERMES, "tools", pat)))
        if hits:
            return hits[-1]
    return None


NODE = find_node()


BROWSER_MARK = os.path.join(ROOT, ".tool-browser.json")
USER_CHROME_MARK = os.path.join(ROOT, ".use-my-chrome.json")
LOG_DIR = os.path.join(ROOT, "logs")


def _cdp_ok(port, timeout=0.6):
    """端口开着不等于能用：实例僵死时 TCP 连得上、CDP 却不答话（这就是「抓不到浏览器」的真身）。
    只有 /json/version 真的返回浏览器版本，才算这个抓取浏览器可用。"""
    if not port:
        return False
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % int(port), timeout=timeout) as r:
            info = json.loads(r.read().decode("utf-8", "replace") or "{}")
        return bool(info.get("Browser"))
    except Exception:
        return False


def _mark_state(path, label):
    """标记文件 + 端口 + CDP 一起判断这个浏览器还在不在、还能不能用"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            m = json.load(f)
    except Exception:
        return {"running": False, "port": None, "mode": label, "cdpOk": False}
    pid, port = m.get("pid"), m.get("port")
    if not port:
        return {"running": False, "port": None, "mode": label, "cdpOk": False, "note": "标记里没有端口"}
    open_port = False
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.25):
            open_port = True
    except Exception:
        open_port = False
    if not open_port:
        return {"running": False, "port": int(port), "mode": label, "cdpOk": False,
                "note": "进程已退出" if (pid and not _pid_alive(pid)) else "端口没在监听"}
    cdp = _cdp_ok(port)
    out = {"running": True, "port": int(port), "mode": label, "cdpOk": cdp}
    if not cdp:
        # 端口开着、CDP 不答话 —— 典型的僵死实例，抓取连上去会干等
        out["note"] = "端口开着但调试协议不答话（实例可能僵死）→ 点「重启抓取浏览器」再试"
    return out


def browser_state():
    """抓取用浏览器状态：优先报「你自己的 Chrome」（那种模式不会弹新窗口）"""
    own = _mark_state(USER_CHROME_MARK, "你自己的 Chrome")
    tool = _mark_state(BROWSER_MARK, "工具浏览器（独立窗口）")
    if own["running"]:
        out = dict(own)
        out["restartable"] = False          # 用户的 Chrome 工具不会去重启
        return out
    if tool["running"]:
        out = dict(tool)
        out["restartable"] = True              # 工具浏览器可以重启（僵死时更需要）
        out["myChrome"] = own
        return out
    return {"running": False, "port": tool.get("port"), "mode": "未打开", "cdpOk": False,
            "restartable": False, "note": "还没开过抓取浏览器，点「读取商品」会自动开一个",
            "myChrome": own, "toolBrowser": tool}


def restart_browser():
    """清掉僵死的工具浏览器并重开一个（**绝不动用户自己的 Chrome**）"""
    if not NODE:
        return {"ok": False, "message": "没找到 node，重启不了"}
    script = os.path.join(ROOT, "tool-browser.cjs")
    if not os.path.isfile(script):
        return {"ok": False, "message": "找不到 tool-browser.cjs"}
    env = dict(os.environ)
    env["NODE_PATH"] = NODE_MODULES
    try:
        pr = subprocess.run([NODE, script, "--restart"], cwd=ROOT, env=env,
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=90)
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "重启抓取浏览器超时（90 秒），可能有两个实例在抢同一个 profile"}
    last = ""
    for line in (pr.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                last = json.loads(line)
            except Exception:
                pass
    err = (pr.stderr or "").strip().splitlines()
    if isinstance(last, dict):
        last.setdefault("log", err[-3:])
        return last
    return {"ok": False, "message": "重启没有返回结果", "log": (err or [(pr.stdout or "")[:200]])[-3:]}


def run_job(job_id, url):
    job = JOBS[job_id]
    if not NODE:
        job.update(state="error", hint="没找到 node，请确认 Hermes 自带的 node 还在。")
        return
    env = dict(os.environ)
    env["NODE_PATH"] = NODE_MODULES
    env.setdefault("PYTHONIOENCODING", "utf-8")
    cmd = [NODE, os.path.join(ROOT, "fetch-1688.cjs"), url,
           "--profile", PROFILE_DIR, "--timeout", str(FETCH_TIMEOUT)]
    job["log"] = []
    # 每个任务另存一份日志文件：进程被强杀时（同一时间点两次 / 服务被重启）内存里的 log 可能一个字都没有，
    # 于是用户只看到「抓取失败」却没有任何原因 —— 那种没法排查，必须留痕。
    jlog = None
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        jlog = open(os.path.join(LOG_DIR, "job-%s.log" % job_id), "a", encoding="utf-8", errors="replace")
        jlog.write("# %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), url))
        jlog.flush()
    except Exception:
        jlog = None

    def keep(line):
        job["log"].append(line)
        if len(job["log"]) > 80:
            job["log"] = job["log"][-80:]
        file_only(line)

    def file_only(line):
        """只写进任务日志文件，不进内存里的 log（内存里那份是给页面看的，逐步状态另有渠道）"""
        if jlog:
            try:
                jlog.write(line + "\n")
                jlog.flush()
            except Exception:
                pass

    try:
        proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                errors="replace", bufsize=1)
        job["pid"] = proc.pid
        with LOCK:
            prev = JOBS.get("__last__")
        if prev and prev != job_id:
            kill_job(prev)
        JOBS["__last__"] = job_id
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            if line.startswith("@@STATUS "):
                try:
                    st = json.loads(line[len("@@STATUS "):])
                    st.setdefault("state", job.get("state"))
                    job.update(st)
                    # 逐步状态也写进任务日志文件：进程要是被强杀，这就是唯一的现场记录
                    file_only("%s %s" % (st.get("state") or "", st.get("hint") or ""))
                except Exception:
                    keep(line)
            elif line.startswith("@@PRODUCT "):
                try:
                    job["product"] = json.loads(line[len("@@PRODUCT "):])
                    job["state"] = "ready"
                    np = len((job["product"].get("specs") or []))
                    file_only("已收到商品数据：%d 个规格维度（%s）" % (np, job["product"].get("title") or ""))
                except Exception as e:
                    job["state"] = "error"
                    job["hint"] = "商品数据解析失败：" + str(e)
            else:
                keep(line)
        rc = proc.wait()
        if job.get("state") not in ("ready", "error"):
            if rc == 0 and job.get("product"):
                job["state"] = "ready"
            else:
                # 走到这里说明进程没说结果就退了：必须给用户一个能看懂的原因，而不是留着他上一步的提示
                job["state"] = "error"
                job["hint"] = ("抓取进程中途退出了（退出码 %s），最后一步是「%s」。常见原因：同一时间点了两次抓取，"
                               "或抓取浏览器卡住被清掉重开。看一眼 logs/job-%s.log，然后重新点一次「读取商品」。"
                               % (rc, job.get("hint") or "启动抓取浏览器", job_id))
                keep("[server] 抓取进程退出码 %s" % rc)
        if job.get("state") == "ready" and job.get("product"):
            with LOCK:
                CACHE[norm_url(url)] = {"at": time.time(), "product": job["product"]}
                print("[fetch] %s 抓完（结果只留给诊断看，下次点会重新抓，不再复用）" % norm_url(url))
    except Exception as e:
        job["state"] = "error"
        job["hint"] = "抓取进程启动失败：" + str(e)
    finally:
        if jlog:
            try:
                jlog.close()
            except Exception:
                pass
        if RUNNING.get("id") == job_id:
            RUNNING["id"] = None


def _pid_alive(pid):
    try:
        # tasklist 在中文 Windows 上输出 GBK，不指定编码会在读取线程里抛 UnicodeDecodeError（只刷日志、无实害）
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=10).stdout or ""
        return str(pid) in out
    except Exception:
        return False


def kill_job(job_id):
    job = JOBS.get(job_id) or {}
    pid = job.get("pid")
    if not pid:
        return
    try:
        # 先温和关：taskkill 不带 /F 会给窗口发 WM_CLOSE，Chrome 能从容退出、把 cookie 落盘，
        # 下次开窗就不用重新登录。2 秒还没退再强杀。
        subprocess.run(["taskkill", "/PID", str(pid), "/T"],
                       capture_output=True, timeout=10)
        time.sleep(2.0)
        if _pid_alive(pid):
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=10)
    except Exception:
        pass


def request_fetch(url, force=False):
    """每次点击都真抓一次（用户要求：每次抓取都强制清空缓存 —— 旧价会骗人）。
    保留的保护：同一时间只允许一次抓取、两次真抓之间留冷却、只开一个标签页。
    返回 (jid, meta, None) 或 (None, None, (err_dict, code))"""
    global LAST_FETCH_AT
    key = norm_url(url)
    now = time.time()
    with LOCK:
        # 先把这条链接的旧结果丢掉：后面任何路径都拿不到旧价
        stale = CACHE.pop(key, None)
        if stale:
            print("[cache] 清掉 %s 的旧结果（%d 分钟前）—— 每次都重新抓" % (key, int((now - stale["at"]) // 60)))
        if RUNNING.get("id"):
            return None, None, ({"error": "已经有一次抓取在进行中了，等它结束再点（同时开两个窗口更容易被 1688 拦）。"}, 409)
        wait = FETCH_COOLDOWN - (now - LAST_FETCH_AT)
        if wait > 0:
            # 冷却与「清缓存」是两件事：缓存每次都清，但两次真抓之间仍然要留间隔（对 1688 太密会招保护验证）
            return None, None, ({"error": "刚抓过一次。为了不让 1688 弹保护验证，请等 %d 秒再点（缓存已经清空，"
                                          "这次点下去会重新读一遍页面）。" % int(wait + 0.999)}, 429)
        jid = uuid.uuid4().hex[:12]
        JOBS[jid] = {"state": "opening", "hint": "正在启动浏览器…", "product": None,
                     "url": url, "started": now, "log": []}
        LAST_FETCH_AT = now
        RUNNING["id"] = jid
    threading.Thread(target=run_job, args=(jid, url), daemon=True).start()
    return jid, {"cached": False}, None


class Server(ThreadingHTTPServer):
    """Windows 上必须关掉 SO_REUSEADDR，否则第二个实例也能绑同一端口（会静默起两份服务）"""
    allow_reuse_address = False
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # 静态文件一律不缓存：改了 index.html / app.js 之后，浏览器不该继续用旧副本
        # （旧 index.html + 新 app.js 之类的错配会让页面静默不工作）
        if not any(b"Cache-Control" in h for h in (self._headers_buffer or [])):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/favicon.ico":
            # 本地工具不需要图标；不处理的话每次打开页面控制台都会多一条 404，干扰排查
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # 只服务页面要用的文件：任何以 . 开头的隐藏文件/目录一律 403。
        # 否则局域网里任何人访问 /.chrome-cookies.json 或 /.chrome-profile/... 都能拿走
        # 你的 1688 登录态（这个服务监听 0.0.0.0）。
        if any(seg.startswith(".") for seg in u.path.split("/") if seg):
            self.send_error(403, "hidden files are not served")
            return
        if u.path == "/api/status":
            qs = parse_qs(u.query)
            jid = (qs.get("id") or [""])[0]
            job = JOBS.get(jid)
            if not job:
                return self._json({"state": "unknown"}, 404)
            out = {k: v for k, v in job.items() if k not in ("log", "pid")}
            out["log"] = (job.get("log") or [])[-12:]
            return self._json(out)
        if u.path == "/api/health":
            with LOCK:
                cached = {k: int(time.time() - v["at"]) for k, v in CACHE.items()}
                last = int(time.time() - LAST_FETCH_AT) if LAST_FETCH_AT else None
            return self._json({"ok": True, "node": bool(NODE), "node_path": NODE,
                               "playwright": os.path.isdir(os.path.join(NODE_MODULES, "playwright")),
                               "ai": ai_config_ok(),
                               "cooldownSec": FETCH_COOLDOWN, "cacheTtlSec": CACHE_TTL,
                               "fetchTimeoutSec": FETCH_TIMEOUT, "browser": browser_state(),
                               "running": RUNNING.get("id"), "lastFetchAgoSec": last,
                               "cachedOffers": cached})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path not in ("/api/fetch", "/api/ai-plan", "/api/browser-restart"):
            return self._json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json({"error": "bad json"}, 400)
        if u.path == "/api/browser-restart":
            # 只重启工具自己的那个抓取浏览器；用户自己的 Chrome 一律不动
            res = restart_browser()
            print("[browser] 重启抓取浏览器：%s" % str(res.get("message") or res)[:160])
            return self._json(res)
        if u.path == "/api/ai-plan":
            prod = data.get("product") or {}
            if not ((prod.get("specs") or []) or (prod.get("colors") or [])):
                return self._json({"ok": False, "error": "还没有规格数据 —— 先点「读取商品」，再让 DeepSeek 排变种"}, 400)
            res = run_ai_plan(prod, data.get("params") or {})
            what = ("%d 行" % len(res.get("rows") or [])) if res.get("ok") else ("失败：" + str(res.get("error") or "")[:100])
            print("[ai] %s（%.1fs）" % (what, res.get("elapsedSec") or 0))
            return self._json(res)
        url = (data.get("url") or "").strip()
        if not re.match(r"^https?://", url):
            return self._json({"error": "请输入完整的商品链接（http/https 开头）"}, 400)
        client = self.client_address[0]
        if not ALLOW_REMOTE_FETCH and not (client.startswith("127.") or client == "::1"):
            return self._json({"error": "抓取会在服务所在的那台电脑上弹出浏览器，已设置为只允许本机触发。"
                                        "（把环境变量 ALLOW_REMOTE_FETCH 设为 1 并重启服务即可放开）"}, 403)
        jid, meta, err = request_fetch(url, bool(data.get("force")))
        if err:
            return self._json(err[0], err[1])
        out = {"id": jid}
        out.update(meta or {})
        return self._json(out)


def ai_config_ok():
    """AI（DeepSeek）密钥配了没——只判存在性，不读内容、不回显"""
    if (os.environ.get("DEEPSEEK_API_KEY") or "").strip():
        return True
    p = os.path.join(ROOT, ".ai.json")
    try:
        with open(p, encoding="utf-8") as f:
            return bool((json.load(f).get("apiKey") or "").strip())
    except Exception:
        return False


def run_ai_plan(product, params):
    """把商品数据交给 DeepSeek 排「变种计划」（它只排组合/件数/英文名，价格与成本仍由前端引擎算）。
    密钥只在服务端：node 进程自己从 .ai.json 读，日志与返回值里都不含密钥。"""
    if not NODE:
        return {"ok": False, "error": "没找到 node，AI 计划跑不起来"}
    env = dict(os.environ)
    env["NODE_PATH"] = NODE_MODULES
    payload = json.dumps({"product": product, "params": params or {}}, ensure_ascii=False).encode("utf-8")
    t0 = time.time()
    try:
        pr = subprocess.run([NODE, os.path.join(ROOT, "ai-plan.cjs")], input=payload,
                            capture_output=True, env=env, timeout=AI_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "DeepSeek 想了 %d 秒还没结果，已放弃（可以直接再点一次）" % AI_TIMEOUT,
                "elapsedSec": AI_TIMEOUT}
    out = (pr.stdout or b"").decode("utf-8", "replace").strip()
    try:
        res = json.loads(out or "{}")
        if not isinstance(res, dict):
            res = {"ok": False, "error": "AI 计划返回了预期以外的结构"}
    except Exception:
        err = (pr.stderr or b"").decode("utf-8", "replace")[:200]
        res = {"ok": False, "error": "AI 计划进程输出了看不懂的内容：" + (out[:200] or err)}
    res["elapsedSec"] = round(time.time() - t0, 1)
    return res


def _setup_logging():
    """服务自己写日志（logs/server.log），不依赖启动脚本的重定向"""
    try:
        logdir = os.path.join(ROOT, "logs")
        os.makedirs(logdir, exist_ok=True)
        fp = open(os.path.join(logdir, "server.log"), "a", encoding="utf-8", buffering=1)
    except Exception:
        return

    class _Tee:
        def __init__(self, f, orig):
            self.f, self.orig = f, orig

        def write(self, s):
            for x in (self.orig, self.f):
                try:
                    x.write(s)
                except Exception:
                    pass
            return len(s)

        def flush(self):
            for x in (self.orig, self.f):
                try:
                    x.flush()
                except Exception:
                    pass

    sys.stdout = _Tee(fp, sys.stdout)
    sys.stderr = _Tee(fp, sys.stderr)
    print("---- %s 服务启动 ----" % time.strftime("%Y-%m-%d %H:%M:%S"))


def lan_ip():
    """拿到本机在局域网里的主 IP（不会真的发包）"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


def main():
    _setup_logging()
    ip = lan_ip()
    print("=" * 66)
    print(" SHEIN 选品定价台")
    print("   本机   : http://127.0.0.1:%d/" % PORT)
    if HOST == "0.0.0.0" and ip:
        print("   局域网 : http://%s:%d/   ← 发给同事用这个" % (ip, PORT))
    print("   监听   : %s:%d   （HOST=127.0.0.1 可改成只允许本机）" % (HOST, PORT))
    print("   抓取权限: %s" % ("本机+局域网均可触发" if ALLOW_REMOTE_FETCH else "仅本机可触发抓取"))
    print(" node   :", NODE or "未找到")
    print(" 浏览器插件:", "playwright 已就位" if os.path.isdir(os.path.join(NODE_MODULES, "playwright")) else "缺 playwright")
    print(" 这是常驻服务，关掉方式：stop-service.cmd")
    print("=" * 66)

    # 自愈循环：服务内部异常退出就 10 秒后自己拉起来（被 kill 则整个进程结束，由下次开机或 serve.cmd 拉起）
    while True:
        try:
            srv = Server((HOST, PORT), Handler)
        except OSError as e:
            print("端口 %d 起不来（已经有实例在跑）：%s" % (PORT, e))
            return
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
            return
        except Exception as e:
            print("服务异常退出：%r，10 秒后自动重启" % (e,))
        try:
            srv.server_close()
        except Exception:
            pass
        time.sleep(10)


if __name__ == "__main__":
    main()

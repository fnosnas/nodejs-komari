const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require("path");
const os = require('os');
const net = require('net');
const dns = require('dns');

try {
    require.resolve("express");
    require.resolve("axios");
    require.resolve("ws");
} catch {
    execSync('npm install --no-save', { stdio: 'inherit' });
}

const express = require("express");
const axios = require("axios");
const { WebSocket } = require("ws");
const app = express();

const PORT = process.env.PORT || 3000;

const FILE_PATH = './tmp';
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';

/* ✅ Komari 新版参数 */
const KOMARI_ENDPOINT = process.env.KOMARI_ENDPOINT || 'https://komari.afnos86.xx.kg';
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || '';

/* 日志：默认全部静默，SHOW_LOG=1 时输出 Komari 调试日志 */
const SHOW_LOG = /^(1|true|yes)$/i.test(process.env.SHOW_LOG || '');
function log(...args) { if (SHOW_LOG) console.log(...args); }
function logErr(...args) { if (SHOW_LOG) console.error(...args); }

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';

const ARGO_PORT = 8001;
const CFIP = 'wto.org';
const CFPORT = 443;

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const xrayPath = path.join(FILE_PATH, "xray");
const argoPath = path.join(FILE_PATH, "argo");
const configPath = path.join(FILE_PATH, "config.json");

/* 下载（静默，不打印下载进度日志） */
async function download(name, url, save) {
    if (fs.existsSync(save)) return;

    const writer = fs.createWriteStream(save);

    const res = await axios({ method: "get", url, responseType: "stream" });
    res.data.pipe(writer);

    await new Promise(r => writer.on("finish", r));
    fs.chmodSync(save, 0o755);
}

/* ✅ 智能守护（不会疯狂重启，且不再继承子进程标准输出，日志被屏蔽） */
function daemon(name, cmd, args, delay = 5000) {

    let restarting = false;

    const run = () => {
        // stdio 改为 "ignore"：子进程（Xray / Argo / Komari）的日志不再打印到容器控制台
        const p = spawn(cmd, args, { stdio: "ignore" });

        p.on("exit", () => {
            if (restarting) return;

            restarting = true;

            setTimeout(() => {
                restarting = false;
                run();
            }, delay);
        });
    };

    run();
}

// ==================== Komari-Agent（纯 JS，内置在 Node 里，不下载任何程序） ====================
// 协议与官方 komari-agent 1.6.x 相同：v2 JSON-RPC
//   上报基础信息：POST  {面板}/api/clients/v2/rpc?token=xxx   method=agent.basicInfo
//   实时状态：    WS    {面板}/api/clients/v2/rpc?token=xxx   method=agent.report（每 3 秒）
//   WS 连不上时自动改用 POST 上报 + 拉取任务，同时每 30 秒尝试恢复 WS
//   支持：网页终端（agent.terminal.request）、远程命令（agent.exec）、延迟检测（agent.ping）
// 保活方式与原哪吒 agent 一样：跟随 Node 进程运行，断线 10 秒后自动重连，永不退出
const KOMARI_VERSION = 'nodejs-komari-1.0.0';
const REPORT_INTERVAL = 3000;      // 状态上报间隔
const RETRY_DELAY = 10000;         // 断线重连间隔
const INFO_INTERVAL = 5 * 60000;   // 基础信息刷新间隔
const IP_REFRESH = 30 * 60000;     // 公网 IP 刷新间隔
const KOMARI_SSH = !/^(1|true|yes)$/i.test(process.env.KOMARI_DISABLE_SSH || ''); // KOMARI_DISABLE_SSH=true 关闭网页终端和远程命令

const EXCLUDE_IFACES = ['lo', 'tun', 'docker', 'veth', 'br-', 'vmbr', 'vnet', 'kube', 'Meta', 'tailscale', 'fw', 'tap', 'cni', 'flannel', 'cali'];
let komariEndpoint = '', komariWs = null, komariWsAlive = false;
let lastCpu = null, lastNet = null, cachedIP = { ipv4: '', ipv6: '', at: 0 };
const ackIds = [];
const seenEvents = new Map();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function goArch() { return { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm', s390x: 's390x', ppc64: 'ppc64le' }[process.arch] || process.arch; }

// ---------- 系统信息 ----------
function osName() {
  const rel = readText('/etc/os-release');
  const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  if (m) return m[1];
  return `${os.type()} ${os.release()}`;
}

function virtualization() {
  if (fs.existsSync('/.dockerenv')) return 'docker';
  if (fs.existsSync('/run/.containerenv')) return 'podman';
  const cg = readText('/proc/1/cgroup');
  if (/kubepods/.test(cg)) return 'kubernetes';
  if (/docker|containerd/.test(cg)) return 'docker';
  if (/lxc/.test(cg) || /container=lxc/.test(readText('/proc/1/environ'))) return 'lxc';
  return '';
}

// 容器里优先用 cgroup 的内存上限，否则用 /proc/meminfo，最后用 os 模块
function cgroupMem() {
  let max = readText('/sys/fs/cgroup/memory.max').trim(), cur = readText('/sys/fs/cgroup/memory.current').trim();
  if (!max) { max = readText('/sys/fs/cgroup/memory/memory.limit_in_bytes').trim(); cur = readText('/sys/fs/cgroup/memory/memory.usage_in_bytes').trim(); }
  const total = Number(max), used = Number(cur);
  if (!total || !isFinite(total) || total <= 0 || total >= os.totalmem() || !used) return null;
  let cache = 0;
  const stat = readText('/sys/fs/cgroup/memory.stat') || readText('/sys/fs/cgroup/memory/memory.stat');
  const m = stat.match(/^(?:inactive_file|total_inactive_file) (\d+)/m);
  if (m) cache = Number(m[1]);
  return { total, used: Math.max(0, used - cache) };
}

function memInfo() {
  const info = {};
  readText('/proc/meminfo').split('\n').forEach(l => { const m = l.match(/^(\w+):\s+(\d+)/); if (m) info[m[1]] = Number(m[2]) * 1024; });
  let total = info.MemTotal || os.totalmem();
  let used = info.MemAvailable !== undefined ? total - info.MemAvailable : total - os.freemem();
  const cg = cgroupMem();
  if (cg) { total = cg.total; used = cg.used; }
  return { total, used: Math.max(0, used), swapTotal: info.SwapTotal || 0, swapUsed: Math.max(0, (info.SwapTotal || 0) - (info.SwapFree || 0)) };
}

function diskInfo() {
  try {
    if (fs.statfsSync) {
      const s = fs.statfsSync('/');
      const total = s.blocks * s.bsize;
      return { total, used: Math.max(0, total - s.bfree * s.bsize) };
    }
  } catch (e) { }
  try {
    const out = spawnSync('df', ['-kP', '/'], { encoding: 'utf8', timeout: 5000 }).stdout || '';
    const p = out.trim().split('\n').pop().split(/\s+/);
    if (p.length >= 4) return { total: Number(p[1]) * 1024, used: Number(p[2]) * 1024 };
  } catch (e) { }
  return { total: 0, used: 0 };
}

function cpuUsage() {
  let idle = 0, total = 0;
  const line = readText('/proc/stat').split('\n')[0];
  if (line.startsWith('cpu ')) {
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    idle = v[3] + (v[4] || 0); total = v.slice(0, 8).reduce((a, b) => a + b, 0);
  } else {
    for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
  }
  let usage = 0.001;
  if (lastCpu && total > lastCpu.total) usage = Math.max(0.001, (1 - (idle - lastCpu.idle) / (total - lastCpu.total)) * 100);
  lastCpu = { idle, total };
  return Math.round(usage * 100) / 100;
}

function netInfo() {
  let rx = 0, tx = 0;
  readText('/proc/net/dev').split('\n').slice(2).forEach(l => {
    const m = l.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m || EXCLUDE_IFACES.some(x => m[1].includes(x))) return;
    const v = m[2].split(/\s+/).map(Number);
    rx += v[0] || 0; tx += v[8] || 0;
  });
  const now = Date.now();
  let up = 0, down = 0;
  if (lastNet && now > lastNet.t) {
    const dt = (now - lastNet.t) / 1000;
    down = Math.max(0, Math.round((rx - lastNet.rx) / dt));
    up = Math.max(0, Math.round((tx - lastNet.tx) / dt));
  }
  lastNet = { rx, tx, t: now };
  return { up, down, totalUp: tx, totalDown: rx };
}

function connCount() {
  const n = f => Math.max(0, readText(f).split('\n').filter(Boolean).length - 1);
  return { tcp: n('/proc/net/tcp') + n('/proc/net/tcp6'), udp: n('/proc/net/udp') + n('/proc/net/udp6') };
}

function procCount() {
  try { return fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).length; } catch (e) { return 0; }
}

async function fetchIP() {
  if (cachedIP.at && Date.now() - cachedIP.at < IP_REFRESH) return cachedIP;
  const get = async (urls, family) => {
    for (const url of urls) {
      try {
        const r = await axios.get(url, { timeout: 8000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' }, lookup: (h, o, cb) => dns.lookup(h, { family }, cb) });
        const body = String(r.data).trim();
        const ip = (body.match(/^ip=(.+)$/m) || [null, body])[1].trim();
        if ((family === 4 && net.isIPv4(ip)) || (family === 6 && net.isIPv6(ip))) return ip;
      } catch (e) { }
    }
    return '';
  };
  const [ipv4, ipv6] = await Promise.all([
    get(['https://api-ipv4.ip.sb/ip', 'https://www.cloudflare.com/cdn-cgi/trace'], 4),
    get(['https://api-ipv6.ip.sb/ip', 'https://www.cloudflare.com/cdn-cgi/trace'], 6),
  ]);
  cachedIP = { ipv4, ipv6, at: Date.now() };
  return cachedIP;
}

function cpuName() {
  const c = (os.cpus() || [])[0];
  if (c && c.model && !/^unknown$/i.test(c.model.trim())) return c.model.trim();
  const info = readText('/proc/cpuinfo');
  for (const key of ['model name', 'Hardware', 'cpu model', 'Processor']) {
    const m = info.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi'));
    if (m && !/^\d+$/.test(m[1].trim())) return m[1].trim();
  }
  return `${goArch()} CPU`;
}

async function basicInfo() {
  const cpus = os.cpus() || [];
  const mem = memInfo(), disk = diskInfo(), ip = await fetchIP();
  return {
    cpu_name: cpuName(), cpu_cores: cpus.length || 1, cpu_physical_cores: 0,
    arch: goArch(), os: osName(), kernel_version: os.release(), ipv4: ip.ipv4, ipv6: ip.ipv6,
    mem_total: mem.total, swap_total: mem.swapTotal, disk_total: disk.total, gpu_name: '',
    virtualization: virtualization(), version: KOMARI_VERSION,
  };
}

function buildReport() {
  const mem = memInfo(), disk = diskInfo(), load = os.loadavg();
  return {
    cpu: { usage: cpuUsage() },
    ram: { total: mem.total, used: mem.used },
    swap: { total: mem.swapTotal, used: mem.swapUsed },
    load: { load1: load[0] || 0, load5: load[1] || 0, load15: load[2] || 0 },
    disk: { total: disk.total, used: disk.used },
    network: netInfo(),
    connections: connCount(),
    uptime: Math.floor(os.uptime()),
    process: procCount(),
    message: '',
  };
}

// ---------- 通信 ----------
function rpcMsg(method, params, id) {
  const m = { jsonrpc: '2.0', method, params };
  if (id !== undefined) m.id = id;
  return m;
}

async function postRpc(msg, timeout = 30000) {
  const r = await axios.post(`${komariEndpoint}/api/clients/v2/rpc?token=${encodeURIComponent(KOMARI_TOKEN)}`, msg, {
    timeout, proxy: false, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const data = typeof r.data === 'string' && r.data.trim() ? JSON.parse(r.data) : r.data;
  if (data && data.error) throw new Error(`rpc error ${data.error.code}: ${data.error.message}`);
  return data;
}

// 优先走已连上的 WS，否则走 POST
async function sendRpc(msg) {
  if (komariWsAlive && komariWs && komariWs.readyState === WebSocket.OPEN) {
    try { komariWs.send(JSON.stringify(msg)); return; } catch (e) { }
  }
  try { await postRpc(msg); } catch (e) { logErr('[Komari] POST 失败:', e.message); }
}

async function uploadBasicInfo() {
  try { await postRpc(rpcMsg('agent.basicInfo', { info: await basicInfo() }, 'basic-info')); log('[Komari] 基础信息上报成功'); return true; }
  catch (e) { logErr('[Komari] 基础信息上报失败:', e.message); return false; }
}

function markSeen(id) {
  if (!id) return true;
  const now = Date.now();
  for (const [k, t] of seenEvents) if (now - t > 600000) seenEvents.delete(k);
  if (seenEvents.has(id)) return false;
  seenEvents.set(id, now);
  return true;
}

function handleEvent(method, params, eventId) {
  if (!markSeen(eventId)) return true;
  params = params || {};
  switch (method) {
    case 'agent.exec': runExecTask(params.task_id, params.command); return true;
    case 'agent.ping': runPingTask(params.ping_task_id, params.ping_type, params.ping_target); return true;
    case 'agent.terminal.request': if (params.request_id) startTerminal(params.request_id); return true;
    case 'agent.message': case 'agent.event': log('[Komari] 收到消息:', JSON.stringify(params)); return true;
    default: log('[Komari] 不支持的任务:', method); return false;
  }
}

function processEvents(resp) {
  const events = resp && resp.result && resp.result.events;
  if (!Array.isArray(events)) return;
  for (const ev of events) if (handleEvent(ev.method, ev.params, ev.id) && ev.id) ackIds.push(ev.id);
}

// ---------- 远程命令 ----------
function runExecTask(taskId, command) {
  if (!taskId) return;
  let sent = false;
  const done = (result, code) => { if (sent) return; sent = true; sendRpc(rpcMsg('agent.taskResult', { task_id: taskId, result, exit_code: code, finished_at: new Date().toISOString() })); };
  if (!String(command || '').trim()) return done('No command provided', 0);
  if (!KOMARI_SSH) return done('Remote control is disabled.', -1);
  let out = '', err = '';
  let child;
  try {
    child = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-Command', command])
      : spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return done(e.message, -1); }
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('error', e => done(e.message, -1));
  child.on('close', code => done((err ? (out ? out + '\n' + err : err) : out).replace(/\r\n/g, '\n'), code === null ? -1 : code));
  if (process.platform !== 'win32') { child.stdin.write(command); child.stdin.end(); }
}

// ---------- 延迟检测 ----------
function tcpPing(target, timeout) {
  return new Promise((resolve) => {
    let host = target, port = 80;
    const m = target.match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (m && !net.isIPv6(target)) { host = m[1]; port = Number(m[2]); }
    dns.lookup(host.replace(/^\[|\]$/g, ''), (e, addr) => {
      if (e) return resolve(-1);
      const start = Date.now();
      const s = net.connect({ host: addr, port, timeout });
      s.on('connect', () => { resolve(Date.now() - start); s.destroy(); });
      s.on('timeout', () => { resolve(-1); s.destroy(); });
      s.on('error', () => resolve(-1));
    });
  });
}

function httpPing(target, timeout) {
  return new Promise((resolve) => {
    let url = target;
    if (net.isIPv6(url)) url = `[${url}]`;
    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    const start = Date.now();
    axios.get(url, { timeout, maxRedirects: 0, validateStatus: s => s >= 200 && s < 400 })
      .then(() => resolve(Date.now() - start)).catch(() => resolve(-1));
  });
}

function icmpPing(target, timeout) {
  return new Promise((resolve) => {
    try {
      const args = process.platform === 'win32' ? ['-n', '1', '-w', String(timeout), target] : ['-c', '1', '-W', String(Math.ceil(timeout / 1000)), target];
      const c = spawn('ping', args);
      let out = '';
      c.stdout.on('data', d => out += d);
      c.on('error', () => resolve(null));          // 没有 ping 命令
      c.on('close', () => { const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i); resolve(m ? Math.round(Number(m[1])) : -1); });
    } catch (e) { resolve(null); }
  });
}

async function runPingTask(taskId, type, target) {
  if (!taskId || !target) return;
  const timeout = 3000;
  let value = -1;
  if (type === 'tcp') value = await tcpPing(target, timeout);
  else if (type === 'http') value = await httpPing(target, timeout);
  else if (type === 'icmp') { const v = await icmpPing(target, timeout); value = v === null ? await tcpPing(target, timeout) : v; } // 容器没有 ping 权限时用 TCP 80 代替
  sendRpc(rpcMsg('agent.pingResult', { task_id: taskId, ping_type: type, value, finished_at: new Date().toISOString() }));
}

// ---------- 网页终端 ----------
function spawnShell() {
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'));
  const env = { ...process.env, TERM: 'xterm-256color' };
  const cwd = process.env.HOME || process.cwd();
  try {
    const pty = require('node-pty');
    const p = pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 30, cwd, env });
    return { write: d => p.write(d), onData: cb => p.onData(d => cb(Buffer.from(d))), resize: (c, r) => p.resize(c, r), kill: () => p.kill(), onExit: cb => p.onExit(() => cb()) };
  } catch (e) { }
  // 没有 node-pty 时降级：script / python pty / 普通 shell
  const tries = process.platform === 'win32' ? [[shell, []]] : [
    ['script', ['-qfc', `${shell} -i`, '/dev/null']],
    ['python3', ['-c', 'import pty,os;pty.spawn([os.environ.get("SHELL","/bin/sh"),"-i"])']],
    ['python', ['-c', 'import pty,os;pty.spawn([os.environ.get("SHELL","/bin/sh"),"-i"])']],
    [shell, ['-i']],
  ];
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
      if (r.status !== 0 && !cmd.startsWith('/')) continue;
      const c = spawn(cmd, args, { cwd, env: { ...env, SHELL: shell }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (!c.pid) continue;
      return {
        write: d => { try { c.stdin.write(d); } catch (e) { } },
        onData: cb => { c.stdout.on('data', cb); c.stderr.on('data', cb); },
        resize: () => { },
        kill: () => { try { process.kill(-c.pid, 'SIGKILL'); } catch (e) { } try { c.kill('SIGKILL'); } catch (e) { } },
        onExit: cb => { c.on('exit', cb); c.on('error', cb); },
      };
    } catch (e) { }
  }
  return null;
}

function startTerminal(requestId) {
  const url = `${komariEndpoint.replace(/^http/i, 'ws')}/api/clients/terminal?token=${encodeURIComponent(KOMARI_TOKEN)}&id=${encodeURIComponent(requestId)}`;
  const ws = new WebSocket(url, { handshakeTimeout: 15000 });
  let term = null, closed = false, hb = null;
  const close = () => {
    if (closed) return; closed = true;
    if (hb) clearInterval(hb);
    if (term) term.kill();
    try { ws.close(); } catch (e) { }
  };
  ws.on('open', () => {
    if (!KOMARI_SSH || !(term = spawnShell())) {
      try { ws.send(JSON.stringify({ type: 'terminate' })); } catch (e) { }
      logErr('[Komari] 网页终端不可用（已关闭或无法创建 shell）');
      return close();
    }
    log('[Komari] 网页终端已连接:', requestId);
    term.onData(d => { if (!closed && ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true }); });
    term.onExit(() => { try { ws.send(JSON.stringify({ type: 'terminate' })); } catch (e) { } close(); });
    hb = setInterval(() => { try { ws.ping(); } catch (e) { } }, 30000);
  });
  ws.on('message', (data, isBinary) => {
    if (!term) return;
    if (isBinary) return term.write(data);
    let cmd = null;
    try { cmd = JSON.parse(data.toString()); } catch (e) { }
    if (!cmd || !cmd.type) return term.write(data);
    switch (cmd.type) {
      case 'resize': if (cmd.cols > 0 && cmd.rows > 0) { try { term.resize(cmd.cols, cmd.rows); } catch (e) { } } break;
      case 'input': if (cmd.input) term.write(cmd.input); break;
      case 'terminate': case 'close': case 'abort': close(); break;
      case 'heartbeat': if (cmd.id) { try { ws.send(JSON.stringify({ type: 'heartbeat', id: cmd.id })); } catch (e) { } } break;
    }
  });
  ws.on('close', close);
  ws.on('error', (e) => { logErr('[Komari] 终端连接错误:', e.message); close(); });
}

// ---------- 主循环 ----------
function connectWs() {
  return new Promise((resolve) => {
    const url = `${komariEndpoint.replace(/^http/i, 'ws')}/api/clients/v2/rpc?token=${encodeURIComponent(KOMARI_TOKEN)}`;
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    let opened = false;
    ws.once('open', () => { opened = true; resolve(ws); });
    ws.once('error', (e) => { if (!opened) { logErr('[Komari] WS 连接失败:', e.message); resolve(null); } });
    ws.once('unexpected-response', (req, res) => { if (!opened) { logErr('[Komari] WS 连接失败: HTTP', res.statusCode); resolve(null); try { req.destroy(); } catch (e) { } } });
  });
}

async function runWsSession(ws) {
  komariWs = ws; komariWsAlive = true;
  log('komari agent is running...');
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m && m.jsonrpc === '2.0' && m.method) handleEvent(m.method, m.params, ''); } catch (e) { }
  });
  await new Promise((resolve) => {
    let lastPong = Date.now();
    ws.on('pong', () => lastPong = Date.now());
    const report = setInterval(() => {
      try { ws.send(JSON.stringify(rpcMsg('agent.report', { report: buildReport() }))); }
      catch (e) { ws.terminate(); }
    }, REPORT_INTERVAL);
    const heart = setInterval(() => {
      if (Date.now() - lastPong > 90000) { logErr('[Komari] 心跳超时'); return ws.terminate(); }
      try { ws.ping(); } catch (e) { ws.terminate(); }
    }, 30000);
    const finish = () => { clearInterval(report); clearInterval(heart); resolve(); };
    ws.on('close', finish);
    ws.on('error', (e) => { logErr('[Komari] WS 错误:', e.message); try { ws.terminate(); } catch (_) { } });
  });
  komariWsAlive = false; komariWs = null;
}

// WS 用不了时：POST 上报 + 拉取任务，每 30 秒试一次恢复 WS
async function runPostFallback() {
  log('[Komari] 进入 POST 上报模式');
  let stop = false;
  const pull = (async () => {
    while (!stop) {
      try {
        const ids = ackIds.splice(0);
        processEvents(await postRpc(rpcMsg('agent.pull', { capabilities: ['exec', 'ping', 'message', 'event', 'terminal'], ack_event_ids: ids }, `pull-${Date.now()}`), 40000));
      } catch (e) { if (!stop) await sleep(RETRY_DELAY); }
    }
  })();
  let nextWsTry = Date.now() + 30000;
  while (true) {
    try {
      const ids = ackIds.splice(0);
      processEvents(await postRpc(rpcMsg('agent.report', { report: buildReport(), ack_event_ids: ids }, `report-${Date.now()}`)));
    } catch (e) { logErr('[Komari] POST 上报失败:', e.message); }
    if (Date.now() >= nextWsTry) {
      nextWsTry = Date.now() + 30000;
      const ws = await connectWs();
      if (ws) { stop = true; pull.catch(() => { }); return ws; }
    }
    await sleep(REPORT_INTERVAL);
  }
}

async function startKomariAgent() {
  if (!KOMARI_ENDPOINT || !KOMARI_TOKEN) {
    log('[Komari] KOMARI_ENDPOINT 或 KOMARI_TOKEN 未配置，跳过 komari agent');
    return;
  }
  komariEndpoint = (/^https?:\/\//i.test(KOMARI_ENDPOINT) ? KOMARI_ENDPOINT : `https://${KOMARI_ENDPOINT}`).replace(/\/+$/, '');
  log('[Komari] 面板:', komariEndpoint);
  cpuUsage(); netInfo();   // 先取一次基准值，第一次上报的 CPU 和网速才准确

  setInterval(() => { uploadBasicInfo(); }, INFO_INTERVAL);
  let fails = 0;
  while (true) {
    try {
      await uploadBasicInfo();
      let ws = await connectWs();
      if (!ws && ++fails >= 3) { ws = await runPostFallback(); }
      if (ws) { fails = 0; await runWsSession(ws); log('[Komari] WS 已断开'); }
    } catch (e) { logErr('[Komari] 连接异常:', e.message); }
    await sleep(RETRY_DELAY);
  }
}

async function main() {

    const isArm = os.arch().includes("arm");

    const xrayUrl = isArm
        ? "https://arm64.ssss.nyc.mn/web"
        : "https://amd64.ssss.nyc.mn/web";

    const argoUrl = isArm
        ? "https://arm64.ssss.nyc.mn/bot"
        : "https://amd64.ssss.nyc.mn/bot";

    await download("Xray", xrayUrl, xrayPath);
    await download("Argo", argoUrl, argoPath);

    /* Xray 配置：日志级别改为 none，彻底关闭 Xray 自身日志 */
    const config = {
        log: { loglevel: "none" },
        inbounds: [{
            port: ARGO_PORT,
            listen: "127.0.0.1",
            protocol: "vless",
            settings: {
                clients: [{ id: UUID }],
                decryption: "none"
            },
            streamSettings: {
                network: "ws",
                wsSettings: { path: "/vless-argo" }
            }
        }],
        outbounds: [{ protocol: "freedom" }]
    };

    fs.writeFileSync(configPath, JSON.stringify(config));

    daemon("Xray", xrayPath, ["-c", configPath]);


    /* Argo */
    if (ARGO_AUTH && ARGO_AUTH.length > 50) {
        daemon("Argo", argoPath, [
            "tunnel",
            "--no-autoupdate",
            "run",
            "--token",
            ARGO_AUTH
        ]);
    } else {
        daemon("Argo", argoPath, [
            "tunnel",
            "--no-autoupdate",
            "--url",
            `http://localhost:${ARGO_PORT}`
        ]);
    }
}

/* Web */
app.get("/", (_, res) => {
    const htmlPath = path.join(__dirname, "index.html");
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.send("Hello world!");
    }
});

app.get("/sub", (_, res) => {
    const sub = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless-argo#Komari`;
    res.send(Buffer.from(sub).toString('base64'));
});

app.listen(PORT, () => {
    startKomariAgent();   // 纯 JS Komari 探针，不再下载 komari-agent；独立运行，不受 Xray/Argo 下载影响
    main();
});

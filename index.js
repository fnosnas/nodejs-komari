const os = require("os");
const fs = require("fs");
const path = require("path");
const net = require("net");
const axios = require("axios");
const express = require("express");
const { spawn } = require("child_process");

const app = express();

/* ================= 基础配置 ================= */
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const FILE_PATH = process.env.FILE_PATH || "./tmp";
const SUB_PATH = process.env.SUB_PATH || "sub";
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913";

const NEZHA_SERVER = process.env.NEZHA_SERVER || "";
const NEZHA_KEY = process.env.NEZHA_KEY || "";

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";
const ARGO_AUTH = process.env.ARGO_AUTH || "";
const ARGO_PORT = 8001; // 与你原始代码一致

const CFIP = process.env.CFIP || "cdns.doon.eu.org";
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || "Komari-Node";

/* ================= 路径 ================= */
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

const XRAY = path.join(FILE_PATH, "xray_bin");
const ARGO = path.join(FILE_PATH, "argo_bin");
const KOMARI = path.join(FILE_PATH, "komari_agent");
const XRAY_CONF = path.join(FILE_PATH, "config.json");

/* ================= 日志工具 ================= */
function ts() {
  return new Date().toISOString();
}

function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}

function short(str, max = 180) {
  if (!str) return "";
  const s = String(str).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + " ..." : s;
}

function safeMask(str, keep = 6) {
  if (!str) return "";
  if (str.length <= keep * 2) return "*".repeat(str.length);
  return str.slice(0, keep) + "***" + str.slice(-keep);
}

function attachProcessLogs(name, proc) {
  if (!proc) return;

  log(name, `spawned pid=${proc.pid}`);

  if (proc.stdout) {
    proc.stdout.on("data", (buf) => {
      const text = String(buf).split(/\r?\n/).filter(Boolean);
      for (const line of text) {
        log(name, `stdout: ${line}`);
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on("data", (buf) => {
      const text = String(buf).split(/\r?\n/).filter(Boolean);
      for (const line of text) {
        log(name, `stderr: ${line}`);
      }
    });
  }

  proc.on("error", (err) => {
    log(name, `process error: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    log(name, `exited code=${code} signal=${signal}`);
  });

  proc.on("close", (code, signal) => {
    log(name, `closed code=${code} signal=${signal}`);
  });
}

/* ================= TCP 检查 Xray 监听 ================= */
function checkPort(host, port, label = "TCP") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;

    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (ok) {
        log(label, `${host}:${port} reachable`);
      } else {
        log(label, `${host}:${port} unreachable -> ${reason}`);
      }
      resolve(ok);
    };

    socket.setTimeout(2500);
    socket.on("connect", () => finish(true, "connected"));
    socket.on("timeout", () => finish(false, "timeout"));
    socket.on("error", (err) => finish(false, err.message));
  });
}

/* ================= 下载工具 ================= */
async function download(name, url, savePath) {
  if (!url) {
    log("Download", `${name} url empty, skip`);
    return;
  }

  if (fs.existsSync(savePath)) {
    log("Download", `${name} already exists -> ${savePath}`);
    return;
  }

  log("Download", `${name} start -> ${url}`);

  const response = await axios({
    method: "get",
    url,
    responseType: "stream",
    timeout: 60000
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(savePath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  fs.chmodSync(savePath, 0o755);
  log("Download", `${name} saved -> ${savePath}`);
}

/* ================= Komari 下载地址 ================= */
function getKomariUrl() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform !== "linux") {
    log("Komari", `unsupported platform: ${platform}`);
    return null;
  }

  if (arch === "x64") {
    return "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-amd64";
  }

  if (arch === "arm64") {
    return "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-arm64";
  }

  log("Komari", `unsupported arch: ${arch}`);
  return null;
}

/* ================= 进程对象 ================= */
let xrayProc = null;
let argoProc = null;
let komariProc = null;

/* ================= Xray ================= */
function startXray() {
  const config = {
    log: { loglevel: "warning" },
    inbounds: [
      {
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
      },
      {
        port: 3003,
        listen: "127.0.0.1",
        protocol: "vmess",
        settings: {
          clients: [{ id: UUID }]
        },
        streamSettings: {
          network: "ws",
          wsSettings: { path: "/vmess-argo" }
        }
      }
    ],
    outbounds: [{ protocol: "freedom" }]
  };

  fs.writeFileSync(XRAY_CONF, JSON.stringify(config, null, 2));
  log("Xray", `config written -> ${XRAY_CONF}`);
  log("Xray", `expect listen on 127.0.0.1:${ARGO_PORT}, path=/vless-argo`);

  xrayProc = spawn(XRAY, ["-c", XRAY_CONF], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  attachProcessLogs("Xray", xrayProc);

  setTimeout(() => checkPort("127.0.0.1", ARGO_PORT, "XrayCheck"), 2000);
  setTimeout(() => checkPort("127.0.0.1", ARGO_PORT, "XrayCheck"), 5000);
  setTimeout(() => checkPort("127.0.0.1", ARGO_PORT, "XrayCheck"), 10000);

  xrayProc.on("exit", () => {
    xrayProc = null;
    log("Xray", "restart in 5s");
    setTimeout(startXray, 5000);
  });
}

/* ================= Argo 模式判断 ================= */
function isTokenLike(str) {
  return /^[A-Za-z0-9=._-]{100,400}$/.test(str || "");
}

/* ================= Argo ================= */
function startArgo() {
  if (!fs.existsSync(ARGO)) {
    log("Argo", `binary not found -> ${ARGO}`);
    return;
  }

  if (argoProc && !argoProc.killed) {
    log("Argo", "already running, skip");
    return;
  }

  if (isTokenLike(ARGO_AUTH)) {
    const env = { ...process.env, TUNNEL_TOKEN: ARGO_AUTH };

    log("Argo", `mode=token, token=${safeMask(ARGO_AUTH)}`);
    log("Argo", "command: tunnel --no-autoupdate --protocol http2 --loglevel debug run");

    argoProc = spawn(
      ARGO,
      ["tunnel", "--no-autoupdate", "--protocol", "http2", "--loglevel", "debug", "run"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } else {
    log("Argo", `mode=url, target=http://127.0.0.1:${ARGO_PORT}`);
    log("Argo", "command: tunnel --no-autoupdate --protocol http2 --loglevel debug --url http://127.0.0.1:8001");

    argoProc = spawn(
      ARGO,
      [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--loglevel",
        "debug",
        "--url",
        `http://127.0.0.1:${ARGO_PORT}`
      ],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  }

  attachProcessLogs("Argo", argoProc);

  argoProc.on("exit", () => {
    argoProc = null;
    log("Argo", "restart in 5s");
    setTimeout(startArgo, 5000);
  });
}

/* ================= Komari ================= */
function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) {
    log("Komari", "NEZHA_SERVER or NEZHA_KEY empty, skip");
    return;
  }

  if (!fs.existsSync(KOMARI)) {
    log("Komari", `binary not found -> ${KOMARI}`);
    return;
  }

  if (komariProc && !komariProc.killed) {
    log("Komari", "already running, skip");
    return;
  }

  log("Komari", `endpoint=${NEZHA_SERVER}`);
  log("Komari", `token=${safeMask(NEZHA_KEY)}`);
  log("Komari", "command: -e <endpoint> -t <token> --disable-auto-update --disable-web-ssh");

  komariProc = spawn(
    KOMARI,
    [
      "-e", NEZHA_SERVER,
      "-t", NEZHA_KEY,
      "--disable-auto-update",
      "--disable-web-ssh"
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  attachProcessLogs("Komari", komariProc);

  komariProc.on("exit", () => {
    komariProc = null;
    log("Komari", "restart in 5s");
    setTimeout(startKomari, 5000);
  });
}

/* ================= 主逻辑 ================= */
async function main() {
  log("Boot", `platform=${os.platform()} arch=${os.arch()}`);
  log("Boot", `PORT=${PORT}`);
  log("Boot", `FILE_PATH=${FILE_PATH}`);
  log("Boot", `ARGO_PORT=${ARGO_PORT}`);
  log("Boot", `UUID=${UUID}`);
  log("Boot", `CFIP=${CFIP}`);
  log("Boot", `CFPORT=${CFPORT}`);
  log("Boot", `ARGO_DOMAIN=${ARGO_DOMAIN}`);
  log("Boot", `ARGO_AUTH=${ARGO_AUTH ? safeMask(ARGO_AUTH) : "(empty)"}`);
  log("Boot", `NEZHA_SERVER=${NEZHA_SERVER || "(empty)"}`);
  log("Boot", `NEZHA_KEY=${NEZHA_KEY ? safeMask(NEZHA_KEY) : "(empty)"}`);

  const isArm = os.arch().includes("arm");

  const xrayUrl = isArm
    ? "https://arm64.ssss.nyc.mn/web"
    : "https://amd64.ssss.nyc.mn/web";

  const argoUrl = isArm
    ? "https://arm64.ssss.nyc.mn/bot"
    : "https://amd64.ssss.nyc.mn/bot";

  await download("Xray", xrayUrl, XRAY);
  await download("Argo", argoUrl, ARGO);

  if (NEZHA_SERVER && NEZHA_KEY) {
    const komariUrl = getKomariUrl();
    await download("Komari", komariUrl, KOMARI);
  }

  log("Boot", `xray exists=${fs.existsSync(XRAY)} path=${XRAY}`);
  log("Boot", `argo exists=${fs.existsSync(ARGO)} path=${ARGO}`);
  log("Boot", `komari exists=${fs.existsSync(KOMARI)} path=${KOMARI}`);

  startXray();

  // 给 Xray 一点启动时间，再启动 Argo
  setTimeout(() => {
    checkPort("127.0.0.1", ARGO_PORT, "PreArgoCheck").then(() => {
      startArgo();
    });
  }, 1500);

  setTimeout(() => {
    startKomari();
  }, 2500);
}

/* ================= HTTP ================= */
app.get("/", (_, res) => {
  res.send("Hello world!");
});

app.get("/debug", async (_, res) => {
  const tcpOk = await checkPort("127.0.0.1", ARGO_PORT, "DebugCheck");
  res.json({
    now: ts(),
    env: {
      PORT,
      FILE_PATH,
      SUB_PATH,
      ARGO_PORT,
      UUID,
      ARGO_DOMAIN,
      CFIP,
      CFPORT,
      NAME,
      hasArgoAuth: !!ARGO_AUTH,
      hasNezhaServer: !!NEZHA_SERVER,
      hasNezhaKey: !!NEZHA_KEY
    },
    files: {
      xray: fs.existsSync(XRAY),
      argo: fs.existsSync(ARGO),
      komari: fs.existsSync(KOMARI),
      xrayConf: fs.existsSync(XRAY_CONF)
    },
    pids: {
      xray: xrayProc ? xrayProc.pid : null,
      argo: argoProc ? argoProc.pid : null,
      komari: komariProc ? komariProc.pid : null
    },
    tcp8001: tcpOk
  });
});

/*
  严格保持你原始订阅逻辑：
  address = CFIP
  sni / host = ARGO_DOMAIN
*/
app.get(`/${SUB_PATH}`, (_, res) => {
  if (!ARGO_DOMAIN) {
    return res.send("ARGO_DOMAIN not set");
  }

  const nodeName = NAME || "Komari-Node";

  const vlessSub =
    `vless://${UUID}@${CFIP}:${CFPORT}` +
    `?encryption=none` +
    `&security=tls` +
    `&sni=${ARGO_DOMAIN}` +
    `&type=ws` +
    `&host=${ARGO_DOMAIN}` +
    `&path=%2Fvless-argo` +
    `#${encodeURIComponent(nodeName)}`;

  res.send(Buffer.from(vlessSub).toString("base64"));
});

/* ================= 启动 ================= */
main().catch((err) => {
  log("Boot", `fatal error: ${err.message}`);
});

app.listen(PORT, () => {
  log("HTTP", `listening on ${PORT}`);
});

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
const ARGO_PORT = 8001;

const CFIP = process.env.CFIP || "cdns.doon.eu.org";
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || "Komari-Node";

/* ================= 守护重启延时（30秒） ================= */
const RESTART_DELAY = 30000;

/* ================= 路径 ================= */
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

const XRAY = path.join(FILE_PATH, "xray_bin");
const ARGO = path.join(FILE_PATH, "argo_bin");
const KOMARI = path.join(FILE_PATH, "komari_agent");
const XRAY_CONF = path.join(FILE_PATH, "config.json");

/* ================= 极简日志 ================= */
function info(msg) {
  console.log(msg);
}

/* ================= 下载工具 ================= */
async function download(name, url, savePath) {
  if (!url) return;
  if (fs.existsSync(savePath)) return;

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
}

/* ================= Komari 下载地址 ================= */
function getKomariUrl() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform !== "linux") return null;

  if (arch === "x64") {
    return "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-amd64";
  }

  if (arch === "arm64") {
    return "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-arm64";
  }

  return null;
}

/* ================= TCP 检查（保留 /debug 用） ================= */
function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(2500);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

/* ================= 进程对象 ================= */
let xrayProc = null;
let argoProc = null;
let komariProc = null;

/* 防止 error/exit 同时触发导致重复重启 */
let xrayRestartTimer = null;
let argoRestartTimer = null;
let komariRestartTimer = null;

function scheduleRestart(type, fn, withLog = false, detail = "") {
  if (type === "xray") {
    if (xrayRestartTimer) return;
    if (withLog) info(detail || `[Xray] restart in 30s`);
    xrayRestartTimer = setTimeout(() => {
      xrayRestartTimer = null;
      fn();
    }, RESTART_DELAY);
    return;
  }

  if (type === "argo") {
    if (argoRestartTimer) return;
    if (withLog) info(detail || `[Argo] restart in 30s`);
    argoRestartTimer = setTimeout(() => {
      argoRestartTimer = null;
      fn();
    }, RESTART_DELAY);
    return;
  }

  if (type === "komari") {
    if (komariRestartTimer) return;
    if (withLog) info(detail || `[Komari] restart in 30s`);
    komariRestartTimer = setTimeout(() => {
      komariRestartTimer = null;
      fn();
    }, RESTART_DELAY);
  }
}

/* ================= Xray（静默守护） ================= */
function startXray() {
  const config = {
    log: { loglevel: "none" },
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

  xrayProc = spawn(XRAY, ["-c", XRAY_CONF], {
    stdio: ["ignore", "ignore", "ignore"]
  });

  xrayProc.on("exit", () => {
    xrayProc = null;
    scheduleRestart("xray", startXray, false);
  });

  xrayProc.on("error", () => {
    xrayProc = null;
    scheduleRestart("xray", startXray, false);
  });
}

/* ================= Argo 模式判断 ================= */
function isTokenLike(str) {
  return /^[A-Za-z0-9=._-]{100,400}$/.test(str || "");
}

/* ================= Argo（只有它挂了才提示） ================= */
function startArgo() {
  if (!fs.existsSync(ARGO)) return;
  if (argoProc && !argoProc.killed) return;

  if (isTokenLike(ARGO_AUTH)) {
    const env = { ...process.env, TUNNEL_TOKEN: ARGO_AUTH };

    argoProc = spawn(
      ARGO,
      [
        "tunnel",
        "--no-autoupdate",
        "--protocol", "http2",
        "--loglevel", "error",
        "run"
      ],
      {
        env,
        stdio: ["ignore", "ignore", "ignore"]
      }
    );
  } else {
    argoProc = spawn(
      ARGO,
      [
        "tunnel",
        "--no-autoupdate",
        "--protocol", "http2",
        "--loglevel", "error",
        "--url", `http://127.0.0.1:${ARGO_PORT}`
      ],
      {
        stdio: ["ignore", "ignore", "ignore"]
      }
    );
  }

  argoProc.on("exit", (code, signal) => {
    argoProc = null;
    scheduleRestart(
      "argo",
      startArgo,
      true,
      `[Argo] exited code=${code} signal=${signal}, restart in 30s`
    );
  });

  argoProc.on("error", (err) => {
    argoProc = null;
    scheduleRestart(
      "argo",
      startArgo,
      true,
      `[Argo] error: ${err.message}, restart in 30s`
    );
  });
}

/* ================= Komari（静默守护） ================= */
function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) return;
  if (!fs.existsSync(KOMARI)) return;
  if (komariProc && !komariProc.killed) return;

  komariProc = spawn(
    KOMARI,
    [
      "-e", NEZHA_SERVER,
      "-t", NEZHA_KEY,
      "--disable-auto-update",
      "--disable-web-ssh"
    ],
    {
      stdio: ["ignore", "ignore", "ignore"]
    }
  );

  komariProc.on("exit", () => {
    komariProc = null;
    scheduleRestart("komari", startKomari, false);
  });

  komariProc.on("error", () => {
    komariProc = null;
    scheduleRestart("komari", startKomari, false);
  });
}

/* ================= 主逻辑 ================= */
async function main() {
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

  startXray();

  /* 给 Xray 一点启动时间，再启动 Argo */
  setTimeout(() => {
    startArgo();
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
  const tcpOk = await checkPort("127.0.0.1", ARGO_PORT);

  res.json({
    ok: true,
    tcp8001: tcpOk,
    pids: {
      xray: xrayProc ? xrayProc.pid : null,
      argo: argoProc ? argoProc.pid : null,
      komari: komariProc ? komariProc.pid : null
    },
    files: {
      xray: fs.existsSync(XRAY),
      argo: fs.existsSync(ARGO),
      komari: fs.existsSync(KOMARI),
      config: fs.existsSync(XRAY_CONF)
    }
  });
});

/*
  保持你原始订阅逻辑：
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
  info(`[Boot] fatal error: ${err.message}`);
});

app.listen(PORT, () => {
  info("Service started");
});
``

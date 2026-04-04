const os = require("os");
const fs = require("fs");
const path = require("path");
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
async function download(url, savePath) {
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

/* ================= 进程对象 ================= */
let xrayProc = null;
let argoProc = null;
let komariProc = null;

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

  fs.writeFileSync(XRAY_CONF, JSON.stringify(config));

  xrayProc = spawn(XRAY, ["-c", XRAY_CONF], {
    stdio: ["ignore", "ignore", "ignore"]
  });

  xrayProc.on("exit", () => {
    xrayProc = null;
    setTimeout(startXray, RESTART_DELAY);
  });

  xrayProc.on("error", () => {
    xrayProc = null;
    setTimeout(startXray, RESTART_DELAY);
  });
}

/* ================= Argo 模式判断 ================= */
function isTokenLike(str) {
  return /^[A-Za-z0-9=._-]{100,400}$/.test(str || "");
}

/* ================= Argo（只有它挂了才打印） ================= */
/*
  这里恢复成“调试版里已经验证能启动”的 TUNNEL_TOKEN 环境变量方式。
  这样更接近你之前实际跑起来的行为，同时仍然不经过 shell。
*/
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
    info(`[Argo] exited code=${code} signal=${signal}, restart in 30s`);
    setTimeout(startArgo, RESTART_DELAY);
  });

  argoProc.on("error", (err) => {
    argoProc = null;
    info(`[Argo] error: ${err.message}, restart in 30s`);
    setTimeout(startArgo, RESTART_DELAY);
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
    setTimeout(startKomari, RESTART_DELAY);
  });

  komariProc.on("error", () => {
    komariProc = null;
    setTimeout(startKomari, RESTART_DELAY);
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

  await download(xrayUrl, XRAY);
  await download(argoUrl, ARGO);

  if (NEZHA_SERVER && NEZHA_KEY) {
    const komariUrl = getKomariUrl();
    await download(komariUrl, KOMARI);
  }

  startXray();

  /* 给 Xray 一点启动时间 */
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

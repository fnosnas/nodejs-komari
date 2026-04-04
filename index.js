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
const ARGO_PORT = 8001; // 与你原始代码一致

const CFIP = process.env.CFIP || "cdns.doon.eu.org";
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || "world";

/* ================= 路径 ================= */
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

const XRAY = path.join(FILE_PATH, "xray_bin");
const ARGO = path.join(FILE_PATH, "argo_bin");
const KOMARI = path.join(FILE_PATH, "komari_agent");
const XRAY_CONF = path.join(FILE_PATH, "config.json");

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

/* ================= 进程守护 ================= */
let xrayProc = null;
let argoProc = null;
let komariProc = null;

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
    setTimeout(startXray, 5000);
  });
}

function isTokenLike(str) {
  return /^[A-Za-z0-9=._-]{100,400}$/.test(str || "");
}

/* 
  这里严格保留你原始代码的逻辑：
  1) 有效 ARGO_AUTH => 托管 Tunnel / token 模式（需要面板正常）
  2) 否则才走 --url 模式
*/
function startArgo() {
  if (!fs.existsSync(ARGO)) return;

  // 避免重复启动
  if (argoProc && !argoProc.killed) return;

  if (isTokenLike(ARGO_AUTH)) {
    const env = { ...process.env, TUNNEL_TOKEN: ARGO_AUTH };

    argoProc = spawn(
      ARGO,
      ["tunnel", "--no-autoupdate", "--protocol", "http2", "run"],
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
        "--protocol",
        "http2",
        "--url",
        `http://127.0.0.1:${ARGO_PORT}`
      ],
      {
        stdio: ["ignore", "ignore", "ignore"]
      }
    );
  }

  argoProc.on("exit", () => {
    argoProc = null;
    setTimeout(startArgo, 5000);
  });
}

function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) return;
  if (!fs.existsSync(KOMARI)) return;

  // 避免重复启动
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
    setTimeout(startKomari, 5000);
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
  startArgo();
  startKomari();
}

/* ================= HTTP ================= */
app.get("/", (_, res) => {
  res.send("Hello world!");
});

/* 
  这里也严格保持你原始订阅逻辑：
  address = CFIP（优选域名）
  sni/host = ARGO_DOMAIN
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
main().catch(() => {});

app.listen(PORT, () => {
  console.log("Service started");
});
``

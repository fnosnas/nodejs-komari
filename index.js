const os = require("os");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const { spawn } = require("child_process");

const app = express();

/* ================= 基础配置 ================= */
const PORT = process.env.PORT || 3000;
const FILE_PATH = "./tmp";

const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913";

/* ✅ 关键：统一的 Argo / Xray 端口 */
const ARGO_PORT = 8001;

const NEZHA_SERVER = process.env.NEZHA_SERVER || "";
const NEZHA_KEY = process.env.NEZHA_KEY || "";

const ARGO_AUTH = process.env.ARGO_AUTH || "";
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";

const CFIP = "cdns.doon.eu.org";
const CFPORT = 443;
const NAME = "Node";

/* ================= 路径 ================= */
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const XRAY = path.join(FILE_PATH, "xray");
const ARGO = path.join(FILE_PATH, "argo");
const KOMARI = path.join(FILE_PATH, "komari");
const XRAY_CONF = path.join(FILE_PATH, "config.json");

/* ================= 下载工具 ================= */
async function download(url, file) {
  if (fs.existsSync(file)) return;
  const res = await axios({ url, responseType: "stream", timeout: 60000 });
  await new Promise(resolve =>
    res.data.pipe(fs.createWriteStream(file)).on("finish", resolve)
  );
  fs.chmodSync(file, 0o755);
}

/* ================= Xray（✅ 明确监听 ARGO_PORT） ================= */
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
          security: "none",
          wsSettings: {
            path: "/vless-argo"
          }
        }
      }
    ],
    outbounds: [{ protocol: "freedom" }]
  };

  fs.writeFileSync(XRAY_CONF, JSON.stringify(config));
  spawn(XRAY, ["-c", XRAY_CONF], { stdio: "ignore" });
}

/* ================= Argo（✅ 明确转发到 ARGO_PORT） ================= */
function startArgo() {
  const env = { ...process.env };
  env.TUNNEL_TOKEN = ARGO_AUTH;

  spawn(
    ARGO,
    [
      "tunnel",
      "--no-autoupdate",
      "--loglevel", "error",
      "run"
    ],
    { env, stdio: "ignore" }
  );
}

/* ================= Komari（自动拉起） ================= */
function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) return;

  spawn(
    KOMARI,
    [
      "-e", NEZHA_SERVER,
      "-t", NEZHA_KEY,
      "--disable-auto-update",
      "--disable-web-ssh"
    ],
    { stdio: "ignore" }
  );
}

/* ================= 主流程 ================= */
async function main() {
  const isArm = os.arch().includes("arm");

  await download(
    isArm
      ? "https://arm64.ssss.nyc.mn/web"
      : "https://amd64.ssss.nyc.mn/web",
    XRAY
  );
  await download(
    isArm
      ? "https://arm64.ssss.nyc.mn/bot"
      : "https://amd64.ssss.nyc.mn/bot",
    ARGO
  );
  await download(
    isArm
      ? "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-arm64"
      : "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-amd64",
    KOMARI
  );

  startXray();
  startArgo();
  startKomari();
}

/* ================= HTTP & 订阅 ================= */
app.get("/", (_, res) => res.send("OK"));

app.get("/sub", (_, res) => {
  const vless =
    `vless://${UUID}@${CFIP}:${CFPORT}` +
    `?encryption=none&security=tls` +
    `&sni=${ARGO_DOMAIN}` +
    `&type=ws` +
    `&host=${ARGO_DOMAIN}` +
    `&path=%2Fvless-argo` +
    `#${NAME}`;

  res.send(Buffer.from(vless).toString("base64"));
});

/* ================= 启动 ================= */
main();
app.listen(PORT, () => {
  console.log("Service started");
});
``

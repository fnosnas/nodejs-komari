const os = require("os");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const { spawn } = require("child_process");

const app = express();

/* ========= 基础配置 ========= */
const PORT = process.env.PORT || 3000;
const FILE_PATH = "./tmp";
const SUB_PATH = process.env.SUB_PATH || "sub";
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913";

const NEZHA_SERVER = process.env.NEZHA_SERVER || "";
const NEZHA_KEY = process.env.NEZHA_KEY || "";

const ARGO_AUTH = process.env.ARGO_AUTH || "";
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";

const CFIP = process.env.CFIP || "cdns.doon.eu.org";
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || "Node";

/* ========= 路径 ========= */
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const XRAY = path.join(FILE_PATH, "xray");
const ARGO = path.join(FILE_PATH, "argo");
const KOMARI = path.join(FILE_PATH, "komari");

/* ========= 下载工具 ========= */
async function download(url, file) {
  if (fs.existsSync(file)) return;
  console.log(`[Download] ${url}`);
  const res = await axios({ url, responseType: "stream", timeout: 60000 });
  await new Promise(resolve =>
    res.data.pipe(fs.createWriteStream(file)).on("finish", resolve)
  );
  fs.chmodSync(file, 0o755);
}

/* ========= Komari（自动拉起 + 低资源 + 静默） ========= */
function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) return;

  const p = spawn(
    KOMARI,
    [
      "-e", NEZHA_SERVER,
      "-t", NEZHA_KEY,
      "--disable-update",
      "--disable-plugin"
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );

  p.on("exit", () => {
    setTimeout(startKomari, 5000);
  });
}

/* ========= Argo（完全静默 + 自动拉起） ========= */
function startArgo() {
  const env = { ...process.env };
  if (ARGO_AUTH) env.TUNNEL_TOKEN = ARGO_AUTH;

  const p = spawn(
    ARGO,
    [
      "tunnel",
      "--no-autoupdate",
      "--loglevel", "error",
      "run"
    ],
    { stdio: ["ignore", "ignore", "ignore"], env }
  );

  p.on("exit", () => {
    setTimeout(startArgo, 5000);
  });
}

/* ========= 主逻辑 ========= */
async function main() {
  const isArm = os.arch().includes("arm");

  await download(
    isArm ? "https://arm64.ssss.nyc.mn/web" : "https://amd64.ssss.nyc.mn/web",
    XRAY
  );
  await download(
    isArm ? "https://arm64.ssss.nyc.mn/bot" : "https://amd64.ssss.nyc.mn/bot",
    ARGO
  );
  await download(
    isArm
      ? "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-arm64"
      : "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-amd64",
    KOMARI
  );

  startArgo();
  startKomari();
}

/* ========= HTTP ========= */
app.get("/", (_, res) => res.send("OK"));

app.get(`/${SUB_PATH}`, (_, res) => {
  if (!ARGO_DOMAIN) return res.send("ARGO_DOMAIN not set");
  const vless = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless-argo#${NAME}`;
  res.send(Buffer.from(vless).toString("base64"));
});

/* ========= 启动 ========= */
main();
app.listen(PORT, () => {
  console.log("Service started");
});

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

/* ========= 下载 ========= */
async function download(url, file) {
  if (fs.existsSync(file)) return;
  const res = await axios({ url, responseType: "stream", timeout: 60000 });
  await new Promise(resolve =>
    res.data.pipe(fs.createWriteStream(file)).on("finish", resolve)
  );
  fs.chmodSync(file, 0o755);
}

/* ========= Komari（低资源模式） ========= */
function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) return;

  spawn(
    KOMARI,
    [
      "-e", NEZHA_SERVER,
      "-t", NEZHA_KEY,
      "--disable-update",
      "--disable-plugin"
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
}

/* ========= Argo（最低开销模式） ========= */
function startArgo() {
  const env = { ...process.env };
  if (ARGO_AUTH) env.TUNNEL_TOKEN = ARGO_AUTH;

  spawn(
    ARGO,
    [
      "tunnel",
      "--no-autoupdate",
      "--metrics", "127.0.0.1:0",
      "run"
    ],
    { stdio: ["ignore", "ignore", "inherit"], env }
  );
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

  spawn(XRAY, ["-test"], { stdio: "ignore" });

  startArgo();
  startKomari();
}

app.get("/", (_, res) => res.send("OK"));

main();
app.listen(PORT, () => console.log(`Listening ${PORT}`));

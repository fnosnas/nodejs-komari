const os = require("os");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const { spawn } = require("child_process");

const app = express();

/* ================= 基础配置 ================= */
const PORT = process.env.PORT || 3000;
const FILE_PATH = process.env.FILE_PATH || "./tmp";
const SUB_PATH = process.env.SUB_PATH || "sub";
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913";

const NEZHA_SERVER = process.env.NEZHA_SERVER || "";
const NEZHA_KEY = process.env.NEZHA_KEY || "";

const ARGO_AUTH = process.env.ARGO_AUTH || "";
const ARGO_PORT = 8001;

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";
const CFIP = process.env.CFIP || "cdns.doon.eu.org";
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || "Komari-Node";

/* ================= 路径 ================= */
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const XRAY = path.join(FILE_PATH, "xray");
const ARGO = path.join(FILE_PATH, "argo");
const KOMARI = path.join(FILE_PATH, "komari");

/* ================= 下载工具 ================= */
async function download(url, savePath) {
  if (fs.existsSync(savePath)) return;
  console.log(`[Download] ${url}`);
  const res = await axios({ url, responseType: "stream", timeout: 60000 });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(savePath);
    res.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
  fs.chmodSync(savePath, 0o755);
}

/* ================= Komari URL ================= */
function komariUrl() {
  return os.arch().includes("arm")
    ? "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-arm64"
    : "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-amd64";
}

/* ================= Komari 守护启动 ================= */
function startKomari() {
  if (!NEZHA_SERVER || !NEZHA_KEY) {
    console.log("[Komari] env not set, skip");
    return;
  }
  if (!fs.existsSync(KOMARI)) return;

  console.log("[Komari] starting...");
  const p = spawn(KOMARI, ["-e", NEZHA_SERVER, "-t", NEZHA_KEY], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  p.on("exit", (code, signal) => {
    console.error(`[Komari] exited code=${code} signal=${signal}`);
    console.log("[Komari] restart in 5s");
    setTimeout(startKomari, 5000);
  });
}

/* ================= Argo 启动（已修复 shell 错误） ================= */
function startArgo() {
  console.log("[Argo] starting...");

  const env = { ...process.env };

  // ✅ 关键修复：Token 走环境变量，避免 shell 解析
  if (ARGO_AUTH) {
    env.TUNNEL_TOKEN = ARGO_AUTH;
  }

  const args = ["tunnel", "--no-autoupdate", "run"];

  const p = spawn(ARGO, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env,
  });

  p.on("exit", (code, signal) => {
    console.error(`[Argo] exited code=${code} signal=${signal}`);
  });
}

/* ================= 主逻辑 ================= */
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
  await download(komariUrl(), KOMARI);

  /* 写 xray 配置 */
  fs.writeFileSync(
    path.join(FILE_PATH, "config.json"),
    JSON.stringify({
      log: { loglevel: "none" },
      inbounds: [
        {
          port: ARGO_PORT,
          listen: "127.0.0.1",
          protocol: "vless",
          settings: { clients: [{ id: UUID }], decryption: "none" },
          streamSettings: {
            network: "ws",
            wsSettings: { path: "/vless-argo" },
          },
        },
      ],
      outbounds: [{ protocol: "freedom" }],
    })
  );

  spawn(XRAY, ["-c", `${FILE_PATH}/config.json`], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  startArgo();
  startKomari();
}

/* ================= HTTP ================= */
app.get("/", (_, res) => res.send("Hello world"));

app.get(`/${SUB_PATH}`, (_, res) => {
  const vless = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless-argo#${NAME}`;
  res.send(Buffer.from(vless).toString("base64"));
});

main();
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

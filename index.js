const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require("path");
const os = require('os');

try {
    require.resolve("express");
    require.resolve("axios");
} catch {
    execSync('npm install --no-save', { stdio: 'inherit' });
}

const express = require("express");
const axios = require("axios");
const app = express();

const PORT = process.env.PORT || 3000;

const FILE_PATH = './tmp';
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';

/* ✅ Komari 新版参数 */
const KOMARI_ENDPOINT = process.env.KOMARI_ENDPOINT || 'https://komari.afnos86.xx.kg';
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || '';

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';

const ARGO_PORT = 8001;
const CFIP = 'wto.org';
const CFPORT = 443;

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const xrayPath = path.join(FILE_PATH, "xray");
const argoPath = path.join(FILE_PATH, "argo");
const komariPath = path.join(FILE_PATH, "komari");
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

/* ✅ 自动识别 Komari 版本 */
function startKomari() {

    try {
        const help = execSync(`${komariPath} --help`).toString();

        if (help.includes("-e")) {
            daemon("Komari", komariPath, [
                "-e", KOMARI_ENDPOINT,
                "-t", KOMARI_TOKEN
            ]);

        } else {
            const host = KOMARI_ENDPOINT.replace(/^https?:\/\//, '');

            daemon("Komari", komariPath, [
                "-s", host,
                "-p", KOMARI_TOKEN,
                "--tls"
            ]);
        }

    } catch (e) {
        daemon("Komari", komariPath, [
            "-e", KOMARI_ENDPOINT,
            "-t", KOMARI_TOKEN
        ]);
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

    const komariUrl = isArm
        ? "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-arm64"
        : "https://github.com/komari-monitor/komari-agent/releases/download/1.1.80/komari-agent-linux-amd64";

    await download("Xray", xrayUrl, xrayPath);
    await download("Argo", argoUrl, argoPath);
    await download("Komari", komariUrl, komariPath);

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

    startKomari();

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
app.get("/", (_, res) => res.send("running"));

app.get("/sub", (_, res) => {
    const sub = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless-argo#Komari`;
    res.send(Buffer.from(sub).toString('base64'));
});

app.listen(PORT, () => {
    main();
});

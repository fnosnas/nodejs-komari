const { execSync } = require('child_process');
const fs = require('fs');
const path = require("path");
const os = require('os');

// --- 1. 自动依赖安装检查 (核心修复) ---
try {
    require.resolve("express");
    require.resolve("axios");
} catch (e) {
    console.log("检测到缺少必要组件，正在尝试自动安装...");
    try {
        // 使用 --no-save 避免修改 package.json，提高在受限环境下的成功率
        execSync('npm install --no-save', { stdio: 'inherit' });
        console.log("安装完成，正在继续启动...");
    } catch (installError) {
        console.error("自动安装失败，请手动在 Console 输入 npm install:", installError.message);
        process.exit(1);
    }
}

// --- 2. 加载依赖 ---
const express = require("express");
const app = express();
const axios = require("axios");
const { spawn } = require('child_process');

// --- 3. 基础配置 ---
const PORT = process.env.SERVER_PORT || process.env.PORT || 12827;
const FILE_PATH = process.env.FILE_PATH || './data';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';

// --- Komari 变量 ---
const NEZHA_SERVER = process.env.NEZHA_SERVER || 'https://komari.afnos86.xx.kg'; 
const NEZHA_KEY = process.env.NEZHA_KEY || '';       

// --- Argo 变量 ---
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = 8001; 
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || '';

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const npmPath = path.join(FILE_PATH, "komari_agent");
const webPath = path.join(FILE_PATH, "xray_bin");
const botPath = path.join(FILE_PATH, "argo_bin");
const configPath = path.join(FILE_PATH, 'config.json');

app.get("/", (req, res) => res.send("Hello world! Guard is active (Native Mode)."));

async function getKomariUrl(arch) {
    try {
        const res = await axios.get('https://api.github.com/repos/komari-monitor/komari-agent/releases/latest', { timeout: 10000 });
        const asset = res.data.assets.find(a => a.name.toLowerCase().includes('linux') && a.name.toLowerCase().includes(arch));
        return asset ? asset.browser_download_url : null;
    } catch (e) { return `https://github.com/komari-monitor/komari-agent/releases/download/v1.1.40/komari-agent-linux-${arch}`; }
}

async function download(name, url, savePath) {
    if (fs.existsSync(savePath)) return;
    try {
        const writer = fs.createWriteStream(savePath);
        const response = await axios({ method: 'get', url: url, responseType: 'stream', timeout: 60000 });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => { fs.chmodSync(savePath, 0o775); console.log(`[OK] ${name} downloaded.`); resolve(); });
            writer.on('error', reject);
        });
    } catch (e) { console.error(`[Error] ${name} download failed: ${e.message}`); }
}

// 守护启动函数
function startProcess(name, cmd, args) {
    console.log(`[Start] Launching ${name}...`);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });

    child.on('exit', (code) => {
        console.log(`[Guard] ${name} exited with code ${code}. Restarting in 5s...`);
        setTimeout(() => startProcess(name, cmd, args), 5000);
    });

    child.unref();
}

async function main() {
    const isArm = os.arch().includes('arm');
    const arch = isArm ? 'arm64' : 'amd64';
    const xrayUrl = isArm ? "https://arm64.ssss.nyc.mn/web" : "https://amd64.ssss.nyc.mn/web";
    const argoUrl = isArm ? "https://arm64.ssss.nyc.mn/bot" : "https://amd64.ssss.nyc.mn/bot";
    
    await download('Xray', xrayUrl, webPath);
    await download('Argo', argoUrl, botPath);
    if (NEZHA_SERVER && NEZHA_KEY) {
        const komariUrl = await getKomariUrl(arch);
        await download('Komari', komariUrl, npmPath);
    }

    // 1. 启动 Xray
    const xrayConfig = {
        log: { loglevel: 'none' },
        inbounds: [{
            port: ARGO_PORT, listen: "127.0.0.1", protocol: "vless",
            settings: { clients: [{ id: UUID }], decryption: "none" },
            streamSettings: { network: "ws", wsSettings: { path: "/vless-argo" } }
        }],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(configPath, JSON.stringify(xrayConfig));
    startProcess('Xray', webPath, ['-c', configPath]);

    // 2. 启动 Komari
    if (fs.existsSync(npmPath) && NEZHA_SERVER && NEZHA_KEY) {
        startProcess('Komari', npmPath, ['-e', NEZHA_SERVER, '-t', NEZHA_KEY]);
    }

    // 3. 启动 Argo
    let argoArgs = ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/) 
        ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_AUTH]
        : ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${ARGO_PORT}`];
    startProcess('Argo', botPath, argoArgs);

    // 订阅链接
    if (ARGO_DOMAIN) {
        const nodeName = NAME || 'Komari-Node';
        const vlessSub = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless-argo#${nodeName}`;
        app.get(`/${SUB_PATH}`, (req, res) => res.send(Buffer.from(vlessSub).toString('base64')));
        console.log(`[Success] Node ready on ${ARGO_DOMAIN}`);
    }
}

main().catch(e => console.error(e));
app.listen(PORT, () => console.log(`Express active on port ${PORT}`));

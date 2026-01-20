const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// --- 基础配置 ---
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const FILE_PATH = process.env.FILE_PATH || './tmp';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';

// --- Komari 变量 ---
const NEZHA_SERVER = process.env.NEZHA_SERVER || ''; 
const NEZHA_KEY = process.env.NEZHA_KEY || '';       

// --- Argo 变量 ---
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT || 8001;
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || '';

// 目录初始化
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const npmName = "komari_agent";
const webName = "xray_bin";
const botName = "argo_bin";
const npmPath = path.join(FILE_PATH, npmName);
const webPath = path.join(FILE_PATH, webName);
const botPath = path.join(FILE_PATH, botName);
const bootLogPath = path.join(FILE_PATH, 'boot.log');

// 修正：访问根目录显示 Hello world!
app.get("/", (req, res) => res.send("Hello world!"));

async function getKomariUrl(arch) {
    try {
        const res = await axios.get('https://api.github.com/repos/komari-monitor/komari-agent/releases/latest', { timeout: 10000 });
        const asset = res.data.assets.find(a => a.name.toLowerCase().includes('linux') && a.name.toLowerCase().includes(arch) && !a.name.endsWith('.sha256'));
        return asset ? asset.browser_download_url : null;
    } catch (e) { return `https://github.com/komari-monitor/komari-agent/releases/download/v1.1.40/komari-agent-linux-${arch}`; }
}

async function download(name, url, savePath) {
    if (!url) return;
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

    // 启动 Xray：确保监听 ARGO_PORT 且回落到 3000 端口（显示 Hello world）
    if (fs.existsSync(webPath)) {
        const config = {
            log: { loglevel: 'none' },
            inbounds: [{
                port: ARGO_PORT, protocol: 'vless', 
                settings: { clients: [{ id: UUID }], decryption: 'none', fallbacks: [{ dest: PORT }] },
                streamSettings: { network: 'tcp' }
            },
            { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }] }, streamSettings: { network: "ws", wsSettings: { path: "/vless-argo" } } },
            { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } } },
            { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", wsSettings: { path: "/trojan-argo" } } }],
            outbounds: [{ protocol: "freedom" }]
        };
        fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config));
        exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);
    }

    // 启动 Komari
    if (fs.existsSync(npmPath) && NEZHA_SERVER && NEZHA_KEY) {
        exec(`nohup ${npmPath} -e ${NEZHA_SERVER} -t ${NEZHA_KEY} >/dev/null 2>&1 &`);
    }

    // 启动 Argo：流量打向 Xray 的入站端口 ARGO_PORT (8001)
    if (fs.existsSync(botPath)) {
        let argoArgs = ARGO_AUTH.length > 120 
            ? `tunnel --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`
            : `tunnel --no-autoupdate --protocol http2 --logfile ${bootLogPath} --url http://localhost:${ARGO_PORT}`;
        exec(`nohup ${botPath} ${argoArgs} >/dev/null 2>&1 &`);
    }

    // 订阅生成
    setTimeout(() => {
        let domain = ARGO_DOMAIN;
        if (!domain && fs.existsSync(bootLogPath)) {
            const log = fs.readFileSync(bootLogPath, 'utf-8');
            const match = log.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
            if (match) domain = match[1];
        }
        if (domain) {
            const nodeName = NAME || 'Komari-Node';
            const vlessSub = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${domain}&type=ws&host=${domain}&path=%2Fvless-argo#${nodeName}`;
            const vmessSub = Buffer.from(JSON.stringify({ v: '2', ps: nodeName, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'none', net: 'ws', type: 'none', host: domain, path: '/vmess-argo', tls: 'tls', sni: domain })).toString('base64');
            const trojanSub = `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${domain}&type=ws&host=${domain}&path=%2Ftrojan-argo#${nodeName}`;
            
            const fullSub = `${vlessSub}\n\nvmess://${vmessSub}\n\n${trojanSub}`;
            app.get(`/${SUB_PATH}`, (req, res) => res.send(Buffer.from(fullSub).toString('base64')));
            console.log(`[Success] Sub link: /${SUB_PATH}`);
        }
    }, 15000);
}

main().catch(e => console.error(e));
app.listen(PORT, () => console.log(`Http server on port ${PORT}`));

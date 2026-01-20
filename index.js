const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// 环境变量配置
const UPLOAD_URL = process.env.UPLOAD_URL || '';      
const PROJECT_URL = process.env.PROJECT_URL || '';    
const AUTO_ACCESS = process.env.AUTO_ACCESS || false; 
const FILE_PATH = process.env.FILE_PATH || './tmp';   
const SUB_PATH = process.env.SUB_PATH || 'sub';       
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;        
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913'; 

// 填入 Komari 信息 (借用哪吒变量名)
// NEZHA_SERVER 填 https://komari.afnos86.xx.kg
// NEZHA_KEY 填 A2NPXztWfgxCQP9B5l9toA
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';        
const NEZHA_KEY = process.env.NEZHA_KEY || '';              

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';          
const ARGO_AUTH = process.env.ARGO_AUTH || '';              
const ARGO_PORT = process.env.ARGO_PORT || 8001;            
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';          
const CFPORT = process.env.CFPORT || 443;                    
const NAME = process.env.NAME || '';                        

// 创建运行文件夹
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

// 生成随机文件名
function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

const npmName = generateRandomName();
const webName = generateRandomName();
const botName = generateRandomName();
let npmPath = path.join(FILE_PATH, npmName);
let webPath = path.join(FILE_PATH, webName);
let botPath = path.join(FILE_PATH, botName);
let subPath = path.join(FILE_PATH, 'sub.txt');
let bootLogPath = path.join(FILE_PATH, 'boot.log');

// 根路由
app.get("/", (req, res) => res.send("Hello world!"));

// 生成 Xray 配置
async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      { port: ARGO_PORT, protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
      { port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [ { protocol: "freedom", tag: "direct" } ]
  };
  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
}

function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function downloadFile(fileName, fileUrl, callback) {
  const writer = fs.createWriteStream(fileName);
  axios({ method: 'get', url: fileUrl, responseType: 'stream' })
    .then(response => {
      response.data.pipe(writer);
      writer.on('finish', () => {
        console.log(`Download ${path.basename(fileName)} successfully`);
        callback(null, fileName);
      });
      writer.on('error', err => callback(err.message));
    })
    .catch(err => callback(err.message));
}

async function downloadFilesAndRun() {  
  const architecture = getSystemArchitecture();
  
  // 构建下载列表
  let filesToDownload = architecture === 'arm' 
    ? [ { fileName: webPath, fileUrl: "https://arm64.ssss.nyc.mn/web" }, { fileName: botPath, fileUrl: "https://arm64.ssss.nyc.mn/bot" } ]
    : [ { fileName: webPath, fileUrl: "https://amd64.ssss.nyc.mn/web" }, { fileName: botPath, fileUrl: "https://amd64.ssss.nyc.mn/bot" } ];

  if (NEZHA_SERVER && NEZHA_KEY) {
    const komariUrl = architecture === 'arm'
      ? "https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-linux-arm64"
      : "https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-linux-amd64";
    filesToDownload.unshift({ fileName: npmPath, fileUrl: komariUrl });
  }

  // 执行下载
  for (const file of filesToDownload) {
    await new Promise((resolve, reject) => {
      downloadFile(file.fileName, file.fileUrl, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    if (fs.existsSync(file.fileName)) fs.chmodSync(file.fileName, 0o775);
  }

  // 运行 Komari (使用 -e 和 -t 参数)
  if (NEZHA_SERVER && NEZHA_KEY) {
    const komariCmd = `nohup ${npmPath} -e ${NEZHA_SERVER} -t ${NEZHA_KEY} >/dev/null 2>&1 &`;
    try {
      await exec(komariCmd);
      console.log(`Komari Agent is running`);
    } catch (e) { console.error(`Komari error: ${e}`); }
  }

  // 运行 Xray
  try {
    await exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);
    console.log(`Xray is running`);
  } catch (e) { console.error(`Xray error: ${e}`); }

  // 运行 Argo
  if (fs.existsSync(botPath)) {
    let args = ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/) 
      ? `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`
      : `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${FILE_PATH}/boot.log --url http://localhost:${ARGO_PORT}`;
    
    try {
      await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
      console.log(`Argo is running`);
    } catch (e) { console.error(`Argo error: ${e}`); }
  }
}

async function extractDomains() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    await generateLinks(ARGO_DOMAIN);
  } else {
    try {
      await new Promise(r => setTimeout(r, 5000));
      if (!fs.existsSync(bootLogPath)) return;
      const content = fs.readFileSync(bootLogPath, 'utf-8');
      const match = content.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
      if (match) await generateLinks(match[1]);
    } catch (e) {}
  }
}

async function generateLinks(argoDomain) {
  const nodeName = NAME || 'Komari-Node';
  const VMESS = { v: '2', ps: nodeName, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'none', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox'};
  const subTxt = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}\n\nvmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}\n\ntrojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}`;
  
  fs.writeFileSync(subPath, Buffer.from(subTxt).toString('base64'));
  app.get(`/${SUB_PATH}`, (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(Buffer.from(subTxt).toString('base64'));
  });
  console.log("Sub links generated.");
}

function cleanFiles() {
  setTimeout(() => {
    const files = [bootLogPath, path.join(FILE_PATH, 'config.json'), webPath, botPath, npmPath];
    files.forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
    console.log('Temporary files cleaned.');
  }, 90000);
}

async function startserver() {
  await generateConfig();
  await downloadFilesAndRun();
  await extractDomains();
  cleanFiles();
}

startserver().catch(console.error);
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

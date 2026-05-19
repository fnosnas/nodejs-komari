# nodejs-komari

## 📋 环境变量

| 变量名 | 是否必须 | 默认值 | 说明 |
|--------|----------|--------|------|
| UPLOAD_URL | 否 | - | 订阅上传地址 |
| PROJECT_URL | 否 | https://www.google.com | 项目分配的域名 |
| AUTO_ACCESS | 否 | false | 是否开启自动访问保活 |
| PORT | 否 | 3000 | HTTP服务监听端口 |
| ARGO_PORT | 否 | 8001 | Argo隧道端口 |
| UUID | 否 | 89c13786-25aa-4520-b2e7-12cd60fb5202 | 用户UUID |
| NEZHA_SERVER | 否 | - | komari域名 |
| NEZHA_PORT | 否 | - | komari端口 |
| NEZHA_KEY | 否 | - | komari密钥 |
| ARGO_DOMAIN | 否 | - | Argo固定隧道域名 |
| ARGO_AUTH | 否 | - | Argo固定隧道密钥 |
| CFIP | 否 | www.visa.com.tw | 节点优选域名或IP |
| CFPORT | 否 | 443 | 节点端口 |
| NAME | 否 | Vls | 节点名称前缀 |
| FILE_PATH | 否 | ./tmp | 运行目录 |
| SUB_PATH | 否 | sub | 订阅路径 |

容器平台启动命令直接填：
```
node index.js
```
docker run 一条命令搞定：
```
docker run -d \
  --name komari \
  --restart always \
  -e NEZHA_SERVER="你的服务器地址" \
  -e NEZHA_KEY="你的Key" \
  -e ARGO_DOMAIN="你的域名" \
  -e ARGO_AUTH="你的Token" \
  -p 3000:3000 \
  ghcr.io/fnosnas/komari:latest
```
不换行的版本：
```
docker run -d --name komari --restart always -e NEZHA_SERVER="你的服务器地址" -e NEZHA_KEY="你的Key" -e ARGO_DOMAIN="你的域名" -e ARGO_AUTH="你的Token" -p 3000:3000 ghcr.io/fnosnas/komari:latest
```
常用管理命令：   
# 查看运行日志
docker logs -f komari

# 查看运行状态
docker ps | grep komari

# 停止
docker stop komari

# 删除重建（更新变量时用）
docker rm -f komari && docker run ...

# 更新镜像
docker pull ghcr.io/fnosnas/komari:latest && docker rm -f komari && docker run ...

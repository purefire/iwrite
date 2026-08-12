# iwrite 部署到 Google Cloud

本文分为两种场景。**如果 `jing.lv` 已经运行在一台 WordPress VM 上，请优先阅读文末“附录 A：从现有 WordPress 原地切换”**；不需要新建 VM，也不需要修改域名 A 记录，核心动作只是备份、部署 Node.js 服务，再把现有 Nginx 的 WordPress 入口切换成反向代理。

本文前面的资源说明适用于确认 Cloud SQL、Cloud Storage 和服务账号权限；文末附录是现有生产服务器的实际切换步骤。切换前必须保留 WordPress 文件、数据库备份和 Nginx 配置，确保可以快速回滚。

当前应用不是无状态多实例应用：文章已经迁移到 MySQL，图片和音频放在 Cloud Storage，但管理员 session 仍保存在 Node.js 进程内存。因此第一版部署请使用现有 VM 上的一个 Node.js 进程，不要直接扩容成多个实例。

## 1. 架构与数据位置

```text
浏览器
  │ HTTPS
  ▼
Nginx :443
  │ 127.0.0.1:4173
  ▼
Node.js / iwrite
  ├─ Cloud SQL Auth Proxy → Cloud SQL for MySQL
  └─ Cloud Storage Bucket → 图片、MP3、OGG、WAV
```

MySQL 中由应用启动时自动创建两张表：

- `posts`：文章、正文、栏目、发布日期、发布状态和配乐关联。
- `media`：媒体类型、Cloud Storage object name、文件名、MIME 类型和大小。

`data/posts.json` 只作为迁移源保留，不再是生产数据源。图片和音乐不会写入 Git，也不会写入 MySQL BLOB；MySQL 只保存媒体元数据。

## 2. 创建 Google Cloud 资源

在目标 Google Cloud 项目中准备：

1. 一个 Cloud SQL for MySQL 实例。
2. 一个 Cloud Storage Bucket，例如 `jing-lv-media`。
3. 一个 Compute Engine VM，建议 Debian 12 或 Ubuntu LTS。
4. 一个绑定到 VM 的专用服务账号，例如 `iwrite-vm`。
5. `jing.lv` 的 DNS A 记录指向 VM 外部静态 IP。

Bucket 建议：

- 开启 **Public access prevention**。
- 使用统一存储权限（Uniform bucket-level access）。
- 只给 VM 服务账号授予该 Bucket 的 `Storage Object Admin`。
- 不要把整个 Bucket 配成公开读；应用会通过 `/media/<id>` 读取私有对象。

给 VM 服务账号授予：

- `Cloud SQL Client`：允许 Cloud SQL Auth Proxy 连接实例。
- Bucket 级别的 `Storage Object Admin`：允许上传、读取以及清理失败上传的媒体对象。

Cloud SQL Auth Proxy 会利用服务账号权限建立连接，不需要把 Cloud SQL 公网地址和数据库 SSL 细节暴露给应用。参考官方文档：

- [Cloud SQL Auth Proxy 概览](https://docs.cloud.google.com/sql/docs/mysql/sql-proxy)
- [使用 Cloud SQL Auth Proxy 连接 MySQL](https://docs.cloud.google.com/sql/docs/mysql/connect-auth-proxy)
- [Cloud Storage Node.js 客户端](https://www.npmjs.com/package/@google-cloud/storage)

## 3. Cloud SQL 初始化

在 Cloud SQL 中创建一个数据库，例如：

```text
数据库名：jinglv
数据库用户：iwrite_app
```

数据库用户只需要访问 `jinglv` 数据库的权限。第一次启动应用时，`lib/database.mjs` 会执行 `CREATE TABLE IF NOT EXISTS`，因此不需要手工创建 `posts` 和 `media` 表。

建议通过 Google Cloud Console 的 Cloud SQL 页面创建数据库和用户，不要把数据库密码写入仓库或命令历史。数据库密码稍后只放入 VM 的 root 可读环境文件。

## 4. 创建 VM 与安装运行环境

创建 VM 后通过 SSH 登录，安装 Node.js LTS、Git、Nginx 和必要工具。Node.js 需要支持当前项目的 ESM 语法，建议使用 Node.js 20 或更新的 LTS 版本。

```zsh
sudo apt update
sudo apt install -y git nginx ca-certificates curl
```

安装 Node.js 时使用官方 NodeSource、发行版 LTS 包或你已经维护的 Node.js 版本管理工具。确认版本：

```zsh
node --version
npm --version
```

创建低权限运行用户和应用目录：

```zsh
sudo useradd --system --create-home --home-dir /srv/iwrite --shell /usr/sbin/nologin iwrite
sudo install -d -o iwrite -g iwrite /srv/iwrite
```

以 `iwrite` 用户部署代码：

```zsh
sudo -u iwrite git clone https://github.com/purefire/iwrite.git /srv/iwrite
cd /srv/iwrite
sudo -u iwrite npm ci
```

不要把 `node_modules`、`.env`、Cloud credentials JSON 或数据库密码提交到 Git。仓库的 `.gitignore` 已排除 `node_modules` 和 `.env*`。

## 5. 安装与运行 Cloud SQL Auth Proxy

下载 Cloud SQL Auth Proxy v2 到固定路径，并赋予执行权限。下载地址和版本应以官方文档为准；不要从不明镜像下载：

```zsh
sudo curl -L -o /usr/local/bin/cloud-sql-proxy \
  https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.18.3/cloud-sql-proxy.linux.amd64
sudo chmod 0755 /usr/local/bin/cloud-sql-proxy
```

将下面的三个占位符替换为你的真实值：`PROJECT_ID`、`REGION`、`INSTANCE_NAME`。

创建 Unix Socket 目录：

```zsh
sudo install -d -o iwrite -g iwrite -m 0750 /cloudsql
```

使用 `sudoedit` 创建 `/etc/systemd/system/cloud-sql-proxy.service`：

```ini
[Unit]
Description=Cloud SQL Auth Proxy for iwrite
After=network-online.target
Wants=network-online.target

[Service]
User=iwrite
Group=iwrite
ExecStart=/usr/local/bin/cloud-sql-proxy --unix-socket=/cloudsql PROJECT_ID:REGION:INSTANCE_NAME
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

启用并检查：

```zsh
sudo systemctl daemon-reload
sudo systemctl enable --now cloud-sql-proxy
sudo systemctl status cloud-sql-proxy
```

如果服务账号权限正确，日志中不应出现 `permission denied` 或 `invalid instance`。

## 6. 配置应用环境变量

使用 `sudoedit` 创建 `/etc/iwrite.env`。该文件包含密码，只允许 root 读取：

```ini
NODE_ENV=production
PORT=4173

ADMIN_PASSWORD="替换为足够长的管理员密码"
DB_NAME=jinglv
DB_USER=iwrite_app
DB_PASSWORD="替换为 Cloud SQL 数据库密码"
DB_SOCKET_PATH=/cloudsql
GCS_BUCKET=jing-lv-media
```

设置权限：

```zsh
sudo chown root:iwrite /etc/iwrite.env
sudo chmod 0640 /etc/iwrite.env
```

当前代码通过 `DB_SOCKET_PATH=/cloudsql` 连接 Cloud SQL Auth Proxy 创建的 Unix Socket。不要同时配置错误的公网 `DB_HOST`，否则可能连接到错误地址。

## 7. 首次导入旧文章

先确认 Cloud SQL Auth Proxy 已运行，应用目录中的 `data/posts.json` 是需要迁移的版本，然后在已经加载上述环境变量的 shell 中运行：

```zsh
set -a
source /etc/iwrite.env
set +a
cd /srv/iwrite
sudo -E -u iwrite npm run db:import-json
```

导入脚本会：

- 自动创建 `posts` 和 `media` 表；
- 按文章 ID 插入或更新文章；
- 保留原文章正文和发布日期；
- 不会生成旧文章的媒体关联。

该命令可以重复执行，但正式迁移前仍应对 Cloud SQL 做备份。不要在生产环境直接执行 `npm run import:wordpress`，它只更新本地 JSON，不会同步 WordPress 页面或媒体到 MySQL。

## 8. 创建 systemd 应用服务

使用 `sudoedit` 创建 `/etc/systemd/system/iwrite.service`：

```ini
[Unit]
Description=iwrite personal archive
After=network-online.target cloud-sql-proxy.service
Wants=network-online.target
Requires=cloud-sql-proxy.service

[Service]
User=iwrite
Group=iwrite
WorkingDirectory=/srv/iwrite
EnvironmentFile=/etc/iwrite.env
ExecStart=/usr/bin/node /srv/iwrite/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

如果 `node` 不在 `/usr/bin/node`，用 `command -v node` 找到实际路径并修改 `ExecStart`。然后启动：

```zsh
sudo systemctl daemon-reload
sudo systemctl enable --now iwrite
sudo systemctl status iwrite
sudo journalctl -u iwrite -n 100 --no-pager
```

应用仍只监听 `127.0.0.1:4173`，不要把 4173 端口开放到互联网。

## 9. 配置 Nginx 与 HTTPS

创建 `/etc/nginx/sites-available/iwrite`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name jing.lv www.jing.lv;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

启用配置并检查：

```zsh
sudo ln -s /etc/nginx/sites-available/iwrite /etc/nginx/sites-enabled/iwrite
sudo nginx -t
sudo systemctl reload nginx
```

确认 DNS 已生效后，用 Certbot 或 Google Cloud Load Balancer 配置 HTTPS。使用 Certbot 的一种方式：

```zsh
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d jing.lv -d www.jing.lv
```

生产环境必须使用 HTTPS：应用在 `NODE_ENV=production` 时会给管理员 session cookie 增加 `Secure` 属性。

## 10. 防火墙与访问控制

Google Cloud VPC 防火墙只开放：

- `tcp:80`：HTTP 和证书验证；
- `tcp:443`：HTTPS；
- SSH：尽量仅允许你的固定 IP，或使用 IAP / OS Login。

不要开放 `3306`、`4173` 或 Cloud SQL Auth Proxy 的 Unix Socket。Cloud SQL 不需要为这套配置开放公网数据库访问。

## 11. 备份与发布更新

至少配置：

- Cloud SQL 自动备份和时间点恢复；
- Cloud Storage 对象版本控制或定期备份；
- VM 磁盘快照（用于系统级恢复）；
- 保存 `/etc/iwrite.env` 的安全副本，但不要把它放进 Git。

发布新版本：

```zsh
cd /srv/iwrite
sudo -u iwrite git pull --ff-only origin main
sudo -u iwrite npm ci
npm run check
sudo systemctl restart iwrite
sudo systemctl status iwrite
```

如果更新包含数据库结构变化，应先备份 Cloud SQL，再执行迁移步骤。当前项目启动时只会创建缺失表，不会自动删除或重命名已有字段。

## 12. 常见问题

### 应用提示数据库初始化失败

检查：

```zsh
sudo systemctl status cloud-sql-proxy
sudo journalctl -u cloud-sql-proxy -n 100 --no-pager
sudo journalctl -u iwrite -n 100 --no-pager
```

重点检查项目 ID、区域、实例名、VM 服务账号的 `Cloud SQL Client` 权限，以及 `/cloudsql` 目录权限。

### 上传图片或 MP3 失败

检查：

- VM 服务账号是否有 Bucket 的 `Storage Object Admin`；
- `GCS_BUCKET` 是否只填写 Bucket 名称；
- Nginx 是否有 `client_max_body_size 25m`；
- 图片是否不超过 8 MB；音频是否不超过 20 MB；
- `NODE_ENV=production` 后是否通过 HTTPS 访问。

### 登录成功但重启后需要重新登录

这是当前实现的预期行为：session 存在 Node.js 内存中。不要运行多个应用实例，否则不同实例之间的登录状态和 session 不共享。未来如果需要多实例，应把 session 迁移到 Redis 或 MySQL。

### 旧文章没有图片或音乐

这是正常的。原始 `posts.json` 只包含文章文本；迁移脚本不会凭空生成媒体。以后登录写作台，在文章编辑器中上传图片或配乐即可。

## 13. 部署前检查清单

- [ ] DNS A 记录指向 VM 静态 IP。
- [ ] Cloud SQL 数据库、用户和密码已创建。
- [ ] Cloud Storage Bucket 已创建且禁止公开访问。
- [ ] VM 服务账号拥有 Cloud SQL Client 和 Bucket 对象权限。
- [ ] Cloud SQL Auth Proxy 已启动。
- [ ] `/etc/iwrite.env` 已创建且权限为 `0640`。
- [ ] 已执行一次 JSON → MySQL 导入并核对文章数量。
- [ ] `iwrite.service` 已启动并设置开机启动。
- [ ] Nginx 反向代理正常。
- [ ] HTTPS 证书正常，浏览器无混合内容警告。
- [ ] 已确认 3306 和 4173 没有对公网开放。
- [ ] 已配置 Cloud SQL 与 Cloud Storage 备份策略。

本文中的 Google Cloud 链接均指向官方资料；命令中的项目 ID、区域、实例名、Bucket 名称、用户名和密码必须替换为你自己的值。


## 附录 A：从现有 WordPress VM 原地切换

这一节针对已经运行 `jing.lv` WordPress 的服务器。DNS、静态 IP、HTTPS 证书和 VM 都保留，只替换 Nginx 的后端入口。

### A.1 切换前备份

先确认当前 WordPress 站点根目录、Nginx 配置和 PHP-FPM 服务名称。下面的 `WP_ROOT` 只是示例，必须替换成你的真实路径：

```zsh
sudo systemctl is-active nginx
sudo systemctl is-active apache2
sudo nginx -T 2>/dev/null | grep -n -A 80 -B 10 "server_name.*jing.lv"
export WP_ROOT="/var/www/html"
```

备份 Nginx 配置：

```zsh
sudo cp -a /etc/nginx "/root/nginx-before-iwrite-$(date +%Y%m%d-%H%M%S)"
```

如果安装了 WP-CLI，导出当前 WordPress 数据库。以下命令会使用 WordPress 自己的 `wp-config.php` 连接数据库，不把数据库密码写进命令：

```zsh
cd "$WP_ROOT"
sudo -u www-data wp db export "/root/wordpress-before-iwrite-$(date +%Y%m%d-%H%M%S).sql"
```

如果没有 WP-CLI，请从 Cloud SQL 的 Backups 页面创建备份；如果 WordPress 使用 VM 本地 MySQL，请使用你现有的数据库备份流程。不要在生产切换前删除 WordPress 数据库、PHP-FPM 或站点文件。

### A.2 保留当前 VM，准备应用目录

```zsh
sudo useradd --system --create-home --home-dir /srv/iwrite --shell /usr/sbin/nologin iwrite
sudo install -d -o iwrite -g iwrite -m 0755 /srv/iwrite
sudo -u iwrite git clone https://github.com/purefire/iwrite.git /srv/iwrite
cd /srv/iwrite
sudo -u iwrite npm ci
sudo -u iwrite npm run check
sudo -u iwrite node --check public/app.js
```

如果 `iwrite` 用户或 `/srv/iwrite` 已经存在，跳过对应的创建命令；不要覆盖已有的生产代码目录，先确认它确实是本项目。

### A.3 准备数据库和媒体 Bucket

建议给 iwrite 使用独立数据库，例如 `jinglv`，不要直接使用 WordPress 的数据库。可以复用现有 Cloud SQL 实例，但使用独立数据库和独立用户。

如果 WordPress 使用的是 Cloud SQL：

1. 在 Cloud SQL 中创建 `jinglv` 数据库和 `iwrite_app` 用户；
2. 给当前 VM 绑定的服务账号授予 `Cloud SQL Client`；
3. 给该服务账号授予媒体 Bucket 的 `Storage Object Admin`；
4. 按本文前面的 Cloud SQL Auth Proxy 小节安装 Proxy。

如果 WordPress 使用的是 VM 本地 MySQL：

- 可以在同一个 MySQL 服务中创建独立的 `jinglv` 数据库和 `iwrite_app` 用户；
- 环境变量使用 `DB_HOST=127.0.0.1`、`DB_PORT=3306`；
- 仍然需要创建 Cloud Storage Bucket，并给 VM 服务账号授予 Bucket 对象权限；
- 不要把 iwrite 表写入 WordPress 数据库。

### A.4 从切换前的 WordPress 读取文章

在 WordPress 仍然在线时执行：

```zsh
cd /srv/iwrite
sudo -u iwrite npm run import:wordpress
```

这一步会从当前 `https://jing.lv` 的 WordPress REST API 读取文章并更新 `/srv/iwrite/data/posts.json`。因此它必须在切换 Nginx 之前执行。

当前导入脚本会导入文章标题、栏目、日期、摘要和正文；不会自动迁移 WordPress 的图片附件、评论或媒体文件。已有 WordPress 图片如果需要继续保留，需要另行做媒体迁移；新图片和 MP3 可以在 iwrite 写作台中重新上传到 Cloud Storage。

### A.5 配置环境变量与数据库迁移

使用 `sudoedit` 创建 `/etc/iwrite.env`：

```zsh
sudoedit /etc/iwrite.env
```

Cloud SQL Auth Proxy 场景：

```ini
NODE_ENV=production
PORT=4173
ADMIN_PASSWORD="替换为管理员密码"
DB_NAME=jinglv
DB_USER=iwrite_app
DB_PASSWORD="替换为数据库密码"
DB_SOCKET_PATH=/cloudsql
GCS_BUCKET=替换为Bucket名称
```

VM 本地 MySQL 场景：

```ini
NODE_ENV=production
PORT=4173
ADMIN_PASSWORD="替换为管理员密码"
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=jinglv
DB_USER=iwrite_app
DB_PASSWORD="替换为数据库密码"
GCS_BUCKET=替换为Bucket名称
```

设置权限：

```zsh
sudo chown root:iwrite /etc/iwrite.env
sudo chmod 0640 /etc/iwrite.env
```

确认数据库服务或 Cloud SQL Auth Proxy 正常后，执行一次 JSON 导入：

```zsh
sudo -i
set -a
source /etc/iwrite.env
set +a
cd /srv/iwrite
sudo -E -u iwrite npm run db:import-json
exit
```

迁移后不要删除 `data/posts.json`，在确认新站点正常前保留它作为回退数据。

### A.6 在现有 VM 上启动 Node.js

先检查 Node 路径：

```zsh
command -v node
```

创建服务：

```zsh
sudoedit /etc/systemd/system/iwrite.service
```

```ini
[Unit]
Description=iwrite personal archive
After=network-online.target
Wants=network-online.target

[Service]
User=iwrite
Group=iwrite
WorkingDirectory=/srv/iwrite
EnvironmentFile=/etc/iwrite.env
ExecStart=/usr/bin/node /srv/iwrite/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

如果 `command -v node` 不是 `/usr/bin/node`，修改 `ExecStart` 路径。启动并检查：

```zsh
sudo systemctl daemon-reload
sudo systemctl enable --now iwrite
sudo systemctl status iwrite --no-pager
sudo journalctl -u iwrite -n 100 --no-pager
curl -sS http://127.0.0.1:4173/api/me
curl -sS http://127.0.0.1:4173/api/posts
```

在这些本机接口返回正常之前，不要切换 Nginx。

### A.7 只修改现有 Nginx 的后端入口

先定位当前生效配置：

```zsh
sudo nginx -T 2>/dev/null | grep -n -A 100 -B 10 "server_name.*jing.lv"
```

用 `sudoedit` 编辑上一步找到的 WordPress server 配置。不要删除现有的 `listen`、`server_name`、`ssl_certificate`、`ssl_certificate_key`、Certbot 的 `include` 和 `options-ssl-nginx.conf`。在 HTTPS 的 server 块中，把 WordPress 的 `root`、`index`、`try_files` 和 PHP `location` 替换为：

```nginx
client_max_body_size 25m;

location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

如果当前 HTTP server 块负责跳转 HTTPS，保留它原来的跳转配置。不要重复添加第二个 `server_name jing.lv`，否则 Nginx 可能选择错误的 server 块。

检查并重载：

```zsh
sudo nginx -t
sudo systemctl reload nginx
curl -I https://jing.lv
curl -sS https://jing.lv/api/me
```

因为使用的是原来的 VM、IP 和域名，DNS 不需要修改，原来的 HTTPS 证书也可以继续使用。

### A.8 切换后的验证与回滚

浏览器验证：

1. 打开 `https://jing.lv`，确认不再显示 WordPress 首页；
2. 点击旧文章，确认文章内容存在；
3. 管理员登录；
4. 新建测试文章；
5. 上传图片；
6. 上传 MP3；
7. 退出登录后确认访客仍可阅读公开文章；
8. 确认草稿不会被访客看到。

实时查看日志：

```zsh
sudo journalctl -u iwrite -f
sudo journalctl -u nginx -f
```

如果需要立即回到 WordPress：

1. 用 `sudoedit` 把原来的 Nginx WordPress `root`、`try_files` 和 PHP `location` 恢复；
2. 保留并确认原来的 HTTPS 配置；
3. 执行：

```zsh
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl stop iwrite
```

不要删除 `/srv/iwrite`、`data/posts.json`、WordPress 文件或 WordPress 数据库，直到新站点稳定运行并完成备份。

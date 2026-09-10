# 2026年中秋、国庆值班报名系统

单位内部使用的假期值班报名网页：员工在公网填报（**只填姓名**），后台自动汇总统计。

**值班日期**（依据《国务院办公厅关于2026年部分节假日安排的通知》，国办发明电〔2025〕7号）

| 节日 | 日期 | 天数 |
| --- | --- | --- |
| 中秋节 | 9月25日（周五）— 9月27日（周日） | 3 天 |
| 国庆节 | 10月1日（周四）— 10月7日（周三） | 7 天 |

合计 10 个值班日，每天 3 人，共 30 个名额。

## 报名规则

| 规则 | 说明 | 触发时的提示 |
| --- | --- | --- |
| 每天人数上限 | 中班 2 人 + 晚班 1 人 = 3 人 | — |
| 班次已满 | 中班满 2 人或晚班满 1 人 | 该班次报名人数已满，请选择其他班次 |
| 当天已满 | 当天已排满 3 人 | 该日期报名人数已满，请选择其他日期 |
| 重复报名 | 同一个人同一日期只能报一个班次 | 同一员工同一日期只能报名一个班次，××× 已报名×月×日的×班 |

所有规则都由**服务端**校验，前端只是提前提示。多个人同时抢最后一个名额时，
数据库用事务 + 唯一索引保证不会超员。

**姓名就是唯一标识**：姓名里的空格会被自动去掉，「张 三」和「张三」算同一个人。

## 页面

| 地址 | 用途 |
| --- | --- |
| `/` | 员工报名页：选择日期和班次、查看已报名人员、查询/取消自己的报名 |
| `/admin` | 管理后台（需密码）：按日期统计、按人员统计、导出 Excel、打印、代报名、删除、清空 |

## 本地运行

需要 Node.js 23.4 以上（推荐 Node.js 24 LTS），**不需要 npm install，本项目零第三方依赖**。

```bash
node server.js
```

浏览器打开 http://localhost:3000 即是报名页，http://localhost:3000/admin 是管理后台。

首次启动会自动生成管理密码，保存在 `data/admin-password.txt`，同时打印在控制台。

## 公网部署

### 方式一：Docker（推荐）

1. 把整个目录上传到服务器；
2. 修改 `docker-compose.yml` 里的 `ADMIN_PASSWORD`（必改）；
3. 在服务器目录下执行：

```bash
docker compose up -d --build
```

服务默认只监听本机 3000 端口，由 Nginx 反向代理对外提供服务。
如果暂时没有域名、想直接用 `http://服务器IP:3000` 访问，把 `ports` 改成 `"3000:3000"` 即可。

### 方式二：直接用 Node.js + systemd

```bash
sudo mkdir -p /opt/duty
sudo cp -r config.js server.js public /opt/duty/
sudo cp deploy/duty.service /etc/systemd/system/duty.service
sudo nano /etc/systemd/system/duty.service   # 修改管理密码
sudo systemctl daemon-reload && sudo systemctl enable --now duty
```

### 配置 HTTPS 和域名

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/duty.conf
sudo nano /etc/nginx/conf.d/duty.conf        # 把域名换成你自己的
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名              # 申请证书
```

**手机号属于个人信息，公网部署强烈建议配 HTTPS**，否则数据是明文传输的。

### 国内服务器备案提醒

如果服务器在中国大陆，绑定域名对外提供 Web 服务需要完成 ICP 备案，
否则域名会被拦截。走政务云/单位内网则按单位规定办理。

## 配置项

### config.js（改完重启生效）

```js
siteTitle: '2026年中秋、国庆值班报名',   // 页面标题
shifts: [                               // 班次与人数上限
  { key: '中班', limit: 2 },
  { key: '晚班', limit: 1 }
],
groups: [ /* 可报名的日期，以后加别的节日在这里加 */ ]
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，用 Nginx 反代时可设为 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据库和密钥存放目录 |
| `ADMIN_PASSWORD` | 自动生成 | 管理后台密码，**公网部署必须自己设置** |
| `ACCESS_CODE` | 空 | 设置后，必须凭邀请码才能查看和报名；留空则开放访问 |
| `TRUST_PROXY` | `0` | 用 Nginx/Caddy 反代时设为 `1`，用于记录真实 IP |
| `SESSION_SECRET` | 自动生成 | 管理后台会话签名密钥 |

## 数据与备份

- 所有报名数据存在 `data/duty.db`（SQLite 单文件），删容器不丢数据。
- 备份：直接复制 `data` 目录；恢复：把 `data` 目录放回去再启动服务。
- 管理后台的「导出 Excel」导出的是 CSV，用 Excel 直接打开即可，但**只用于查看，不能用来恢复数据**。
- `data/` 已在 `.gitignore` 中，不会被提交到仓库。

## 目录结构

```
config.js              日期、班次、人数上限等配置
server.js              HTTP 服务 + 报名规则（零依赖）
public/index.html      员工报名页
public/admin.html      管理后台
tests/api.test.js      端到端接口测试
Dockerfile             容器镜像
docker-compose.yml     一键部署
deploy/nginx.conf      Nginx 反向代理示例
deploy/duty.service    systemd 服务示例
offline/index.html     上一版的单机离线页面（不联网也能用，数据只存在本机浏览器）
data/                  运行后生成：数据库、管理密码、会话密钥
```

## 测试

```bash
node tests/api.test.js
```

会自动启动一个测试实例，逐条验证报名规则、提示语、管理接口、导出和数据落库，跑完自动清理。

## 已知限制

- **重名问题**：因为只填姓名，单位里如果有同名同事，两个人只能报同一天的其中一个班次。
  遇到这种情况需要改成「姓名 + 工号」或「姓名 + 科室」，改起来很快。
- **谁都能取消**：报名页输入某个姓名后，「查询我的报名」能看到该姓名的报名记录并取消，
  没有任何身份验证。正式对外前如果这个风险不能接受，可以把自助取消关掉，改成只允许管理员在后台删除。
- 报名页公开显示姓名。如果单位要求不公开，需要改成只显示人数。
- 单机部署，适合一个单位几百人使用；如需多台服务器负载均衡，需要换成 PostgreSQL 等共享数据库。

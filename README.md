# 基元律动 Status 监控站

监控 [tokenrhythm.studio](https://tokenrhythm.studio)（基元律动）API 服务状态的实时仪表盘。

- 在线站点: **https://status.moonlink.top**
- 源码仓库: **https://github.com/SQMY-dor/tr-status**

## 架构

```
monitor/  Cloudflare Worker (cron 每 5 分钟)
  ├─ src/index.js   探测全部模型 + API 网关, 写入 KV, 维护 90 天历史 + 事故时间线
  └─ wrangler.toml  cron 触发器 + KV 绑定 (tr_status)
pages/    Cloudflare Pages 仪表盘
  ├─ public/index.html          前端 (30s 自动刷新, 按厂商分组)
  ├─ functions/api/status.js    KV 读取 API
  └─ wrangler.toml              Pages 配置 + KV 绑定
```

## 功能

- 模型列表从上游 `/v1/models` **动态同步**（TTL 6h），新增模型自动纳入监控
- 每 5 分钟探测所有模型 + API 网关（chat/completions 最小请求）
- 90 天可用性历史 + 完整事故时间线（KV 持久化）
- 前端 30 秒自动刷新，按厂商分组（DeepSeek / GLM / Kimi / MiniMax / Qwen / Seed）
- 手动触发探测有 `x-probe-secret` 保护，防滥用
- 页面底部附源码链接，可直接跳转本仓库

## 部署教程

### 前置条件

- [Node.js](https://nodejs.org) ≥ 18 与 npm
- [Cloudflare 账号](https://dash.cloudflare.com)（需要 Workers Paid 或 Free 计划均可，cron 触发在 Free 计划可用）
- [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)：`npm install -g wrangler`
- 已登录 Cloudflare：`wrangler login`
- 基元律动 API key（用于探测请求，格式 `Bearer <key>`）

### 1. 获取源码

```bash
git clone git@github.com:SQMY-dor/tr-status.git
cd tr-status
```

### 2. 创建 KV 命名空间

Worker 与 Pages 共享同一个 KV 命名空间 `tr_status`：

```bash
wrangler kv namespace create tr_status
# 输出形如: id = "25caa4a5b75f45d38b6949311f9f39cd"
```

把输出的 id 填入 **两个** `wrangler.toml`（`monitor/wrangler.toml` 与 `pages/wrangler.toml`）的 `[[kv_namespaces]] id`。

### 3. 设置密钥（必填）

```bash
wrangler secret put TR_API_KEY      # 基元律动 API key (Bearer)
wrangler secret put PROBE_SECRET    # 手动探测保护 secret
```

> 注意：`wrangler secret put` 作用于 Worker，需在 `monitor/` 目录下执行；Pages 侧通过 `wrangler pages secret` 或仪表盘设置同名密钥。

### 4. 部署 monitor worker（探活与数据采集）

```bash
cd monitor
wrangler deploy
```

部署成功后 Worker 按 `*/5 * * * *` cron 每 5 分钟自动探测全部模型并写入 KV。

### 5. 部署 Pages 仪表盘

```bash
cd ../pages
wrangler pages deploy public --project-name tr-status
```

Pages 的 Functions（`functions/api/status.js`）提供 `/api/status` 接口供前端读取 KV。

### 6. （可选）绑定自定义域名

在 Cloudflare 仪表盘 → Pages → `tr-status` → 自定义域，添加 `status.moonlink.top`（需先将域名接入 Cloudflare DNS）。

### 7. 验证

- 打开站点，应看到"所有系统运行正常"横幅与按厂商分组的组件列表
- 等待最多 5 分钟，24 小时格子条开始出现首个绿色格子
- 手动触发一次探测：`curl -H "x-probe-secret: <PROBE_SECRET>" https://<worker域名>/probe`

### 更新

```bash
git pull
cd monitor && wrangler deploy
cd ../pages && wrangler pages deploy public --project-name tr-status
```

## 密钥

- `TR_API_KEY` — 基元律动 API key，用于探测请求
- `PROBE_SECRET` — 手动触发探测的 header 校验值 (`x-probe-secret`)

所有密钥通过 Cloudflare Worker secret 注入，**代码零硬编码**。

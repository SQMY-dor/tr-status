# 基元律动 Status 监控站

监控 [tokenrhythm.studio](https://tokenrhythm.studio)（基元律动）API 服务状态的实时仪表盘。
在线站点: **https://status.moonlink.top**

## 架构

```
monitor/  Cloudflare Worker (cron 每 5 分钟)
  └─ src/index.js   探测全部模型 + API 网关, 写入 KV, 维护 90 天历史 + 事故时间线
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

## 部署

```bash
# 1. 创建 KV 命名空间并记录 ID
wrangler kv namespace create tr_status

# 2. 把 KV ID 填入两个 wrangler.toml 的 [[kv_namespaces]] id

# 3. 设置密钥 (必填)
wrangler secret put TR_API_KEY      # 基元律动 API key (Bearer)
wrangler secret put PROBE_SECRET    # 手动探测保护 secret

# 4. 部署 monitor worker
cd monitor && wrangler deploy

# 5. 部署 Pages
cd ../pages && wrangler pages deploy public --project-name tr-status
```

## 密钥

- `TR_API_KEY` — 基元律动 API key，用于探测请求
- `PROBE_SECRET` — 手动触发探测的 header 校验值 (`x-probe-secret`)

所有密钥通过 Cloudflare Worker secret 注入，**代码零硬编码**。

## 自定义域名

`status.moonlink.top` 通过 Cloudflare Pages 自定义域绑定（在 Pages 项目设置中添加）。

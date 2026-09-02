# HBF A股质押日报调度器

独立 Cloudflare Durable Object Worker，仅调用质押日报的受保护生产接口，不绑定或修改 OTC Filing Watch 主站。

使用 Durable Object Alarm 每5分钟自唤醒，不占用账户 Cron Trigger 配额。调度器全天候调用轻量生产检查：每天20:00固定日报范围，之后披露的公告进入下一自然日，周末也持续运行；日报一旦发布，生产接口立即返回已发布状态，不重复抓取或解析。

`PRODUCTION_CRON_SECRET` 必须通过 Wrangler secret 配置，禁止写入源码。

部署完成后，使用同一密钥向 Worker 的 `/start` 发送一次受保护的 POST 请求即可启动自续约闹钟。`GET /status` 可查看是否激活、下次唤醒时间和最近一次执行结果，不返回任何密钥。

`wrangler.toml` 和 `wrangler.upload.toml` 均不声明 Cron Trigger，不会创建、删除或修改任何现有定时触发器。

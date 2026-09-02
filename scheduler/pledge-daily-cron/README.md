# HBF A股质押日报调度器

独立 Cloudflare Cron Worker，仅调用质押日报的受保护生产接口，不绑定或修改 OTC Filing Watch 主站。

仅占用一个 Cron Trigger：交易日每5分钟唤醒一次，但代码只在北京时间20:00–21:59调用生产接口。其他时段立即退出，不访问主站。

`PRODUCTION_CRON_SECRET` 必须通过 Wrangler secret 配置，禁止写入源码。

`wrangler.upload.toml` 用于在账户 Cron 配额已满时仅更新代码；它不会创建、删除或修改任何现有定时触发器。

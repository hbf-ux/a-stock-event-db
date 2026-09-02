export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runProductionTick(controller, env));
  },
};

async function runProductionTick(controller, env) {
  if (!env.PRODUCTION_TICK_URL || !env.PRODUCTION_CRON_SECRET) {
    throw new Error("Pledge daily scheduler is missing its target or credential");
  }

  const beijing = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(controller.scheduledTime));
  const hour = Number(beijing.find((part) => part.type === "hour")?.value || -1);
  if (hour < 20 || hour >= 22) {
    console.log(JSON.stringify({ status: "skipped", reason: "outside-production-window", cron: controller.cron, scheduledTime: controller.scheduledTime }));
    return;
  }

  const response = await fetch(env.PRODUCTION_TICK_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.PRODUCTION_CRON_SECRET}`,
      "content-type": "application/json",
      "user-agent": "HBF-Pledge-Daily-Cron/1.0",
    },
    body: JSON.stringify({
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      source: "cloudflare-cron-worker",
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Production tick failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  console.log(JSON.stringify({ status: "ok", cron: controller.cron, scheduledTime: controller.scheduledTime, response: body.slice(0, 500) }));
}

const FIVE_MINUTES = 5 * 60 * 1000;
const SCHEDULER_NAME = "pledge-daily-singleton";

export class PledgeScheduler {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
      return this.status();
    }

    if (request.method === "POST" && url.pathname === "/start") {
      if (!isAuthorized(request, this.env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const nextAlarmAt = nextFiveMinuteBoundary(Date.now());
      await this.ctx.storage.setAlarm(nextAlarmAt);
      await this.ctx.storage.put("scheduler_started_at", new Date().toISOString());
      return json({ ok: true, scheduler: SCHEDULER_NAME, nextAlarmAt: new Date(nextAlarmAt).toISOString() });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  async alarm() {
    const firedAt = Date.now();
    const nextAlarmAt = nextFiveMinuteBoundary(firedAt);
    await this.ctx.storage.setAlarm(nextAlarmAt);

    const window = beijingWindow(firedAt);
    const baseStatus = {
      scheduler: SCHEDULER_NAME,
      firedAt: new Date(firedAt).toISOString(),
      nextAlarmAt: new Date(nextAlarmAt).toISOString(),
      beijingTime: window.localTime,
    };

    try {
      validateEnvironment(this.env);
      const response = await fetch(this.env.PRODUCTION_TICK_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.PRODUCTION_CRON_SECRET}`,
          "content-type": "application/json",
          "user-agent": "HBF-Pledge-Durable-Alarm/1.0",
        },
        body: JSON.stringify({
          scheduledTime: firedAt,
          source: "cloudflare-durable-object-alarm",
          beijingTime: window.localTime,
        }),
      });
      const body = await response.text();
      const status = {
        ...baseStatus,
        status: response.ok ? "ok" : "target_error",
        targetStatus: response.status,
        response: body.slice(0, 500),
      };
      await this.record(status);
      console.log(JSON.stringify(status));
    } catch (error) {
      const status = {
        ...baseStatus,
        status: "scheduler_error",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.record(status);
      console.error(JSON.stringify(status));
    }
  }

  async status() {
    const [nextAlarmAt, lastRun, startedAt] = await Promise.all([
      this.ctx.storage.getAlarm(),
      this.ctx.storage.get("last_run"),
      this.ctx.storage.get("scheduler_started_at"),
    ]);
    return json({
      ok: true,
      scheduler: SCHEDULER_NAME,
      mode: "durable-object-alarm",
      active: nextAlarmAt !== null,
      startedAt: startedAt || null,
      nextAlarmAt: nextAlarmAt === null ? null : new Date(nextAlarmAt).toISOString(),
      lastRun: lastRun || null,
    });
  }

  async record(status) {
    await this.ctx.storage.put("last_run", status);
  }
}

export default {
  async fetch(request, env) {
    const id = env.PLEDGE_SCHEDULER.idFromName(SCHEDULER_NAME);
    return env.PLEDGE_SCHEDULER.get(id).fetch(request);
  },
};

function isAuthorized(request, env) {
  if (!env.PRODUCTION_CRON_SECRET) return false;
  return request.headers.get("authorization") === `Bearer ${env.PRODUCTION_CRON_SECRET}`;
}

function validateEnvironment(env) {
  if (!env.PRODUCTION_TICK_URL || !env.PRODUCTION_CRON_SECRET) {
    throw new Error("Pledge daily scheduler is missing its target or credential");
  }
}

function nextFiveMinuteBoundary(now) {
  return Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES + FIVE_MINUTES;
}

function beijingWindow(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  const localTime = `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
  return { shouldRun: true, reason: null, localTime };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

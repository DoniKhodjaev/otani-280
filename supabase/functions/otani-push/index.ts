// Ежедневный пуш со списком задач. Секреты лежат в таблице otani_config (доступ только у service role).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ALLOWED = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/];
const DOW = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

let cfg: Record<string, string> | null = null;
async function config() {
  if (!cfg) {
    const { data, error } = await db.from("otani_config").select("key,value");
    if (error) throw error;
    cfg = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
    webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  }
  return cfg;
}

async function buildMessage(tasksUrl: string) {
  const now = new Date(Date.now() + 5 * 3600 * 1000); // Ташкент, UTC+5
  const res = await fetch(tasksUrl + "?t=" + Date.now());
  if (!res.ok) throw new Error("tasks.json: " + res.status);
  const tasks = await res.json();
  let list = (tasks.weekday?.[String(now.getUTCDay())] ?? []).slice();
  if (now.getUTCDate() === 1) list = list.concat(tasks.monthly1 ?? []);
  const core = list.filter((t: any) => t.core).map((t: any) => "• " + t.t);
  const rest = list.filter((t: any) => !t.core).map((t: any) => "• " + t.t);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const due = (tasks.deadlines ?? []).map((d: any) => {
    const [y, m, dd] = d.d.split("-").map(Number);
    return { t: d.t, left: Math.round((Date.UTC(y, m - 1, dd) - today) / 86400000) };
  }).filter((d: any) => d.left >= 0 && d.left <= 3)
    .map((d: any) => "• " + d.t + (d.left === 0 ? " (сегодня)" : " (осталось " + d.left + " дн.)"));
  const parts: string[] = [];
  if (core.length) parts.push("Главное:\n" + core.join("\n"));
  if (rest.length) parts.push("Ещё:\n" + rest.join("\n"));
  if (due.length) parts.push("Сроки:\n" + due.join("\n"));
  return {
    title: `${DOW[now.getUTCDay()]}, ${now.getUTCDate()} ${MON[now.getUTCMonth()]}: задач ${list.length}`,
    body: parts.join("\n\n"),
  };
}

async function sendTo(subs: any[], payload: unknown) {
  let sent = 0, removed = 0;
  const errors: string[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 43200, urgency: "high" },
      );
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.from("otani_push_subs").delete().eq("endpoint", s.endpoint);
        removed++;
      } else errors.push(String(e?.statusCode ?? e?.message ?? e));
    }
  }
  return { sent, removed, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    const c = await config();

    if (body.action === "subscribe") {
      const s = body.sub;
      if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: "Некорректная подписка" }, 400);
      const u = new URL(s.endpoint);
      if (u.protocol !== "https:" || !ALLOWED.some((r) => r.test(u.hostname))) return json({ error: "Неизвестный сервис уведомлений" }, 400);
      const { count } = await db.from("otani_push_subs").select("*", { count: "exact", head: true });
      const { data: exists } = await db.from("otani_push_subs").select("endpoint").eq("endpoint", s.endpoint).maybeSingle();
      if (!exists && (count ?? 0) >= 10) return json({ error: "Слишком много устройств" }, 429);
      const { error } = await db.from("otani_push_subs").upsert({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });
      if (error) throw error;
      return json({ ok: true });
    }

    if (body.action === "test") {
      const { data } = await db.from("otani_push_subs").select("*").eq("endpoint", body.endpoint ?? "");
      if (!data?.length) return json({ error: "Подписка не найдена" }, 404);
      const r = await sendTo(data, await buildMessage(c.tasks_url));
      if (!r.sent) return json({ error: "Сервис уведомлений отклонил запрос: " + r.errors.join(", ") }, 502);
      return json({ ok: true });
    }

    if (body.action === "daily") {
      if (!body.secret || body.secret !== c.cron_secret) return json({ error: "forbidden" }, 403);
      const { data } = await db.from("otani_push_subs").select("*");
      const r = await sendTo(data ?? [], await buildMessage(c.tasks_url));
      return json({ ok: true, ...r });
    }

    return json({ error: "Неизвестное действие" }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

// api/binance/orders.js — Vercel Serverless Function (Node runtime)
// Binance orders (lead-portfolio order-history) with 0.3s delay, retry, and compliant fallback.
// NOTE: 451 Restricted location => phải triển khai/hit upstream từ khu vực được phép theo Binance.

const ORDER_HISTORY_PATH =
  "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";

function apiBaseDirect() {
  return "https://www.binance.com";
}
function apiBaseProxy() {
  const via = process.env.BINANCE_PROXY_BASE || "";
  return via ? via.replace(/\/+$/, "") : "";
}

function n(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function uuid() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const a = require("crypto").randomBytes(16);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = a.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function buildHeaders() {
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${113 + Math.floor(Math.random()*12)}.0.0.0 Safari/537.36`;
  return {
    "User-Agent": ua,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
    "Origin": "https://www.binance.com",
    "Referer": "https://www.binance.com/",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "bnc-uuid": uuid(),
    "x-ui-request-trace": uuid(),
    "Cookie": "locale=en; country=VN",
  };
}

// low-level call: POST JSON & return text+status
async function callJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    redirect: "follow",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, text, json };
}

// try direct binance, then (if configured) fall back to your proxy base
async function callBinanceWithFallback(path, body, attempts = 3) {
  const errors = [];

  // attempt 1..N: direct
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(300 + Math.random()*150);
    const url = apiBaseDirect() + path;
    try {
      const r = await callJson(url, body);
      if (r.ok && r.json?.code === "000000" && r.json?.success === true) return { ok: true, json: r.json };
      errors.push({ where: "direct", status: r.status, body: r.text.slice(0, 220) });
      // 451/403: không tiếp tục spam
      if (r.status === 451 || r.status === 403) break;
    } catch (e) {
      errors.push({ where: "direct", error: String(e?.message || e) });
    }
  }

  // attempt 1..N: proxy (nếu có cấu hình & bạn triển khai ở region được phép)
  const proxy = apiBaseProxy();
  if (proxy) {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(300 + Math.random()*150);
      const url = proxy + path;
      try {
        const r = await callJson(url, body);
        if (r.ok && r.json?.code === "000000" && r.json?.success === true) return { ok: true, json: r.json, via: "proxy" };
        errors.push({ where: "proxy", status: r.status, body: r.text.slice(0, 220) });
        if (r.status === 451 || r.status === 403) break;
      } catch (e) {
        errors.push({ where: "proxy", error: String(e?.message || e) });
      }
    }
  }

  return { ok: false, errors };
}

async function fetchOrderHistory(pid, start, end) {
  const all = [];
  let indexValue;
  for (let page = 0; page < 3; page++) {
    await sleep(300);
    const body = { portfolioId: String(pid), startTime: n(start), endTime: n(end), pageSize: 30 };
    if (indexValue) body.indexValue = String(indexValue);

    const r = await callBinanceWithFallback(ORDER_HISTORY_PATH, body, 3);
    if (!r.ok) return { rows: all, error: r.errors || [{ where: "unknown", error: "Upstream failed" }] };

    const data = r.json?.data || {};
    const list = Array.isArray(data?.list) ? data.list : [];
    if (!list.length) break;
    all.push(...list);
    indexValue = data?.indexValue;
  }
  return { rows: all };
}

export default async function handler(req, res) {
  try {
    // optional internal API key
    const requiredKey = process.env.PROXY_INTERNAL_API_KEY || "";
    if (requiredKey) {
      const clientKey = req.headers["x-api-key"] || "";
      if (!clientKey || clientKey !== requiredKey) {
        return res.status(401).json({ success: false, error: "Unauthorized: invalid x-api-key" });
      }
    }

    const url = new URL(req.url, "http://localhost");
    const uids = (url.searchParams.get("uids") || "4438679961865098497")
      .split(",").map(s => s.trim()).filter(Boolean);

    const limit = n(url.searchParams.get("limit") || 50); // giữ tương thích
    const total = uids.length;
    const startIdx = Math.max(0, n(url.searchParams.get("cursor") || 0));
    const maxPerCall = Math.max(1, Math.min(35, n(url.searchParams.get("max") || 35)));
    const endIdx = Math.min(total, startIdx + maxPerCall);

    const now = Date.now();
    const defaultStart = now - 7*24*60*60*1000;
    const startTime = n(url.searchParams.get("startTime") || defaultStart);
    const endTime = n(url.searchParams.get("endTime") || now);

    const data = [];
    const errors = [];

    for (let i = startIdx; i < endIdx; i++) {
      const pid = uids[i]; // ở bản này coi uids là portfolioId
      const { rows, error } = await fetchOrderHistory(pid, startTime, endTime);
      if (error) errors.push({ uid: pid, error });
      data.push(...rows.map(r => ({ ...r, _uid: pid })));
    }

    // nếu toàn lỗi 451/403 → trả rõ ràng
    const flattened = errors.flatMap(e => e.error || []);
    const gotRestricted = flattened.some(e => e?.status === 451);
    const gotForbidden = flattened.some(e => e?.status === 403);

    return res
      .status(200)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .setHeader("Access-Control-Allow-Origin", "*")
      .json({
        success: data.length > 0,
        page: {
          start: startIdx,
          end: endIdx,
          total,
          maxPerCall,
          nextCursor: endIdx < total ? String(endIdx) : null,
          limitUsed: limit,
        },
        meta: {
          source: apiBaseProxy() ? "proxy->binance" : "binance",
          pagesPerPortfolio: 3,
          pageSize: 30,
          startTime,
          endTime,
        },
        data,
        errors: errors.length ? errors : undefined,
        notice: (gotRestricted || gotForbidden)
          ? "Upstream refused (403/451). Deploy and call from an eligible region and/or switch to official authenticated APIs per Binance Terms."
          : undefined,
      });
  } catch (e) {
    res
      .status(500)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .setHeader("Access-Control-Allow-Origin", "*")
      .json({ success: false, error: String(e?.message || e) });
  }
}

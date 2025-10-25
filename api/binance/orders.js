// api/binance/orders.js — Vercel Serverless Function (Node runtime)
// Binance 403 harden version: delay 0.3s + stronger fingerprint
// Optional proxy base (BINANCE_PROXY_BASE) nếu muốn route qua hop khác
//
// GET/POST /api/binance/orders?uids=4438679961865098497,....
// Query hỗ trợ (giữ tương thích):
//   - uids: CSV leadUid/portfolioId (nếu dài > 15 coi như portfolioId)
//   - cursor/max/limit: giữ để không breaking (không ảnh hưởng Binance)
//   - startTime/endTime: ms epoch; mặc định 7 ngày gần nhất
//
// Env (optional):
//   PROXY_INTERNAL_API_KEY  -> yêu cầu header x-api-key để hạn chế truy cập
//   BINANCE_PROXY_BASE      -> override "https://www.binance.com"
//
// Response:
//   { success: boolean, data: any[], errors?: any[] }

const ORDER_HISTORY_PATH =
  "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";
const PORTFOLIO_LIST_PATH =
  "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/list";

function apiBase() {
  const via = process.env.BINANCE_PROXY_BASE || "";
  return via ? via.replace(/\/+$/, "") : "https://www.binance.com";
}

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function uuid() {
  // Node 18+ có crypto.randomUUID
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  // fallback
  const a = require("crypto").randomBytes(16);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = a.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20
  )}-${h.slice(20)}`;
}

function buildHeaders() {
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
    113 + Math.floor(Math.random() * 12)
  }.0.0.0 Safari/537.36`;
  const ip = `45.${Math.floor(Math.random() * 200)}.${Math.floor(
    Math.random() * 200
  )}.${Math.floor(Math.random() * 200)}`;
  return {
    "User-Agent": ua,
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
    Origin: "https://www.binance.com",
    Referer: "https://www.binance.com/",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "bnc-uuid": uuid(),
    "x-ui-request-trace": uuid(),
    Cookie: "locale=en; country=VN",
    // spoof nhẹ (Vercel có thể override, nhưng thêm vẫn tốt)
    "X-Forwarded-For": ip,
  };
}

// ---- robust fetch with delay/retry ----
async function robustFetch(path, body, attempts = 3) {
  const base = apiBase();
  const url = base + path;
  const errors = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(200 + Math.random() * 150); // delay 0.3–0.45 s
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        redirect: "follow",
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.ok && json?.code === "000000") return { ok: true, json };
      errors.push({ status: res.status, body: text.slice(0, 200) });
    } catch (e) {
      errors.push({ error: String(e?.message || e) });
    }
  }
  return { ok: false, errors };
}

// (Giữ cho đúng bản CF bạn đưa — chỉ gọi order-history 3 trang; không cần list portfolio)
async function fetchOrderHistory(pid, start, end) {
  const all = [];
  let indexValue;
  for (let page = 0; page < 3; page++) {
    await sleep(300);
    const body = {
      portfolioId: String(pid),
      startTime: n(start),
      endTime: n(end),
      pageSize: 30,
    };
    if (indexValue) body.indexValue = String(indexValue);
    const r = await robustFetch(ORDER_HISTORY_PATH, body);
    if (!r.ok) return { rows: all, error: r.errors };
    const list = r.json?.data?.list || [];
    if (!list.length) break;
    all.push(...list);
    indexValue = r.json?.data?.indexValue;
  }
  return { rows: all };
}

export default async function handler(req, res) {
  try {
    // Optional: khóa nội bộ
    const requiredKey = process.env.PROXY_INTERNAL_API_KEY || "";
    if (requiredKey) {
      const clientKey = req.headers["x-api-key"] || "";
      if (!clientKey || clientKey !== requiredKey) {
        return res
          .status(401)
          .json({ success: false, error: "Unauthorized: invalid x-api-key" });
      }
    }

    // Lấy params
    const url = new URL(req.url, "http://localhost");
    const uids =
      (url.searchParams.get("uids") || "4438679961865098497")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [];

    // giữ tham số cũ (cursor/max/limit) để không breaking
    const limit = n(url.searchParams.get("limit") || 50);
    const total = uids.length;
    const startIdx = Math.max(0, n(url.searchParams.get("cursor") || 0));
    const maxPerCall = Math.max(1, Math.min(35, n(url.searchParams.get("max") || 35)));
    const endIdx = Math.min(total, startIdx + maxPerCall);

    // thời gian mặc định: 7 ngày gần nhất
    const now = Date.now();
    const defaultStart = now - 7 * 24 * 60 * 60 * 1000;
    const startTime = n(url.searchParams.get("startTime") || defaultStart);
    const endTime = n(url.searchParams.get("endTime") || now);

    const all = [];
    const errors = [];

    for (let i = startIdx; i < endIdx; i++) {
      const pidOrUid = uids[i];
      // Phiên bản bạn cung cấp dùng trực tiếp pid; không resolve leadUid -> portfolioId
      const { rows, error } = await fetchOrderHistory(pidOrUid, startTime, endTime);
      if (error) errors.push({ uid: pidOrUid, error });
      all.push(...rows.map((r) => ({ ...r, _uid: pidOrUid })));
    }

    const payload = {
      success: all.length > 0,
      page: {
        start: startIdx,
        end: endIdx,
        total,
        maxPerCall,
        nextCursor: endIdx < total ? String(endIdx) : null,
        limitUsed: limit,
      },
      meta: {
        source: process.env.BINANCE_PROXY_BASE ? "proxy->binance" : "binance",
        pagesPerPortfolio: 3,
        pageSize: 30,
        startTime,
        endTime,
      },
      data: all,
      errors: errors.length ? errors : undefined,
    };

    res
      .status(200)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .setHeader("Access-Control-Allow-Origin", "*")
      .json(payload);
  } catch (e) {
    res
      .status(500)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .setHeader("Access-Control-Allow-Origin", "*")
      .json({ success: false, error: String(e?.message || e) });
  }
}

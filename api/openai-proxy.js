// Vercel Serverless Function
// POST /api/openai-proxy  (được rewrite -> /v1/chat/completions)
// Env required: OPENAI_API_KEY
// Optional: PROXY_INTERNAL_API_KEY (để chặn gọi trái phép, dùng header x-api-key)
// Notes: pass-through status & body; giữ nguyên lỗi từ OpenAI

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Optional: shared key để chặn gọi trái phép
  const requiredKey = process.env.PROXY_INTERNAL_API_KEY || "";
  if (requiredKey) {
    const clientKey = req.headers["x-api-key"] || "";
    if (!clientKey || clientKey !== requiredKey) {
      return res.status(401).json({ error: "Unauthorized: invalid x-api-key" });
    }
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server misconfig: OPENAI_API_KEY not set" });
  }

  try {
    // Forward request to OpenAI
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body || {}),
    });

    // Pass-through status + payload
    const text = await upstream.text();
    // giữ content-type JSON nếu có thể
    res
      .status(upstream.status)
      .setHeader("Content-Type", upstream.headers.get("content-type") || "application/json")
      .send(text);
  } catch (e) {
    res.status(502).json({ error: `Proxy upstream error: ${e?.message || String(e)}` });
  }
}

// 用 DeepSeek 代呼 AI，金鑰只存在 Vercel 環境變數（DEEPSEEK_API_KEY），不會暴露給前端。
// 簡易流量閥門：每個 IP 每小時最多 RATE_LIMIT 次。這是單一 instance 的記憶體計數，
// 冷啟動會重置、不是跨機器共用的精準限流，但足夠擋住單純腳本狂打的濫用情境。

const RATE_LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .toString()
    .split(",")[0]
    .trim();

  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: "這個小時的生成次數用完了，請稍後再試" });
    return;
  }

  const prompt = req.body && req.body.prompt;
  if (!prompt || typeof prompt !== "string" || prompt.length > 8000) {
    res.status(400).json({ error: "提示詞內容有問題" });
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "後端還沒設定 API 金鑰，聯絡管理員" });
    return;
  }

  try {
    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(502).json({ error: (data && data.error && data.error.message) || "AI 服務暫時出錯" });
      return;
    }
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) {
      res.status(502).json({ error: "AI 沒有回傳內容，再試一次" });
      return;
    }
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: "連線失敗，稍後再試" });
  }
};

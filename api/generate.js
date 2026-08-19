// 用 DeepSeek 代呼 AI，金鑰只存在 Vercel 環境變數（DEEPSEEK_API_KEY），不會暴露給前端。
// 簡易流量閥門：每個 IP 每小時最多 RATE_LIMIT 次。這是單一 instance 的記憶體計數，
// 冷啟動會重置、不是跨機器共用的精準限流，但足夠擋住單純腳本狂打的濫用情境。

// AI30 文案方法論——刻意只放在後端，不讓前端拿到這段文字。
// 前端送來的 prompt 不含這段內容，這裡才組進去再送 DeepSeek，
// 使用者（連直接生成的 LINE／學員用戶）都看不到具體大綱寫了什麼，
// 只會感受到「AI 寫得比較好」；真正的大綱只鎖在方法論庫那頁給學員看。
const METHOD_PROMPT_BLOCK =
  "【AI30 文案方法論（每次都要套用，不用另外提醒）】\n" +
  "- 三有原則：這篇文案至少要命中「有用／有趣／有共鳴」其中一項，這是能不能發的最低標準。\n" +
  "- 開場鐵律：前 3 秒／首行定生死。直接打痛點或用反直覺切入，不要「大家好」「今天想跟大家分享」這種寒暄，也不要先鋪陳知識再講重點。\n" +
  "- 選題鉤子（八大爆款元素，挑 1–2 個融入標題或開頭就好，不要全塞）：花小錢辦大事／省時省力／外行不知道的秘密／名人話題／懷舊／對比（以前 vs 現在、有錢人 vs 小資族）／「最差」體驗／為某群人發聲。\n" +
  "- CTA 心法：結尾只給一個明確動作，禁止空泛的「歡迎關注」，給一個理由會更好（例如：留言告訴我，我挑常見問題來回答）。";

function injectMethodBlock(prompt) {
  if (prompt.indexOf("【寫作規則】") !== -1) {
    return prompt.replace("【寫作規則】", METHOD_PROMPT_BLOCK + "\n\n【寫作規則】");
  }
  return prompt + "\n\n" + METHOD_PROMPT_BLOCK;
}

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
        messages: [{ role: "user", content: injectMethodBlock(prompt) }],
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

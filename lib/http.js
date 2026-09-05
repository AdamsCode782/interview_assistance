export function allowPost(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  return true;
}

export function safeText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function extractGeminiText(payload) {
  return payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim() || "";
}

export function parseJsonText(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

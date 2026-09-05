import { extractGeminiText } from "./http.js";

export async function generateWithGemini({ system, prompt, json = true }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens: 1200,
        ...(json ? { responseMimeType: "application/json" } : {})
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.error?.message || `Gemini request failed with ${response.status}`;
    throw new Error(message);
  }
  return extractGeminiText(payload);
}

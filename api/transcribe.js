import { allowPost, safeText } from "../lib/http.js";

const MAX_BASE64_LENGTH = 5_600_000;

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "GROQ_API_KEY is not configured", code: "NOT_CONFIGURED" });

  const audio = safeText(req.body?.audio, MAX_BASE64_LENGTH + 1);
  const mimeType = safeText(req.body?.mimeType, 100) || "audio/webm";
  const context = safeText(req.body?.context, 1000);
  if (!audio || audio.length > MAX_BASE64_LENGTH) return res.status(400).json({ error: "Audio segment is missing or too large" });

  try {
    const bytes = Buffer.from(audio, "base64");
    const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), `segment.${extension}`);
    form.append("model", process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo");
    form.append("language", "en");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (context) form.append("prompt", context);

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `Transcription failed with ${response.status}`);
    res.status(200).json({ transcript: safeText(payload.text, 10000) });
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not transcribe audio" });
  }
}

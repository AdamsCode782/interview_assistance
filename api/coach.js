import { allowPost, parseJsonText, safeText } from "../lib/http.js";
import { generateWithGemini } from "../lib/gemini.js";
import { loadProfiles } from "../lib/profiles.js";

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;

  const utterance = safeText(req.body?.utterance, 5000);
  const recentTranscript = Array.isArray(req.body?.recentTranscript)
    ? req.body.recentTranscript.slice(-8).map(item => safeText(item, 2000)).filter(Boolean)
    : [];
  const role = safeText(req.body?.role, 300);
  const company = safeText(req.body?.company, 200);
  const focus = safeText(req.body?.focus, 50) || "automatic";
  const intensity = safeText(req.body?.intensity, 50) || "strong";
  const bulletCount = Math.min(6, Math.max(3, Number(req.body?.bulletCount) || 5));
  const forceQuestion = req.body?.forceQuestion === true;
  const briefing = req.body?.briefing && typeof req.body.briefing === "object" ? req.body.briefing : {};

  if (!utterance) return res.status(400).json({ error: "An utterance is required" });

  try {
    const profiles = loadProfiles();
    const system = `You are Adam Steele's live interview reference coach. Determine whether the newest utterance is an interviewer question or substantive prompt. Ignore Adam's answers, acknowledgments, filler, and incomplete fragments. When it is a question, surface the strongest credible experience and terminology for the target role. Follow the boundaries exactly. Never undermine Adam. ${forceQuestion ? "The user manually requested guidance for this utterance, so treat it as a question or substantive prompt." : ""} Return valid JSON only.`;
    const prompt = `TARGET\nCompany: ${company || "Not specified"}\nRole: ${role || "Not specified"}\nFocus: ${focus}\nFraming intensity: ${intensity}\nPrepared briefing: ${JSON.stringify(briefing)}\n\nRECENT UTTERANCES (oldest first)\n${recentTranscript.map((line, index) => `${index + 1}. ${line}`).join("\n") || "None"}\n\nNEWEST UTTERANCE\n${utterance}\n\nEXPERIENCE AND RULES\n${JSON.stringify(profiles)}\n\nReturn exactly this JSON shape:\n{\n  "isQuestion": true or false,\n  "confidence": 0 to 100,\n  "question": "cleaned question or empty string",\n  "lead": "short lead-with instruction or empty string",\n  "profile": "Software Engineering, AI & Data, DevOps & Platform, or empty string",\n  "match": 0 to 100,\n  "bullets": ["exactly ${bulletCount} concise reference bullets when isQuestion is true"],\n  "detail": "brief optional support or empty string"\n}`;
    const text = await generateWithGemini({ system, prompt });
    const result = parseJsonText(text);
    result.bullets = Array.isArray(result.bullets) ? result.bullets.slice(0, bulletCount) : [];
    res.status(200).json(result);
  } catch (error) {
    if (String(error.message).includes("GEMINI_API_KEY")) return res.status(503).json({ error: "GEMINI_API_KEY is not configured", code: "NOT_CONFIGURED" });
    res.status(502).json({ error: error.message || "Could not generate interview guidance" });
  }
}

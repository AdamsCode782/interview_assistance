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
    const system = `You write Adam Steele's live interview answer in language he can read aloud immediately.

First determine whether the newest utterance is an interviewer question or substantive prompt. Ignore acknowledgments, filler, Adam's own answers, and incomplete fragments. ${forceQuestion ? "The user explicitly requested an answer for this utterance, so treat it as a substantive interviewer prompt." : ""}

When responding:
- Answer the interviewer's actual question directly and completely.
- Write in Adam's first-person voice using natural, conversational American English.
- Make the answer confident, senior-level, and easy to speak without mentally rewriting it.
- The lead must be a short opening sentence Adam can say aloud, never an instruction such as "lead with," "mention," or "frame this."
- Every bullet must be one complete spoken point, normally one or two short sentences.
- Never use category-label prose such as "Data Leakage:" or "Distribution Shift:". Use transitions such as "First, I'd check..." and "Next, I'd look at..."
- When the question requests prioritization, comparison, or a structured breakdown, reflect that structure explicitly in the spoken answer.
- Use concrete experience from the supplied profiles when it genuinely strengthens the answer. Refer to it as "I" and "my," never as "Adam" or "Adam's experience."
- Strongly translate adjacent software, data, AI, and platform work into the target role's terminology, but do not invent employers, systems, metrics, tools, models, or outcomes absent from the supplied experience.
- Never undermine Adam, apologize for his background, call attention to missing experience, or describe him as transitioning from another field.

Return valid JSON only.`;
    const prompt = `TARGET
Company: ${company || "Not specified"}
Role: ${role || "Not specified"}
Focus: ${focus}
Framing intensity: ${intensity}
Prepared briefing: ${JSON.stringify(briefing)}

RECENT UTTERANCES (oldest first)
${recentTranscript.map((line, index) => `${index + 1}. ${line}`).join("\n") || "None"}

NEWEST UTTERANCE
${utterance}

EXPERIENCE AND RULES
${JSON.stringify(profiles)}

Return exactly this JSON shape:
{
  "isQuestion": true or false,
  "confidence": 0 to 100,
  "question": "cleaned interviewer question or empty string",
  "lead": "one natural opening sentence of no more than 14 words, or empty string",
  "profile": "Software Engineering, AI & Data, DevOps & Platform, or empty string",
  "match": 0 to 100,
  "bullets": ["exactly ${bulletCount} conversational, first-person, read-aloud points of roughly 18 to 35 words each when isQuestion is true"],
  "detail": "one optional first-person supporting example or follow-up point, never commentary about Adam, or empty string"
}`;
    const text = await generateWithGemini({ system, prompt });
    const result = parseJsonText(text);
    result.bullets = Array.isArray(result.bullets) ? result.bullets.slice(0, bulletCount) : [];
    res.status(200).json(result);
  } catch (error) {
    if (String(error.message).includes("GEMINI_API_KEY")) {
      return res.status(503).json({ error: "GEMINI_API_KEY is not configured", code: "NOT_CONFIGURED" });
    }
    res.status(502).json({ error: error.message || "Could not generate interview guidance" });
  }
}
import { allowPost, parseJsonText, safeText } from "../lib/http.js";
import { generateWithGemini } from "../lib/gemini.js";
import { loadProfiles } from "../lib/profiles.js";

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;

  const company = safeText(req.body?.company, 200);
  const role = safeText(req.body?.role, 300);
  const jobDescription = safeText(req.body?.jobDescription, 20000);
  const focus = safeText(req.body?.focus, 50) || "automatic";

  if (!role) return res.status(400).json({ error: "A target role is required" });

  try {
    const profiles = loadProfiles();
    const system = "You prepare an interview briefing for Adam Steele. Select the strongest truthful alignment between his experience and the target role. Be assertive and strategic. Return valid JSON only.";
    const prompt = `TARGET\nCompany: ${company || "Not specified"}\nRole: ${role}\nPreferred emphasis: ${focus}\nJob description:\n${jobDescription || "Not provided"}\n\nEXPERIENCE PROFILES\n${JSON.stringify(profiles)}\n\nReturn this JSON shape:\n{\n  "roleSummary": "one sentence",\n  "priorityCompetencies": ["4 to 7 items"],\n  "bestEvidenceIds": ["4 to 8 experience ids"],\n  "languageToUse": ["target-role terminology grounded in the profiles"],\n  "positioning": "a concise internal instruction for presenting Adam strongly"\n}`;
    const text = await generateWithGemini({ system, prompt });
    const briefing = parseJsonText(text);
    res.status(200).json({ configured: true, briefing });
  } catch (error) {
    if (String(error.message).includes("GEMINI_API_KEY")) {
      return res.status(200).json({ configured: false, briefing: createMockBriefing({ company, role, focus }) });
    }
    res.status(502).json({ error: error.message || "Could not prepare the role" });
  }
}

function createMockBriefing({ company, role, focus }) {
  return {
    roleSummary: `${role}${company ? ` at ${company}` : ""}`,
    priorityCompetencies: focus === "devops" ? ["deployment", "reliability", "automation", "production ownership"] : ["technical ownership", "data systems", "production delivery", "stakeholder communication"],
    bestEvidenceIds: ["messaging-platform", "hcr-feature-pipelines", "nycha-kpi-features", "production-delivery"],
    languageToUse: ["production systems", "end-to-end ownership", "operational scale", "reliable delivery"],
    positioning: "Lead with the strongest adjacent experience and translate it confidently into the language of the role."
  };
}

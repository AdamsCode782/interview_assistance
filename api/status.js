export default function handler(req, res) {
  res.status(200).json({
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    transcriptionModel: process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo",
    coachingModel: process.env.GEMINI_MODEL || "gemini-3.6-flash"
  });
}

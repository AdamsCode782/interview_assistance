# Interview Reference

A mobile-first vanilla JavaScript PWA for experience-aware interview reference prompts.

## Included

- Five-screen interview flow
- Responsive desktop and mobile layouts
- Local interview setup persistence
- Real microphone permission and input meter
- Required on-device speaker enrollment and voiceprint storage
- Local speaker verification before any transcription request
- Voice-activity detection and automatic utterance capture
- Groq Whisper transcription adapter
- Gemini role preparation, question detection, and coaching adapter
- Structured Software Engineering, AI/Data, and DevOps experience profiles
- Strong-framing rules and explicit claim boundaries
- Mock responses whenever API keys are absent
- Session history
- Installable PWA shell

## Configure and deploy

1. Create a Groq API key, a Gemini API key, and a free Picovoice AccessKey.
2. Import this folder into a private GitHub repository or deploy it through the Vercel CLI.
3. Add these Vercel environment variables:

   - `GROQ_API_KEY`
   - `GEMINI_API_KEY`
   - `GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo`
   - `GEMINI_MODEL=gemini-3.6-flash`

4. Deploy, open the HTTPS URL on the phone, and allow microphone access.
5. On **Audio check**, paste the Picovoice AccessKey and complete the required voice enrollment. The key and voiceprint are stored only in that browser.
6. Add the PWA to the phone's home screen.

Use `npm run dev` for local API development after installing the Vercel CLI. Without API keys, the interface stays in preview mode and the **Answer this** button cycles through realistic mock responses.

## First testing targets

- Adjust the voice-activity threshold and silence duration for the phone and room.
- Confirm the computer speaker is transcribed consistently at normal volume.
- Speak several test answers and confirm they show as **Your voice ignored** without reaching transcription.
- Play interviewer audio and confirm it passes the speaker check. Re-enroll in the actual room if separation is inconsistent.
- Measure time from the end of a question to the first displayed reference.
- Review false triggers during Adam's answers.
- Strengthen profile details when a mock interview reveals a missing technical example.

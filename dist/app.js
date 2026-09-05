const STORAGE_KEY = "interview-reference-state-v1";

const defaultState = {
  company: "",
  role: "",
  jobDescription: "",
  focus: "automatic",
  intensity: "strong",
  bulletCount: 5,
  briefing: null,
  recentTranscript: [],
  history: []
};

const mockQuestions = [
  {
    question: "Tell me about a time you built a difficult data pipeline and how you ensured the data was reliable.",
    lead: "Lead with the HCR housing-data platform",
    profile: "AI & Data",
    match: 96,
    bullets: [
      "Built Python and SQL pipelines joining Census data with internal records for 1M+ housing units",
      "Standardized inconsistent identifiers and schemas before downstream analysis",
      "Turned raw administrative data into modeling inputs for displacement risk and rent trajectories",
      "Powered production dashboards and GIS tools used across agency teams",
      "Connect reliability to validation rules, repeatable transformations, and stakeholder review"
    ],
    detail: "Frame this as the full data layer surrounding applied ML: ingestion, normalization, feature construction, validation, and operational delivery. Be ready to explain how you reconciled inconsistent geographic and housing identifiers."
  },
  {
    question: "Describe how you have deployed and maintained an application used at meaningful scale.",
    lead: "Use the 30,000-user messaging platform",
    profile: "DevOps & Platform",
    match: 92,
    bullets: [
      "Shipped and supported a real-time platform serving 30,000+ founders and investors",
      "Owned production behavior across messaging, group chat, SQL-backed workflows, and automated moderation",
      "Handled iterative releases while protecting an active user community",
      "Tie deployment decisions to reliability, database performance, and safe operational changes",
      "Emphasize end-to-end ownership rather than a narrow frontend contribution"
    ],
    detail: "Use concrete deployment, monitoring, incident, and rollback details from the project when answering. The platform scale establishes that the work operated under real production constraints."
  },
  {
    question: "How would your software engineering background help you succeed in an applied machine learning role?",
    lead: "Connect production engineering to the ML lifecycle",
    profile: "AI & Data",
    match: 94,
    bullets: [
      "Built the ingestion and transformation systems that make trustworthy modeling possible",
      "Developed risk and trajectory models using large administrative and Census datasets",
      "Implemented AI-assisted journaling and high-risk sentiment detection in a student wellbeing product",
      "Bring production rigor: APIs, validation, testing, deployment, and user-facing integration",
      "Position SWE depth as the advantage that moves models from experiments into usable systems"
    ],
    detail: "Do not treat the transition as starting over. Your differentiator is combining analytical training and data work with the ability to ship the surrounding product and platform."
  }
];

let state = loadState();
let microphoneStream = null;
let audioContext = null;
let analyser = null;
let meterFrame = null;
let sessionStartedAt = null;
let sessionTimer = null;
let mockIndex = 0;
let installPrompt = null;
let wakeLock = null;
let apiStatus = { groqConfigured: false, geminiConfigured: false };
let vadFrame = null;
let liveRecorder = null;
let utteranceStartedAt = null;
let silenceStartedAt = null;
let processingQueue = Promise.resolve();
let lastUtterance = "";
let microphoneChecked = false;
let enrollmentActive = false;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function loadState() {
  try {
    return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateHome();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function routeTo(route) {
  const target = document.querySelector(`[data-screen="${route}"]`);
  if (!target) return;
  $$(".screen").forEach(screen => screen.classList.toggle("active", screen === target));
  $$(".nav-item, .bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.route === route));
  history.replaceState(null, "", `#${route}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (route === "history") renderHistory();
  if (route === "live") updateLiveContext();
}

function bindNavigation() {
  $$('[data-route]').forEach(button => button.addEventListener("click", () => routeTo(button.dataset.route)));
}

function hydrateSetup() {
  $("#companyInput").value = state.company;
  $("#roleInput").value = state.role;
  $("#jobDescriptionInput").value = state.jobDescription;
  $("#intensityInput").value = state.intensity;
  $("#bulletCountInput").value = String(state.bulletCount);
  const focus = document.querySelector(`input[name="focus"][value="${state.focus}"]`);
  if (focus) focus.checked = true;
}

function updateHome() {
  $("#recentRole").textContent = state.role || "Machine Learning Engineer";
  $("#recentCompany").textContent = state.company ? `${state.company} · Draft` : "Sample role · Draft";
}

function bindSetup() {
  $("#setupForm").addEventListener("submit", async event => {
    event.preventDefault();
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    const data = new FormData(event.currentTarget);
    state = {
      ...state,
      company: data.get("company").trim(),
      role: data.get("role").trim(),
      jobDescription: data.get("jobDescription").trim(),
      focus: data.get("focus"),
      intensity: data.get("intensity"),
      bulletCount: Number(data.get("bulletCount"))
    };
    saveState();
    submitButton.disabled = true;
    submitButton.textContent = "Preparing role...";
    try {
      const response = await fetch("/api/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: state.company, role: state.role, jobDescription: state.jobDescription, focus: state.focus })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not prepare the role");
      state.briefing = payload.briefing;
      saveState();
      showToast(payload.configured ? "Role briefing prepared" : "Setup saved in preview mode");
    } catch {
      state.briefing = null;
      saveState();
      showToast("Setup saved. Briefing will prepare after deployment.");
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = "Save and check audio <span>→</span>";
    }
    routeTo("audio");
  });
}

async function startMicrophoneCheck() {
  if (microphoneStream) {
    stopMicrophone();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    $("#micStatus").textContent = "Microphone is unavailable";
    $("#micHelp").textContent = "This browser does not support microphone capture.";
    $("#permissionStatus").textContent = "Unsupported";
    return;
  }

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(microphoneStream).connect(analyser);
    $("#micOrbit").classList.add("active");
    $("#micStatus").textContent = "Listening clearly";
    $("#micHelp").textContent = "Speak, then play a question through your computer speakers.";
    $("#permissionStatus").textContent = "Allowed";
    $("#permissionStatus").style.color = "var(--green)";
    $("#micButton").textContent = "Stop microphone check";
    microphoneChecked = true;
    updateEnrollmentUI();
    updateMeter();
  } catch (error) {
    $("#micStatus").textContent = "Microphone access was blocked";
    $("#micHelp").textContent = "Allow microphone access in your browser settings, then try again.";
    $("#permissionStatus").textContent = "Blocked";
    $("#permissionStatus").style.color = "var(--danger)";
  }
}

function updateMeter() {
  if (!analyser) return;
  const values = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(values);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const level = Math.min(100, Math.max(2, average * 1.25));
  $("#meterFill").style.width = `${level}%`;
  $("#micOrbit").style.transform = `scale(${1 + level / 1600})`;
  meterFrame = requestAnimationFrame(updateMeter);
}

function stopMicrophone() {
  microphoneStream?.getTracks().forEach(track => track.stop());
  microphoneStream = null;
  analyser = null;
  if (meterFrame) cancelAnimationFrame(meterFrame);
  audioContext?.close();
  audioContext = null;
  $("#micOrbit").classList.remove("active");
  $("#micOrbit").style.transform = "";
  $("#meterFill").style.width = "0%";
  $("#micStatus").textContent = "Microphone check complete";
  $("#micHelp").textContent = "Your browser can access the microphone.";
  $("#micButton").textContent = "Check microphone again";
}

function updateEnrollmentUI() {
  const enrolled = window.SpeakerEnrollment?.hasProfile();
  const badge = $("#enrollmentBadge");
  badge.textContent = enrolled ? "Enrolled" : "Not enrolled";
  badge.classList.toggle("success", enrolled);
  $("#speakerStatus").textContent = enrolled ? "Ready" : "Required";
  $("#speakerStatus").style.color = enrolled ? "var(--green)" : "var(--danger)";
  $("#resetVoice").hidden = !enrolled;
  $("#testVoice").hidden = !enrolled;
  $("#picovoiceKeyField").hidden = enrolled;
  if (enrolled && !enrollmentActive) {
    $("#enrollmentHelp").textContent = "Your local voiceprint is ready. Speech matching you will be discarded before transcription.";
    $("#enrollmentPrompt").textContent = "Voice separation is active on this device.";
    $("#enrollmentProgress").setAttribute("aria-valuenow", "100");
    $("#enrollmentProgress span").style.width = "100%";
    $("#enrollVoice").textContent = "Re-enroll my voice";
  }
  $("#continueLive").disabled = !(microphoneChecked && enrolled);
}

async function testSpeakerSeparation() {
  const button = $("#testVoice");
  stopMicrophone();
  button.disabled = true;
  button.textContent = "Listening for 4 seconds…";
  $("#enrollmentPrompt").textContent = "Speak yourself, or play a sample from the computer now.";
  let stream;
  try {
    await window.SpeakerEnrollment.initializeRecognizer();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const mimeType = preferredAudioType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.addEventListener("dataavailable", event => {
      if (event.data.size) chunks.push(event.data);
    });
    const stopped = new Promise(resolve => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 4000));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    const result = await window.SpeakerEnrollment.classifyBlob(blob);
    const percentage = Math.round(result.score * 100);
    microphoneChecked = true;
    updateEnrollmentUI();
    $("#enrollmentPrompt").textContent = result.isEnrolledSpeaker
      ? `Matched your voice at ${percentage}% — this audio would be ignored.`
      : `Classified as another speaker at ${percentage}% match — this audio would be transcribed.`;
  } catch (error) {
    $("#enrollmentPrompt").textContent = error.message || "The speaker test failed. Try again in a quieter room.";
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    button.disabled = false;
    button.textContent = "Test one voice";
  }
}

async function toggleEnrollment() {
  if (enrollmentActive) {
    window.SpeakerEnrollment.cancelEnrollment();
    enrollmentActive = false;
    $("#enrollVoice").textContent = window.SpeakerEnrollment.hasProfile() ? "Re-enroll my voice" : "Start voice enrollment";
    $("#micOrbit").classList.remove("active");
    showToast("Voice enrollment stopped");
    return;
  }

  const accessKey = $("#picovoiceKey").value.trim() || window.SpeakerEnrollment.getAccessKey();
  if (!accessKey) {
    showToast("Paste a Picovoice AccessKey first");
    $("#picovoiceKey").focus();
    return;
  }

  stopMicrophone();
  enrollmentActive = true;
  $("#enrollVoice").textContent = "Stop enrollment";
  $("#enrollmentBadge").textContent = "Listening";
  $("#enrollmentHelp").textContent = "Keep speaking naturally until the progress reaches 100%. Use a quiet room and only your voice.";
  $("#enrollmentPrompt").textContent = "Describe a project: the goal, what you built, a difficult decision, and the result.";
  $("#micOrbit").classList.add("active");
  try {
    await window.SpeakerEnrollment.enroll({
      accessKey,
      onProgress: percentage => {
        $("#enrollmentProgress").setAttribute("aria-valuenow", String(percentage));
        $("#enrollmentProgress span").style.width = `${percentage}%`;
        $("#enrollmentBadge").textContent = `${percentage}%`;
        if (percentage >= 35 && percentage < 70) $("#enrollmentPrompt").textContent = "Now explain a technical challenge and how you solved it.";
        if (percentage >= 70) $("#enrollmentPrompt").textContent = "Finish with the outcome and what you learned.";
      },
      onMeter: level => {
        $("#meterFill").style.width = `${Math.max(2, level)}%`;
        $("#micOrbit").style.transform = `scale(${1 + level / 1600})`;
      }
    });
    microphoneChecked = true;
    $("#permissionStatus").textContent = "Allowed";
    $("#permissionStatus").style.color = "var(--green)";
    showToast("Voice enrollment complete");
  } catch (error) {
    if (error.message !== "Enrollment stopped.") showToast(error.message || "Voice enrollment failed");
  } finally {
    enrollmentActive = false;
    $("#micOrbit").classList.remove("active");
    $("#micOrbit").style.transform = "";
    $("#meterFill").style.width = "0%";
    updateEnrollmentUI();
  }
}

function bindAudio() {
  $("#micButton").addEventListener("click", startMicrophoneCheck);
  $("#picovoiceKey").value = window.SpeakerEnrollment?.getAccessKey() || "";
  $("#picovoiceKey").addEventListener("change", event => window.SpeakerEnrollment.saveAccessKey(event.target.value));
  $("#enrollVoice").addEventListener("click", toggleEnrollment);
  $("#testVoice").addEventListener("click", testSpeakerSeparation);
  $("#resetVoice").addEventListener("click", async () => {
    await window.SpeakerEnrollment.reset();
    $("#enrollmentProgress").setAttribute("aria-valuenow", "0");
    $("#enrollmentProgress span").style.width = "0%";
    $("#enrollmentHelp").textContent = "Read naturally for about 20–30 seconds. Your voiceprint stays on this device.";
    $("#enrollmentPrompt").textContent = "When prompted, describe a project you are proud of in your normal interview voice.";
    updateEnrollmentUI();
    showToast("Voiceprint removed from this device");
  });
  $("#continueLive").addEventListener("click", () => {
    stopMicrophone();
    routeTo("live");
  });
  updateEnrollmentUI();
}

function updateLiveContext() {
  const role = state.role || "Mock interview";
  const company = state.company ? ` · ${state.company}` : "";
  $("#liveContext").textContent = `${role}${company}`;
  const ready = apiStatus.groqConfigured && apiStatus.geminiConfigured;
  if (!document.body.classList.contains("live-running")) $("#matchPill").textContent = ready ? "AI ready" : "Mock mode";
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Wake lock is an enhancement; the session can continue without it.
  }
}

async function startSession() {
  if (!window.SpeakerEnrollment?.hasProfile()) {
    routeTo("audio");
    showToast("Enroll your voice before starting a session");
    return;
  }
  sessionStartedAt = Date.now();
  document.body.classList.add("live-running");
  const ready = apiStatus.groqConfigured && apiStatus.geminiConfigured;
  $("#liveStateText").textContent = ready ? "Starting microphone" : "Preview listening";
  $("#toggleSession").textContent = "End session";
  sessionTimer = setInterval(updateClock, 1000);
  requestWakeLock();
  updateClock();
  if (ready) {
    try {
      await window.SpeakerEnrollment.initializeRecognizer();
      await startLiveCapture();
      $("#liveStateText").textContent = "Listening";
      showToast("Live listening started");
    } catch {
      $("#liveStateText").textContent = "Microphone blocked";
      showToast("Allow microphone access, then resume the session");
      endSession();
    }
  } else {
    showToast("Preview session started. Use Answer this for mock questions.");
  }
}

function endSession() {
  document.body.classList.remove("live-running");
  $("#liveStateText").textContent = "Paused";
  $("#toggleSession").textContent = "Resume session";
  clearInterval(sessionTimer);
  sessionTimer = null;
  stopLiveCapture();
  window.SpeakerEnrollment?.releaseRecognizer();
  wakeLock?.release();
  wakeLock = null;
}

function updateClock() {
  if (!sessionStartedAt) return;
  const elapsed = Math.floor((Date.now() - sessionStartedAt) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  $("#sessionClock").textContent = `${minutes}:${seconds}`;
}

function generateMockAnswer() {
  const item = mockQuestions[mockIndex % mockQuestions.length];
  mockIndex += 1;
  const bullets = item.bullets.slice(0, state.bulletCount || 5);
  $("#answerLabel").textContent = item.profile;
  $("#matchPill").textContent = `${item.match}% match`;
  $("#liveTitle").textContent = item.lead;
  $("#answerBullets").innerHTML = bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join("");
  $("#transcriptCopy").textContent = `“${item.question}”`;
  $("#transcriptTime").textContent = "Just now";
  $("#supportingDetail").textContent = item.detail;
  $("#supportingDetail").hidden = true;
  $("#detailToggle").hidden = false;
  $("#detailToggle").setAttribute("aria-expanded", "false");
  $("#detailToggle").textContent = "Show supporting detail";

  state.history.unshift({
    question: item.question,
    lead: item.lead,
    profile: item.profile,
    match: item.match,
    timestamp: new Date().toISOString()
  });
  state.history = state.history.slice(0, 20);
  saveState();
}

function preferredAudioType() {
  const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return types.find(type => window.MediaRecorder?.isTypeSupported(type)) || "";
}

async function startLiveCapture() {
  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(microphoneStream).connect(analyser);
  monitorSpeech();
}

function monitorSpeech() {
  if (!analyser || !sessionTimer) return;
  const values = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(values);
  const rms = Math.sqrt(values.reduce((sum, value) => {
    const normalized = (value - 128) / 128;
    return sum + normalized * normalized;
  }, 0) / values.length);
  const now = performance.now();
  const speaking = rms > 0.025;

  if (speaking) {
    silenceStartedAt = null;
    if (!liveRecorder) beginUtterance();
  } else if (liveRecorder) {
    silenceStartedAt ||= now;
    if ((now - silenceStartedAt > 900 && now - utteranceStartedAt > 650) || now - utteranceStartedAt > 25000) finishUtterance();
  }
  vadFrame = requestAnimationFrame(monitorSpeech);
}

function beginUtterance() {
  const mimeType = preferredAudioType();
  const chunks = [];
  const recorder = new MediaRecorder(microphoneStream, mimeType ? { mimeType } : undefined);
  liveRecorder = recorder;
  utteranceStartedAt = performance.now();
  recorder.addEventListener("dataavailable", event => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    if (liveRecorder === recorder) liveRecorder = null;
    utteranceStartedAt = null;
    silenceStartedAt = null;
    if (blob.size > 1000) processingQueue = processingQueue.then(() => processUtterance(blob)).catch(handleProcessingError);
  }, { once: true });
  recorder.start();
}

function finishUtterance() {
  if (liveRecorder?.state === "recording") liveRecorder.stop();
}

function stopLiveCapture() {
  if (vadFrame) cancelAnimationFrame(vadFrame);
  vadFrame = null;
  if (liveRecorder?.state === "recording") liveRecorder.stop();
  liveRecorder = null;
  microphoneStream?.getTracks().forEach(track => track.stop());
  microphoneStream = null;
  analyser = null;
  audioContext?.close();
  audioContext = null;
}

async function processUtterance(blob) {
  $("#liveStateText").textContent = "Checking speaker · audio stays local";
  const speaker = await window.SpeakerEnrollment.classifyBlob(blob);
  if (speaker.isEnrolledSpeaker) {
    $("#liveStateText").textContent = "Your voice ignored · still listening";
    $("#transcriptCopy").textContent = "Your voice was detected and was not sent for transcription.";
    $("#transcriptTime").textContent = `${Math.round(speaker.score * 100)}% voice match`;
    setTimeout(() => {
      if (sessionTimer) $("#liveStateText").textContent = "Listening";
    }, 900);
    return;
  }
  $("#liveStateText").textContent = "Transcribing · still listening";
  const audio = await blobToBase64(blob);
  const transcriptionResponse = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio, mimeType: blob.type, context: state.recentTranscript.slice(-2).join(" ") })
  });
  const transcription = await transcriptionResponse.json();
  if (!transcriptionResponse.ok) throw new Error(transcription.error || "Transcription failed");
  const utterance = transcription.transcript?.trim();
  if (!utterance) return;

  lastUtterance = utterance;
  state.recentTranscript = [...state.recentTranscript, utterance].slice(-8);
  saveState();
  $("#transcriptCopy").textContent = `“${utterance}”`;
  $("#transcriptTime").textContent = "Just now";
  $("#liveStateText").textContent = "Checking question · still listening";
  await requestCoach(utterance, false);
  if (sessionTimer) $("#liveStateText").textContent = "Listening";
}

async function requestCoach(utterance, forceQuestion) {
  const response = await fetch("/api/coach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      utterance,
      forceQuestion,
      recentTranscript: state.recentTranscript.slice(0, -1),
      company: state.company,
      role: state.role,
      focus: state.focus,
      intensity: state.intensity,
      bulletCount: state.bulletCount,
      briefing: state.briefing
    })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Coaching failed");
  if (result.isQuestion) renderCoachResult(result);
}

function renderCoachResult(result) {
  $("#answerLabel").textContent = result.profile || "Reference";
  $("#matchPill").textContent = `${Math.round(result.match || result.confidence || 0)}% match`;
  $("#liveTitle").textContent = result.lead || "Use your strongest relevant example";
  $("#answerBullets").innerHTML = (result.bullets || []).map(bullet => `<li>${escapeHtml(bullet)}</li>`).join("");
  $("#transcriptCopy").textContent = `“${result.question || lastUtterance}”`;
  $("#transcriptTime").textContent = "Just now";
  $("#supportingDetail").textContent = result.detail || "";
  $("#supportingDetail").hidden = true;
  $("#detailToggle").hidden = !result.detail;
  $("#detailToggle").setAttribute("aria-expanded", "false");
  $("#detailToggle").textContent = "Show supporting detail";
  state.history.unshift({
    question: result.question || lastUtterance,
    lead: result.lead || "Relevant experience",
    profile: result.profile || "Blended",
    match: Math.round(result.match || result.confidence || 0),
    timestamp: new Date().toISOString()
  });
  state.history = state.history.slice(0, 20);
  saveState();
}

function handleProcessingError(error) {
  console.error(error);
  if (sessionTimer) $("#liveStateText").textContent = "Listening";
  showToast(error.message || "Could not process that audio segment");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dismissAnswer() {
  $("#answerLabel").textContent = "Reference";
  $("#matchPill").textContent = "Listening";
  $("#liveTitle").textContent = "Listening for the next question.";
  $("#answerBullets").innerHTML = "<li>Your current reference has been cleared.</li>";
  $("#transcriptCopy").textContent = "The latest detected question will appear here.";
  $("#transcriptTime").textContent = "Waiting";
  $("#detailToggle").hidden = true;
  $("#supportingDetail").hidden = true;
}

function bindLive() {
  $("#toggleSession").addEventListener("click", () => sessionTimer ? endSession() : startSession());
  $("#answerNow").addEventListener("click", async () => {
    if (apiStatus.geminiConfigured && lastUtterance) {
      try {
        await requestCoach(lastUtterance, true);
      } catch (error) {
        handleProcessingError(error);
      }
    } else {
      generateMockAnswer();
    }
  });
  $("#dismissAnswer").addEventListener("click", dismissAnswer);
  $("#detailToggle").addEventListener("click", event => {
    const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
    event.currentTarget.setAttribute("aria-expanded", String(!expanded));
    event.currentTarget.textContent = expanded ? "Show supporting detail" : "Hide supporting detail";
    $("#supportingDetail").hidden = expanded;
  });
  document.addEventListener("keydown", event => {
    if (!$('[data-screen="live"]').classList.contains("active")) return;
    if (event.key.toLowerCase() === "a") generateMockAnswer();
    if (event.key.toLowerCase() === "d") dismissAnswer();
  });
}

async function checkApiStatus() {
  try {
    const response = await fetch("/api/status");
    if (response.ok) apiStatus = await response.json();
  } catch {
    apiStatus = { groqConfigured: false, geminiConfigured: false };
  }
  updateLiveContext();
}

function renderHistory() {
  const list = $("#historyList");
  const items = state.history || [];
  $("#questionCount").textContent = items.length;
  $("#averageMatch").textContent = items.length ? `${Math.round(items.reduce((sum, item) => sum + item.match, 0) / items.length)}%` : "—";
  if (items.length) {
    const profiles = items.reduce((counts, item) => ({ ...counts, [item.profile]: (counts[item.profile] || 0) + 1 }), {});
    $("#topProfile").textContent = Object.entries(profiles).sort((a, b) => b[1] - a[1])[0][0];
  } else {
    $("#topProfile").textContent = "—";
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-mark">?</span><h2>No questions yet</h2><p>Run a mock question from the live screen and it will be saved here.</p><button class="secondary-button" type="button" data-route="live">Open live mode</button></div>`;
    list.querySelector("[data-route]").addEventListener("click", () => routeTo("live"));
    return;
  }

  list.innerHTML = items.map((item, index) => {
    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<article class="history-item"><span class="history-number">${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.lead)} · ${escapeHtml(item.profile)} · ${item.match}% match</p></div><time>${time}</time></article>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    $("#installButton").hidden = false;
  });
  $("#installButton").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("#installButton").hidden = true;
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js"));
}

function init() {
  bindNavigation();
  bindSetup();
  bindAudio();
  bindLive();
  hydrateSetup();
  updateHome();
  setupInstallPrompt();
  registerServiceWorker();
  checkApiStatus();
  routeTo(location.hash.slice(1) || "home");
}

init();

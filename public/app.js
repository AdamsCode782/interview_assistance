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

let state = loadState();
let microphoneStream = null;
let audioContext = null;
let analyser = null;
let meterFrame = null;
let sessionStartedAt = null;
let sessionTimer = null;
let installPrompt = null;
let wakeLock = null;
let apiStatus = { groqConfigured: false, geminiConfigured: false };
let liveSource = null;
let pcmProcessor = null;
let silentOutput = null;
let activeTurn = null;
let preRollBlocks = [];
let preRollSampleCount = 0;
let noiseFloor = 0.008;
let turnSequence = 0;
let audioChunkQueue = Promise.resolve();
let answerGenerationQueue = Promise.resolve();
let lastUtterance = "";
let microphoneChecked = false;
let enrollmentActive = false;

const CHUNK_SECONDS = 4;
const CHUNK_OVERLAP_SECONDS = 0.65;
const PRE_ROLL_SECONDS = 0.5;
const END_OF_TURN_SILENCE_MS = 1600;
const MAX_TURN_MS = 90000;
const MIN_FINAL_CHUNK_SECONDS = 0.8;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function loadState() {
  try {
    return {
      ...defaultState,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
    };
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

  $$(".screen").forEach(screen => {
    screen.classList.toggle("active", screen === target);
  });

  $$(".nav-item, .bottom-nav button").forEach(button => {
    button.classList.toggle("active", button.dataset.route === route);
  });

  history.replaceState(null, "", `#${route}`);
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (route === "history") renderHistory();
  if (route === "live") updateLiveContext();
}

function bindNavigation() {
  $$("[data-route]").forEach(button => {
    button.addEventListener("click", () => routeTo(button.dataset.route));
  });
}

function hydrateSetup() {
  $("#companyInput").value = state.company;
  $("#roleInput").value = state.role;
  $("#jobDescriptionInput").value = state.jobDescription;
  $("#intensityInput").value = state.intensity;
  $("#bulletCountInput").value = String(state.bulletCount);

  const focus = document.querySelector(
    `input[name="focus"][value="${state.focus}"]`
  );

  if (focus) focus.checked = true;
}

function updateHome() {
  $("#recentRole").textContent = state.role || "Set up your interview";

  $("#recentCompany").textContent = state.role
    ? state.company || "Company not specified"
    : "Add a company and position to get started.";
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
        body: JSON.stringify({
          company: state.company,
          role: state.role,
          jobDescription: state.jobDescription,
          focus: state.focus
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not prepare the role");
      }

      state.briefing = payload.briefing;
      saveState();

      showToast(
        payload.configured ? "Role briefing prepared" : "Setup saved"
      );
    } catch (error) {
      state.briefing = null;
      saveState();

      showToast(
        error.message ||
        "Setup saved, but the role briefing could not be prepared"
      );
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
    $("#micHelp").textContent =
      "This browser does not support microphone capture.";
    $("#permissionStatus").textContent = "Unsupported";
    return;
  }

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioContext = new (
      window.AudioContext ||
      window.webkitAudioContext
    )();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    audioContext
      .createMediaStreamSource(microphoneStream)
      .connect(analyser);

    $("#micOrbit").classList.add("active");
    $("#micStatus").textContent = "Listening clearly";
    $("#micHelp").textContent =
      "Speak, then play a question through your computer speakers.";
    $("#permissionStatus").textContent = "Allowed";
    $("#permissionStatus").style.color = "var(--green)";
    $("#micButton").textContent = "Stop microphone check";

    microphoneChecked = true;
    updateEnrollmentUI();
    updateMeter();
  } catch (error) {
    $("#micStatus").textContent = "Microphone access was blocked";
    $("#micHelp").textContent =
      "Allow microphone access in your browser settings, then try again.";
    $("#permissionStatus").textContent = "Blocked";
    $("#permissionStatus").style.color = "var(--danger)";
  }
}

function updateMeter() {
  if (!analyser) return;

  const values = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(values);

  const average =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

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
  $("#speakerStatus").style.color = enrolled
    ? "var(--green)"
    : "var(--danger)";

  $("#resetVoice").hidden = !enrolled;
  $("#testVoice").hidden = !enrolled;

  if (enrolled && !enrollmentActive) {
    $("#enrollmentHelp").textContent =
      "Your local voiceprint is ready. Speech matching you will be discarded before transcription.";

    $("#enrollmentPrompt").textContent =
      "Voice separation is active on this device.";

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

  $("#enrollmentPrompt").textContent =
    "Speak yourself, or play a sample from the computer now.";

  let stream;

  try {
    await window.SpeakerEnrollment.initializeRecognizer();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const mimeType = preferredAudioType();

    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined
    );

    const chunks = [];

    recorder.addEventListener("dataavailable", event => {
      if (event.data.size) chunks.push(event.data);
    });

    const stopped = new Promise(resolve => {
      recorder.addEventListener("stop", resolve, { once: true });
    });

    recorder.start();

    await new Promise(resolve => setTimeout(resolve, 4000));

    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, {
      type: recorder.mimeType || mimeType || "audio/webm"
    });

    const result =
      await window.SpeakerEnrollment.classifyBlob(blob);

    const percentage = Math.round(result.score * 100);

    microphoneChecked = true;
    updateEnrollmentUI();

    $("#enrollmentPrompt").textContent =
      result.isEnrolledSpeaker
        ? `Matched your voice at ${percentage}% — this audio would be ignored.`
        : `Classified as another speaker at ${percentage}% match — this audio would be transcribed.`;
  } catch (error) {
    $("#enrollmentPrompt").textContent =
      error.message ||
      "The speaker test failed. Try again in a quieter room.";
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

    $("#enrollVoice").textContent =
      window.SpeakerEnrollment.hasProfile()
        ? "Re-enroll my voice"
        : "Start voice enrollment";

    $("#micOrbit").classList.remove("active");
    showToast("Voice enrollment stopped");
    return;
  }

  stopMicrophone();

  enrollmentActive = true;

  $("#enrollVoice").textContent = "Stop enrollment";
  $("#enrollmentBadge").textContent = "Listening";

  $("#enrollmentHelp").textContent =
    "Keep speaking naturally until the progress reaches 100%. Use a quiet room and only your voice.";

  $("#enrollmentPrompt").textContent =
    "Describe a project: the goal, what you built, a difficult decision, and the result.";

  $("#micOrbit").classList.add("active");

  try {
    await window.SpeakerEnrollment.enroll({
      onProgress: percentage => {
        $("#enrollmentProgress").setAttribute(
          "aria-valuenow",
          String(percentage)
        );

        $("#enrollmentProgress span").style.width =
          `${percentage}%`;

        $("#enrollmentBadge").textContent =
          `${percentage}%`;

        if (percentage >= 35 && percentage < 70) {
          $("#enrollmentPrompt").textContent =
            "Now explain a technical challenge and how you solved it.";
        }

        if (percentage >= 70) {
          $("#enrollmentPrompt").textContent =
            "Finish with the outcome and what you learned.";
        }
      },

      onMeter: level => {
        $("#meterFill").style.width =
          `${Math.max(2, level)}%`;

        $("#micOrbit").style.transform =
          `scale(${1 + level / 1600})`;
      }
    });

    microphoneChecked = true;

    $("#permissionStatus").textContent = "Allowed";
    $("#permissionStatus").style.color = "var(--green)";

    showToast("Voice enrollment complete");
  } catch (error) {
    if (error.message !== "Enrollment stopped.") {
      showToast(error.message || "Voice enrollment failed");
    }
  } finally {
    enrollmentActive = false;

    $("#micOrbit").classList.remove("active");
    $("#micOrbit").style.transform = "";
    $("#meterFill").style.width = "0%";

    updateEnrollmentUI();
  }
}

function bindAudio() {
  $("#micButton").addEventListener(
    "click",
    startMicrophoneCheck
  );

  $("#enrollVoice").addEventListener(
    "click",
    toggleEnrollment
  );

  $("#testVoice").addEventListener(
    "click",
    testSpeakerSeparation
  );

  $("#resetVoice").addEventListener("click", async () => {
    await window.SpeakerEnrollment.reset();

    $("#enrollmentProgress").setAttribute(
      "aria-valuenow",
      "0"
    );

    $("#enrollmentProgress span").style.width = "0%";

    $("#enrollmentHelp").textContent =
      "Read naturally for about 20–30 seconds. Your voiceprint stays on this device.";

    $("#enrollmentPrompt").textContent =
      "When prompted, describe a project you are proud of in your normal interview voice.";

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
  const role = state.role || "No role selected";
  const company = state.company
    ? ` · ${state.company}`
    : "";

  $("#liveContext").textContent = `${role}${company}`;

  const ready =
    apiStatus.groqConfigured &&
    apiStatus.geminiConfigured;

  if (!document.body.classList.contains("live-running")) {
    $("#matchPill").textContent =
      ready ? "AI ready" : "Services unavailable";
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock =
        await navigator.wakeLock.request("screen");
    }
  } catch {
    // The session can continue without a wake lock.
  }
}

async function startSession() {
  if (!window.SpeakerEnrollment?.hasProfile()) {
    routeTo("audio");
    showToast("Enroll your voice before starting a session");
    return;
  }

  const ready =
    apiStatus.groqConfigured &&
    apiStatus.geminiConfigured;

  if (!ready) {
    $("#liveStateText").textContent =
      "Services unavailable";

    showToast(
      "The transcription and coaching services are not connected"
    );

    return;
  }

  sessionStartedAt = Date.now();

  document.body.classList.add("live-running");

  $("#liveStateText").textContent =
    "Starting microphone";

  $("#toggleSession").textContent =
    "End session";

  sessionTimer = setInterval(updateClock, 1000);

  requestWakeLock();
  updateClock();

  try {
    await window.SpeakerEnrollment.initializeRecognizer();
    await startLiveCapture();

    $("#liveStateText").textContent = "Listening";

    showToast("Live listening started");
  } catch (error) {
    console.error(error);

    $("#liveStateText").textContent =
      "Microphone blocked";

    showToast(
      error.message ||
      "Allow microphone access, then resume the session"
    );

    endSession();
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

  const elapsed =
    Math.floor(
      (Date.now() - sessionStartedAt) / 1000
    );

  const minutes =
    String(Math.floor(elapsed / 60)).padStart(2, "0");

  const seconds =
    String(elapsed % 60).padStart(2, "0");

  $("#sessionClock").textContent =
    `${minutes}:${seconds}`;
}

function preferredAudioType() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm"
  ];

  return (
    types.find(type =>
      window.MediaRecorder?.isTypeSupported(type)
    ) || ""
  );
}

async function startLiveCapture() {
  microphoneStream =
    await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1
      }
    });

  audioContext = new (
    window.AudioContext ||
    window.webkitAudioContext
  )();

  await audioContext.resume();

  liveSource =
    audioContext.createMediaStreamSource(
      microphoneStream
    );

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;

  liveSource.connect(analyser);

  const bufferSize = 2048;

  pcmProcessor =
    audioContext.createScriptProcessor(
      bufferSize,
      1,
      1
    );

  silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;

  liveSource.connect(pcmProcessor);
  pcmProcessor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);

  pcmProcessor.onaudioprocess =
    handleAudioBlock;
}

function handleAudioBlock(event) {
  if (!sessionTimer || !audioContext) return;

  const samples = new Float32Array(
    event.inputBuffer.getChannelData(0)
  );

  const rms = calculateRms(samples);
  const now = performance.now();

  if (!activeTurn) {
    const startThreshold =
      Math.max(0.018, noiseFloor * 2.2);

    if (rms > startThreshold) {
      beginTurn(samples, now);
    } else {
      noiseFloor =
        Math.min(
          0.04,
          noiseFloor * 0.96 + rms * 0.04
        );

      addPreRollBlock(samples);
    }

    return;
  }

  appendTurnSamples(activeTurn, samples);

  const continueThreshold =
    Math.max(0.013, noiseFloor * 1.55);

  if (rms > continueThreshold) {
    activeTurn.lastSpeechAt = now;
  }

  emitFullChunks(activeTurn);

  if (
    now - activeTurn.lastSpeechAt >=
    END_OF_TURN_SILENCE_MS ||
    now - activeTurn.startedAt >=
    MAX_TURN_MS
  ) {
    finishTurn();
  }
}

function calculateRms(samples) {
  let sum = 0;

  for (
    let index = 0;
    index < samples.length;
    index += 1
  ) {
    sum += samples[index] * samples[index];
  }

  return Math.sqrt(sum / samples.length);
}

function addPreRollBlock(samples) {
  preRollBlocks.push(samples);
  preRollSampleCount += samples.length;

  const maxSamples =
    Math.ceil(
      audioContext.sampleRate *
      PRE_ROLL_SECONDS
    );

  while (
    preRollSampleCount > maxSamples &&
    preRollBlocks.length > 1
  ) {
    preRollSampleCount -=
      preRollBlocks[0].length;

    preRollBlocks.shift();
  }
}

function beginTurn(samples, now) {
  activeTurn = {
    id: ++turnSequence,
    startedAt: now,
    lastSpeechAt: now,
    sampleRate: audioContext.sampleRate,
    blocks: [...preRollBlocks],
    sampleCount: preRollSampleCount,
    speakerBlocks: [...preRollBlocks],
    speakerSampleCount: preRollSampleCount,
    pending: [],
    transcripts: [],
    interviewerChunks: 0,
    ownVoiceChunks: 0
  };

  preRollBlocks = [];
  preRollSampleCount = 0;

  appendTurnSamples(activeTurn, samples);

  $("#liveStateText").textContent = "Listening";
}

function appendTurnSamples(turn, samples) {
  turn.blocks.push(samples);
  turn.sampleCount += samples.length;

  turn.speakerBlocks.push(samples);
  turn.speakerSampleCount += samples.length;
}

function flattenBlocks(blocks, length) {
  const output = new Float32Array(length);
  let offset = 0;

  for (const block of blocks) {
    const remaining = length - offset;

    if (remaining <= 0) break;

    output.set(
      block.subarray(0, remaining),
      offset
    );

    offset += Math.min(
      block.length,
      remaining
    );
  }

  return output;
}

function emitFullChunks(turn) {
  const sampleRate = audioContext.sampleRate;

  const chunkSamples =
    Math.round(
      sampleRate * CHUNK_SECONDS
    );

  const overlapSamples =
    Math.round(
      sampleRate * CHUNK_OVERLAP_SECONDS
    );

  while (turn.sampleCount >= chunkSamples) {
    const allSamples =
      flattenBlocks(
        turn.blocks,
        turn.sampleCount
      );

    queueTurnChunk(
      turn,
      allSamples.slice(0, chunkSamples),
      sampleRate
    );

    const retained =
      allSamples.slice(
        chunkSamples - overlapSamples
      );

    turn.blocks = [retained];
    turn.sampleCount = retained.length;
  }
}

function finishTurn() {
  const turn = activeTurn;

  if (!turn || !audioContext) return;

  activeTurn = null;

  $("#liveStateText").textContent =
    "Finishing question";

  const sampleRate = audioContext.sampleRate;

  if (
    turn.sampleCount >=
    sampleRate * MIN_FINAL_CHUNK_SECONDS
  ) {
    queueTurnChunk(
      turn,
      flattenBlocks(
        turn.blocks,
        turn.sampleCount
      ),
      sampleRate
    );
  }

  preRollBlocks = [];
  preRollSampleCount = 0;

  answerGenerationQueue =
    answerGenerationQueue
      .then(() => finalizeTurn(turn))
      .catch(handleProcessingError);
}

function queueTurnChunk(
  turn,
  samples,
  sampleRate
) {
  const task =
    audioChunkQueue.then(() =>
      processTurnChunk(
        turn,
        samples,
        sampleRate
      )
    );

  audioChunkQueue =
    task.catch(error => {
      console.error(error);
    });

  turn.pending.push(task);
}

async function processTurnChunk(
  turn,
  samples,
  sampleRate
) {
  const blob =
    encodeWav(samples, sampleRate);

  const transcript =
    await transcribeChunk(
      blob,
      turn.transcripts.join(" ")
    );

  if (!isUsefulTranscript(transcript)) {
    return;
  }

  turn.interviewerChunks += 1;
  turn.transcripts.push(transcript.trim());
}

async function transcribeChunk(
  blob,
  context
) {
  const audio = await blobToBase64(blob);

  const response = await fetch(
    "/api/transcribe",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        audio,
        mimeType: "audio/wav",
        context: [
          state.recentTranscript
            .slice(-2)
            .join(" "),
          context
        ]
          .filter(Boolean)
          .join(" ")
          .slice(-1800)
      })
    }
  );

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload.error ||
      "Transcription failed"
    );
  }

  return payload.transcript?.trim() || "";
}

async function finalizeTurn(turn) {
  await Promise.allSettled(turn.pending);

  const speakerBlob =
    encodeWav(
      flattenBlocks(
        turn.speakerBlocks,
        turn.speakerSampleCount
      ),
      turn.sampleRate
    );

  const speaker =
    await window.SpeakerEnrollment
      .classifyBlob(speakerBlob);

  if (speaker.isEnrolledSpeaker) {
    if (sessionTimer) {
      $("#liveStateText").textContent =
        "Listening";
    }

    return;
  }

  const question =
    mergeTranscripts(turn.transcripts);

  if (
    !question ||
    !turn.interviewerChunks
  ) {
    if (sessionTimer) {
      $("#liveStateText").textContent =
        "Listening";
    }

    return;
  }

  lastUtterance = question;

  state.recentTranscript = [
    ...state.recentTranscript,
    question
  ].slice(-8);

  saveState();

  $("#transcriptCopy").textContent =
    `“${question}”`;

  $("#transcriptTime").textContent =
    "Just now";

  $("#liveStateText").textContent =
    "Preparing answer";

  await requestCoach(question, true);

  if (sessionTimer) {
    $("#liveStateText").textContent =
      "Listening";
  }
}

function mergeTranscripts(parts) {
  const cleanParts =
    parts
      .map(part => part.trim())
      .filter(Boolean);

  if (!cleanParts.length) return "";

  let merged = cleanParts[0];

  for (
    let index = 1;
    index < cleanParts.length;
    index += 1
  ) {
    const next = cleanParts[index];

    const previousWords =
      merged.split(/\s+/);

    const nextWords =
      next.split(/\s+/);

    const maxOverlap =
      Math.min(
        16,
        previousWords.length,
        nextWords.length
      );

    let overlap = 0;

    for (
      let size = maxOverlap;
      size >= 2;
      size -= 1
    ) {
      const tail =
        previousWords
          .slice(-size)
          .map(normalizeWord)
          .join(" ");

      const head =
        nextWords
          .slice(0, size)
          .map(normalizeWord)
          .join(" ");

      if (tail === head) {
        overlap = size;
        break;
      }
    }

    merged =
      `${merged} ${nextWords
        .slice(overlap)
        .join(" ")}`
        .trim();
  }

  return merged;
}

function normalizeWord(word) {
  return word
    .toLowerCase()
    .replace(/[^a-z0-9']/g, "");
}

function isUsefulTranscript(transcript) {
  const words =
    transcript
      .toLowerCase()
      .match(/[a-z0-9']+/g) || [];

  if (words.length < 2) return false;

  if (words.length >= 8) {
    const counts =
      words.reduce((result, word) => {
        result[word] =
          (result[word] || 0) + 1;

        return result;
      }, {});

    const mostRepeated =
      Math.max(...Object.values(counts));

    const uniqueRatio =
      Object.keys(counts).length /
      words.length;

    if (
      mostRepeated / words.length > 0.55 ||
      uniqueRatio < 0.18
    ) {
      return false;
    }
  }

  return true;
}

function encodeWav(samples, sampleRate) {
  const buffer =
    new ArrayBuffer(
      44 + samples.length * 2
    );

  const view = new DataView(buffer);

  const writeText = (offset, value) => {
    for (
      let index = 0;
      index < value.length;
      index += 1
    ) {
      view.setUint8(
        offset + index,
        value.charCodeAt(index)
      );
    }
  };

  writeText(0, "RIFF");

  view.setUint32(
    4,
    36 + samples.length * 2,
    true
  );

  writeText(8, "WAVE");
  writeText(12, "fmt ");

  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeText(36, "data");

  view.setUint32(
    40,
    samples.length * 2,
    true
  );

  let offset = 44;

  for (
    let index = 0;
    index < samples.length;
    index += 1
  ) {
    const sample =
      Math.max(
        -1,
        Math.min(1, samples[index])
      );

    view.setInt16(
      offset,
      sample < 0
        ? sample * 0x8000
        : sample * 0x7fff,
      true
    );

    offset += 2;
  }

  return new Blob(
    [buffer],
    { type: "audio/wav" }
  );
}

function stopLiveCapture() {
  if (pcmProcessor) {
    pcmProcessor.onaudioprocess = null;
    pcmProcessor.disconnect();
  }

  liveSource?.disconnect();
  silentOutput?.disconnect();

  pcmProcessor = null;
  liveSource = null;
  silentOutput = null;
  activeTurn = null;

  preRollBlocks = [];
  preRollSampleCount = 0;

  microphoneStream
    ?.getTracks()
    .forEach(track => track.stop());

  microphoneStream = null;
  analyser = null;

  audioContext?.close();
  audioContext = null;
}

async function requestCoach(
  utterance,
  forceQuestion
) {
  const response = await fetch(
    "/api/coach",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        utterance,
        forceQuestion,
        recentTranscript:
          state.recentTranscript
            .slice(0, -1),
        company: state.company,
        role: state.role,
        focus: state.focus,
        intensity: state.intensity,
        bulletCount: state.bulletCount,
        briefing: state.briefing
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error ||
      "Coaching failed"
    );
  }

  if (result.isQuestion) {
    renderCoachResult(result);
  }
}

function renderCoachResult(result) {
  const bullets =
    (result.bullets || []).map(String);

  $("#answerLabel").textContent =
    result.profile || "Reference";

  $("#matchPill").textContent =
    `${Math.round(
      result.match ||
      result.confidence ||
      0
    )}% match`;

  $("#liveTitle").textContent =
    result.lead ||
    "Use your strongest relevant example";

  $("#answerBullets").innerHTML =
    bullets
      .map(
        bullet =>
          `<li>${escapeHtml(bullet)}</li>`
      )
      .join("");

  $("#transcriptCopy").textContent =
    `“${result.question || lastUtterance}”`;

  $("#transcriptTime").textContent =
    "Just now";

  $("#supportingDetail").textContent =
    result.detail || "";

  $("#supportingDetail").hidden = true;
  $("#detailToggle").hidden = !result.detail;

  $("#detailToggle").setAttribute(
    "aria-expanded",
    "false"
  );

  $("#detailToggle").textContent =
    "Show supporting detail";

  state.history.unshift({
    question:
      result.question || lastUtterance,
    lead:
      result.lead ||
      "Relevant experience",
    profile:
      result.profile || "Blended",
    match:
      Math.round(
        result.match ||
        result.confidence ||
        0
      ),
    bullets,
    detail: result.detail || "",
    timestamp: new Date().toISOString()
  });

  state.history =
    state.history.slice(0, 20);

  saveState();
  renderLiveArchive();
}

function renderLiveArchive() {
  const archive = $("#answerArchive");

  if (!archive) return;

  const previousAnswers =
    (state.history || []).slice(1);

  archive.hidden =
    !previousAnswers.length;

  archive.innerHTML =
    previousAnswers
      .map(
        item => `
          <article class="archived-answer">
            <span class="eyebrow">
              Previous question
            </span>

            <p class="archived-question">
              ${escapeHtml(item.question || "")}
            </p>

            <h2>
              ${escapeHtml(
          item.lead ||
          "Previous response"
        )}
            </h2>

            ${Array.isArray(item.bullets) &&
            item.bullets.length
            ? `
                  <ul>
                    ${item.bullets
              .map(
                bullet =>
                  `<li>${escapeHtml(
                    bullet
                  )}</li>`
              )
              .join("")}
                  </ul>
                `
            : ""
          }
          </article>
        `
      )
      .join("");
}

function handleProcessingError(error) {
  console.error(error);

  if (sessionTimer) {
    $("#liveStateText").textContent =
      "Listening";
  }

  showToast(
    error.message ||
    "Could not process that audio segment"
  );
}

function blobToBase64(blob) {
  return new Promise(
    (resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        resolve(
          String(reader.result)
            .split(",")[1] || ""
        );
      };

      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }
  );
}

function dismissAnswer() {
  $("#answerLabel").textContent =
    "Your reference";

  $("#matchPill").textContent =
    "Listening";

  $("#liveTitle").textContent =
    "Listening for the next question.";

  $("#answerBullets").innerHTML =
    "<li>No reference points yet.</li>";

  $("#transcriptCopy").textContent =
    "No question captured yet.";

  $("#transcriptTime").textContent =
    "Waiting";

  $("#detailToggle").hidden = true;
  $("#supportingDetail").hidden = true;
}

function bindLive() {
  $("#toggleSession").addEventListener(
    "click",
    () => {
      if (sessionTimer) {
        endSession();
      } else {
        startSession();
      }
    }
  );

  $("#answerNow").addEventListener(
    "click",
    async () => {
      if (
        apiStatus.geminiConfigured &&
        lastUtterance
      ) {
        try {
          await requestCoach(
            lastUtterance,
            true
          );
        } catch (error) {
          handleProcessingError(error);
        }

        return;
      }

      showToast(
        apiStatus.geminiConfigured
          ? "No question has been captured yet"
          : "The coaching service is not connected"
      );
    }
  );

  $("#dismissAnswer").addEventListener(
    "click",
    dismissAnswer
  );

  $("#detailToggle").addEventListener(
    "click",
    event => {
      const expanded =
        event.currentTarget.getAttribute(
          "aria-expanded"
        ) === "true";

      event.currentTarget.setAttribute(
        "aria-expanded",
        String(!expanded)
      );

      event.currentTarget.textContent =
        expanded
          ? "Show supporting detail"
          : "Hide supporting detail";

      $("#supportingDetail").hidden =
        expanded;
    }
  );

  document.addEventListener(
    "keydown",
    event => {
      if (
        !$('[data-screen="live"]')
          .classList.contains("active")
      ) {
        return;
      }

      if (
        event.key.toLowerCase() === "a"
      ) {
        $("#answerNow").click();
      }

      if (
        event.key.toLowerCase() === "d"
      ) {
        dismissAnswer();
      }
    }
  );
}

async function checkApiStatus() {
  try {
    const response =
      await fetch("/api/status");

    if (response.ok) {
      apiStatus =
        await response.json();
    }
  } catch {
    apiStatus = {
      groqConfigured: false,
      geminiConfigured: false
    };
  }

  updateLiveContext();
}

function renderHistory() {
  const list = $("#historyList");
  const items = state.history || [];

  $("#questionCount").textContent =
    items.length;

  $("#averageMatch").textContent =
    items.length
      ? `${Math.round(
        items.reduce(
          (sum, item) =>
            sum + item.match,
          0
        ) / items.length
      )}%`
      : "—";

  if (items.length) {
    const profiles =
      items.reduce(
        (counts, item) => ({
          ...counts,
          [item.profile]:
            (counts[item.profile] || 0) + 1
        }),
        {}
      );

    $("#topProfile").textContent =
      Object.entries(profiles)
        .sort(
          (a, b) =>
            b[1] - a[1]
        )[0][0];
  } else {
    $("#topProfile").textContent = "—";
  }

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-mark">?</span>
        <h2>No questions yet</h2>
        <p>
          Your saved questions and reference points
          will appear here.
        </p>
        <button
          class="secondary-button"
          type="button"
          data-route="live"
        >
          Open live reference
        </button>
      </div>
    `;

    list
      .querySelector("[data-route]")
      .addEventListener(
        "click",
        () => routeTo("live")
      );

    return;
  }

  list.innerHTML =
    items
      .map((item, index) => {
        const time =
          new Date(
            item.timestamp
          ).toLocaleTimeString(
            [],
            {
              hour: "numeric",
              minute: "2-digit"
            }
          );

        return `
          <article class="history-item">
            <span class="history-number">
              ${String(index + 1).padStart(2, "0")}
            </span>

            <div>
              <h3>
                ${escapeHtml(item.question)}
              </h3>

              <p>
                ${escapeHtml(item.lead)}
                ·
                ${escapeHtml(item.profile)}
                ·
                ${item.match}% match
              </p>
            </div>

            <time>${time}</time>
          </article>
        `;
      })
      .join("");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    character =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"
      })[character]
  );
}

function setupInstallPrompt() {
  window.addEventListener(
    "beforeinstallprompt",
    event => {
      event.preventDefault();

      installPrompt = event;
      $("#installButton").hidden = false;
    }
  );

  $("#installButton").addEventListener(
    "click",
    async () => {
      if (!installPrompt) return;

      installPrompt.prompt();
      await installPrompt.userChoice;

      installPrompt = null;
      $("#installButton").hidden = true;
    }
  );
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener(
      "load",
      () => {
        navigator.serviceWorker.register(
          "/service-worker.js"
        );
      }
    );
  }
}

function init() {
  bindNavigation();
  bindSetup();
  bindAudio();
  bindLive();
  hydrateSetup();
  updateHome();
  renderLiveArchive();
  setupInstallPrompt();
  registerServiceWorker();
  checkApiStatus();

  routeTo(
    location.hash.slice(1) || "home"
  );
}

init();
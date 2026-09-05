/*
 * Local speaker verification using WeSpeaker ResNet34 embeddings.
 * Model: talatapp/wespeaker-voxceleb-resnet34-LM-onnx
 * Upstream WeSpeaker: Apache-2.0. VoxCeleb model data: CC BY 4.0.
 */

const SPEAKER_PROFILE_KEY = "interview-reference-speaker-profile-v2";
const MODEL_URL = "/models/wespeaker.onnx";
const ORT_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const SAMPLE_RATE = 16000;
const SLOT_SAMPLES = 160000;
const SLOT_COUNT = 3;
const MASK_FRAMES = 589;
const EMBEDDING_SIZE = 256;
const ENROLLMENT_SAMPLES = SLOT_SAMPLES * SLOT_COUNT;
const DEFAULT_MATCH_THRESHOLD = 0.55;

let modelSession = null;
let modelPromise = null;
let decodeContext = null;
let enrollmentCapture = null;
let enrollmentReject = null;
let enrollmentGeneration = 0;

function getAccessKey() {
  return "local-open-source";
}

function saveAccessKey() {
  // Compatibility no-op. This model has no account or API key.
}

function getProfile() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SPEAKER_PROFILE_KEY) || "null"
    );

    return Array.isArray(saved) && saved.length === EMBEDDING_SIZE
      ? Float32Array.from(saved)
      : null;
  } catch {
    return null;
  }
}

function hasProfile() {
  return Boolean(getProfile());
}

async function loadModel() {
  if (modelSession) return modelSession;

  if (!window.ort?.InferenceSession) {
    throw new Error("The local speaker runtime did not load.");
  }

  if (!modelPromise) {
    window.ort.env.wasm.wasmPaths = ORT_WASM_PATH;
    window.ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(2, navigator.hardwareConcurrency || 1)
      : 1;

    modelPromise = window.ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    })
      .then(session => {
        modelSession = session;
        return session;
      })
      .catch(error => {
        modelPromise = null;
        throw error;
      });
  }

  return modelPromise;
}

function resampleToFloat32(samples, inputRate, outputRate = SAMPLE_RATE) {
  if (inputRate === outputRate) {
    return Float32Array.from(samples);
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (
    let outputIndex = 0;
    outputIndex < outputLength;
    outputIndex += 1
  ) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((outputIndex + 1) * ratio))
    );

    let total = 0;

    for (
      let inputIndex = start;
      inputIndex < end;
      inputIndex += 1
    ) {
      total += samples[inputIndex];
    }

    output[outputIndex] = total / (end - start);
  }

  return output;
}

function normalize(vector) {
  const length =
    Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0)
    ) || 1;

  return Float32Array.from(vector, value => value / length);
}

function cosineSimilarity(left, right) {
  let score = 0;

  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }

  return Math.max(-1, Math.min(1, score));
}

async function embeddingFromPcm(pcm) {
  const session = await loadModel();

  const clipped =
    pcm.length > ENROLLMENT_SAMPLES
      ? pcm.subarray(0, ENROLLMENT_SAMPLES)
      : pcm;

  if (!clipped.length) {
    throw new Error("No usable speech was detected.");
  }

  const averaged = new Float32Array(EMBEDDING_SIZE);
  let chunkCount = 0;

  for (
    let start = 0;
    start < clipped.length && chunkCount < SLOT_COUNT;
    start += SLOT_SAMPLES
  ) {
    const available = Math.min(
      SLOT_SAMPLES,
      clipped.length - start
    );

    const waveform = new Float32Array(SLOT_SAMPLES);

    waveform.set(
      clipped.subarray(start, start + available)
    );

    const mask = new Float32Array(MASK_FRAMES);

    const activeFrames = Math.max(
      1,
      Math.min(
        MASK_FRAMES,
        Math.ceil((available / SLOT_SAMPLES) * MASK_FRAMES)
      )
    );

    mask.fill(1, 0, activeFrames);

    const output = await session.run({
      waveform: new window.ort.Tensor(
        "float32",
        waveform,
        [1, SLOT_SAMPLES]
      ),
      mask: new window.ort.Tensor(
        "float32",
        mask,
        [1, MASK_FRAMES]
      )
    });

    const values = output[session.outputNames[0]]?.data;

    if (!values || values.length < EMBEDDING_SIZE) {
      throw new Error(
        "The speaker model returned an invalid embedding."
      );
    }

    const vector = normalize(values);

    for (
      let index = 0;
      index < EMBEDDING_SIZE;
      index += 1
    ) {
      averaged[index] += vector[index];
    }

    chunkCount += 1;
  }

  return normalize(averaged);
}

function stopCapture() {
  if (!enrollmentCapture) return;

  const {
    stream,
    context,
    processor,
    source,
    silentGain
  } = enrollmentCapture;

  processor.onaudioprocess = null;
  processor.disconnect();
  source.disconnect();
  silentGain.disconnect();

  stream
    .getTracks()
    .forEach(track => track.stop());

  context.close().catch(() => { });

  enrollmentCapture = null;
}

async function enroll({
  onProgress = () => { },
  onMeter = () => { }
}) {
  cancelEnrollment();

  const generation = ++enrollmentGeneration;

  await loadModel();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const context = new (
    window.AudioContext ||
    window.webkitAudioContext
  )();

  await context.resume();

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentGain = context.createGain();

  silentGain.gain.value = 0;

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  const speech = [];

  return new Promise((resolve, reject) => {
    enrollmentReject = reject;

    enrollmentCapture = {
      stream,
      context,
      processor,
      source,
      silentGain
    };

    processor.onaudioprocess = event => {
      if (generation !== enrollmentGeneration) return;

      const input =
        event.inputBuffer.getChannelData(0);

      const rms = Math.sqrt(
        input.reduce(
          (sum, value) => sum + value * value,
          0
        ) / input.length
      );

      onMeter(
        Math.min(100, Math.round(rms * 650))
      );

      if (rms < 0.012) return;

      const resampled = resampleToFloat32(
        input,
        context.sampleRate
      );

      const remaining =
        ENROLLMENT_SAMPLES - speech.length;

      for (
        let index = 0;
        index < Math.min(remaining, resampled.length);
        index += 1
      ) {
        speech.push(resampled[index]);
      }

      const percentage = Math.min(
        100,
        Math.round(
          (speech.length / ENROLLMENT_SAMPLES) * 100
        )
      );

      onProgress(percentage);

      if (speech.length >= ENROLLMENT_SAMPLES) {
        stopCapture();

        embeddingFromPcm(Float32Array.from(speech))
          .then(profile => {
            if (
              generation !== enrollmentGeneration
            ) {
              return;
            }

            localStorage.setItem(
              SPEAKER_PROFILE_KEY,
              JSON.stringify(Array.from(profile))
            );

            enrollmentReject = null;
            resolve(profile);
          })
          .catch(error => {
            enrollmentReject = null;
            reject(error);
          });
      }
    };
  });
}

function cancelEnrollment() {
  enrollmentGeneration += 1;
  stopCapture();

  if (enrollmentReject) {
    enrollmentReject(
      new Error("Enrollment stopped.")
    );
  }

  enrollmentReject = null;
}

async function initializeRecognizer() {
  if (!getProfile()) {
    throw new Error(
      "Enroll your voice before starting live mode."
    );
  }

  await loadModel();
}

async function blobToPcm(blob) {
  decodeContext ||= new (
    window.AudioContext ||
    window.webkitAudioContext
  )();

  const audio = await decodeContext.decodeAudioData(
    await blob.arrayBuffer()
  );

  return resampleToFloat32(
    audio.getChannelData(0),
    audio.sampleRate
  );
}

async function classifyBlob(
  blob,
  threshold = DEFAULT_MATCH_THRESHOLD
) {
  await initializeRecognizer();

  const enrolledProfile = getProfile();
  const pcm = await blobToPcm(blob);

  if (pcm.length < SAMPLE_RATE / 2) {
    throw new Error(
      "Speaker could not be verified; audio was not sent."
    );
  }

  const candidate = await embeddingFromPcm(pcm);

  const score = Math.max(
    0,
    cosineSimilarity(
      enrolledProfile,
      candidate
    )
  );

  return {
    score,
    isEnrolledSpeaker: score >= threshold
  };
}

async function releaseRecognizer() {
  if (decodeContext) {
    await decodeContext
      .close()
      .catch(() => { });

    decodeContext = null;
  }
}

async function reset() {
  cancelEnrollment();
  await releaseRecognizer();

  localStorage.removeItem(
    SPEAKER_PROFILE_KEY
  );
}

window.SpeakerEnrollment = {
  enroll,
  cancelEnrollment,
  initializeRecognizer,
  classifyBlob,
  releaseRecognizer,
  getAccessKey,
  saveAccessKey,
  hasProfile,
  reset
};
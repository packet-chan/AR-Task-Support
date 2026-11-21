export function panelTap(context) {
  if (context?.state !== "running") return;
  const now = context.currentTime;
  const tone = context.createOscillator(), gain = context.createGain();
  tone.type = "triangle";
  tone.frequency.setValueAtTime(740, now);
  tone.frequency.exponentialRampToValueAtTime(330, now + .033);
  gain.gain.setValueAtTime(.001, now);
  gain.gain.exponentialRampToValueAtTime(.085, now + .003);
  gain.gain.exponentialRampToValueAtTime(.001, now + .035);
  tone.connect(gain).connect(context.destination);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  tone.start(now);
  tone.stop(now + .036);
}

// Text-only Live session. Only the host's single-use token reaches this module.
export function captureVoice(useLive, onStatus) {
  let context, socket, ready = false, ended = false, failed = false;
  let active = false, obsolete = false, latest = "", last = "", endAt = 0, timer;
  const sources = new Set();
  const synth = window.speechSynthesis;
  synth?.getVoices();
  try {
    context = new AudioContext();
    context.resume().catch(() => { if (useLive) fallback(); });
  } catch { failed = true; }
  function stopAudio() {
    synth?.cancel();
    for (const source of sources) source.stop();
    sources.clear();
    endAt = 0;
  }
  function local(text) {
    if (!text) return;
    const voice = synth?.getVoices().find(v => v.localService && /^ja\b/i.test(v.lang));
    const prefix = useLive && failed ? "Gemini接続不可・" : "";
    onStatus(prefix + (voice ? "端末音声" : "文字案内"));
    if (!voice) return;
    const speech = new SpeechSynthesisUtterance(text);
    speech.voice = voice;
    speech.lang = "ja-JP";
    speech.onerror = () => { if (!ended && last === text) onStatus(prefix + "文字案内"); };
    synth.speak(speech);
  }
  function fallback() {
    if (ended || failed) return;
    failed = true;
    clearTimeout(timer);
    socket?.close();
    stopAudio();
    local(last);
  }
  function dispatch() {
    if (!ready || active || !latest) return;
    active = true;
    obsolete = false;
    socket.send(JSON.stringify({clientContent: {turns: [{role: "user", parts: [{text: latest}]}], turnComplete: true}}));
    latest = "";
    clearTimeout(timer);
    timer = setTimeout(fallback, 15000);
  }
  function play(data) {
    const bytes = Uint8Array.from(atob(data.data), ch => ch.charCodeAt(0));
    const pcm = new DataView(bytes.buffer);
    const rate = Number(/rate=(\d+)/.exec(data.mimeType)?.[1] || 24000);
    const buffer = context.createBuffer(1, Math.floor(bytes.length / 2), rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    sources.add(source);
    source.onended = () => { sources.delete(source); source.disconnect(); };
    const start = Math.max(context.currentTime + .015, endAt);
    source.start(start);
    endAt = start + buffer.duration;
  }
  let connecting = false;
  async function connect() {
    connecting = true;
    timer = setTimeout(fallback, 12000);
    try {
      const r = await fetch("/api/capture-live-token", {method: "POST", cache: "no-store", signal: AbortSignal.timeout(9000)});
      if (!r.ok) throw Error();
      const {token, model} = await r.json();
      if (ended || failed) return;
      socket = new WebSocket("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=" + encodeURIComponent(token));
      socket.binaryType = "arraybuffer";
      socket.onopen = () => socket.send(JSON.stringify({setup: {model}}));
      socket.onerror = socket.onclose = fallback;
      socket.onmessage = ({data}) => {
        if (ended || failed) return;
        try {
          const event = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
          if (event.setupComplete) { ready = true; onStatus("Gemini音声"); dispatch(); }
          const content = event.serverContent;
          if (!content) return;
          for (const p of content.modelTurn?.parts || []) {
            if (!obsolete && p.inlineData?.mimeType.startsWith("audio/pcm")) play(p.inlineData);
          }
          if (content.turnComplete) {
            clearTimeout(timer);
            active = false;
            dispatch();
          }
        } catch { fallback(); }
      };
    } catch { fallback(); }
  }
  return {
    tap() {
      if (!ended) panelTap(context);
    },
    say(text) {
      if (ended) return;
      last = text;
      stopAudio();
      if (!useLive || failed) { local(text); return; }
      latest = text;
      obsolete = active;
      if (!connecting) connect();
      else dispatch();
    },
    close() {
      ended = true;
      clearTimeout(timer);
      socket?.close();
      stopAudio();
      context?.close().catch(() => {});
    }
  };
}

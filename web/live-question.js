// Each question gets its own constrained token and a bounded microphone turn.
export function openQuestion(context, photo, render, back) {
  let closed=false, recording=false, socket, mic, audio, processor, watchdog, endAt=0, transcript="";
  const abort = new AbortController();
  function stopMic() {
    recording=false;
    if (processor) { processor.onaudioprocess=null; processor.disconnect(); processor=null; }
    mic?.getTracks().forEach(t=>t.stop()); mic=null;
  }
  function close() {
    if (closed) return;
    closed=true; abort.abort(); clearTimeout(watchdog); stopMic();
    if (socket && socket.readyState<2) socket.close();
    audio?.close().catch(()=>{});
    document.removeEventListener("visibilitychange",visibility);
  }
  const leave=["案内に戻る",()=>{close();back();},"back"];
  function visibility() { if (document.hidden) {close();back();} }
  document.addEventListener("visibilitychange",visibility);
  function fail(message) { if (!closed) {close();render("音声相談",message,[leave]);} }
  function timeout(fn,ms) { clearTimeout(watchdog); watchdog=setTimeout(fn,ms); }
  function send(input) { socket.send(JSON.stringify({realtimeInput:input})); }
  function finish() {
    if (!recording || closed) return;
    stopMic();send({activityEnd:{}});
    render("回答を待っています","マイクを止めました。",[leave]);
    timeout(()=>fail("回答が届きません。案内に戻ってもう一度質問できます。"),25000);
  }
  async function start(withPhoto) {
    render("相談を準備中","マイクの利用を許可してください。案内が「質問をどうぞ」に変わってから話してください。",[leave]);
    timeout(()=>fail("接続を開始できません。マイクと配信PCの設定を確認してください。"),30000);
    try {
      audio=new AudioContext({sampleRate:16000}); await audio.resume();
      if (closed) return;
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true},video:false});
      if (closed) {stream.getTracks().forEach(t=>t.stop());return;}
      mic=stream;
      const image=withPhoto ? await photo() : null;
      if (withPhoto && !image) throw Error();
      const r=await fetch("/api/capture-live-token",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({questionContext:context.slice(0,5900)}),signal:abort.signal});
      if (!r.ok) throw Error();
      const {model,token}=await r.json();
      if (closed) return;
      socket=new WebSocket("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token="+encodeURIComponent(token));
      socket.binaryType="arraybuffer";
      socket.onopen=()=>socket.send(JSON.stringify({setup:{model}}));
      socket.onclose=socket.onerror=()=>fail("Geminiとの接続が切れました。案内に戻ってもう一度質問できます。");
      socket.onmessage=({data})=>{
        if (closed) return;
        try {
          const event=JSON.parse(typeof data==="string"?data:new TextDecoder().decode(data));
          if (event.setupComplete) {
            send({activityStart:{}});
            if (image) send({video:{mimeType:"image/jpeg",data:image.split(",")[1]}});
            const source=audio.createMediaStreamSource(mic);
            processor=audio.createScriptProcessor(2048,1,1);
            processor.onaudioprocess=e=>{
              if (!recording || socket.readyState!==1) return;
              const samples=e.inputBuffer.getChannelData(0), bytes=new Uint8Array(samples.length*2), pcm=new DataView(bytes.buffer);
              for(let i=0;i<samples.length;i++) pcm.setInt16(i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
              send({audio:{mimeType:"audio/pcm;rate="+audio.sampleRate,data:btoa(String.fromCharCode(...bytes))}});
            };
            source.connect(processor);processor.connect(audio.destination);recording=true;
            render("質問をどうぞ","Googleに質問の声を送信中です。話し終えたら「回答を聞く」を選びます。20秒で自動停止します。",[["回答を聞く",finish,"check"],leave]);
            timeout(finish,20000);
          }
          const content=event.serverContent;
          if (!content) return;
          for (const p of content.modelTurn?.parts || []) if (p.inlineData?.mimeType.startsWith("audio/pcm")) {
            const bytes=Uint8Array.from(atob(p.inlineData.data),c=>c.charCodeAt(0)), pcm=new DataView(bytes.buffer);
            const buffer=audio.createBuffer(1,Math.floor(bytes.length/2),24000), samples=buffer.getChannelData(0);
            for(let i=0;i<samples.length;i++) samples[i]=pcm.getInt16(i*2,true)/32768;
            const player=audio.createBufferSource(); player.buffer=buffer; player.connect(audio.destination);
            const start=Math.max(audio.currentTime+.01,endAt);player.start(start);endAt=start+buffer.duration;
          }
          transcript+=content.outputTranscription?.text || "";
          if (content.turnComplete) {
            clearTimeout(watchdog);socket.onclose=socket.onerror=null;socket.close();
            render("Geminiの回答",transcript || "音声で回答しました。",[leave]);
          }
        } catch {fail("回答を受け取れませんでした。案内に戻れます。");}
      };
    } catch {fail("マイクまたはGeminiを使えません。権限と配信PCの接続を確認してください。");}
  }
  const buttons=[["声で質問",()=>start(false),"question"]];
  if(photo) buttons.push(["写真と声で質問",()=>start(true),"photo"]);
  render("Geminiに質問","選ぶと手順と質問の声をGoogleに送ります。"+(photo?"「写真と声で質問」は表示対象の実写1枚も送ります。":"実写は送りません。"),[...buttons,leave]);
  return {close};
}

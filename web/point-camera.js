// Snapshot the camera frame synchronously with selectstart. XR graphics are never composited into it.
export function pointCamera() {
  let video, attempt=0;
  const images = new Map();
  function stop() {
    attempt++;
    video?.srcObject?.getTracks().forEach(t => t.stop());
    if (video) video.srcObject = null;
    video = null;
  }
  return {
    images,stop,
    async open() {
      stop();
      const ticket = attempt;
      const stream = await navigator.mediaDevices.getUserMedia({audio:false,video:{
        facingMode:{exact:"environment"},width:{ideal:1280},height:{ideal:960}}});
      if (ticket !== attempt) { stream.getTracks().forEach(t => t.stop()); return false; }
      video = document.createElement("video");
      video.muted = video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      return ticket === attempt;
    },
    get active() { return !!video; },
    snap() {
      if (!video?.videoWidth || video.readyState < 2 || !video.srcObject?.active) throw Error("カメラの映像が届いていません。もう一度撮るか、点だけで続けてください。");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video,0,0);
      return canvas.toDataURL("image/jpeg",.88);
    },
    async keep(url) {
      const blob = await (await fetch(url)).blob();
      const hash = await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
      const name = Array.from(new Uint8Array(hash),v => v.toString(16).padStart(2,"0")).join("")+".jpg";
      images.set(name,blob);
      return name;
    }
  };
}

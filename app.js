'use strict';
const $ = (id) => document.getElementById(id);
let context, decoder, gain, source, buffer, stream, recorder, analyser, micSource, db;
const looping = true;
let playing = false, recording = false, busy = false, rate = 1, offset = 0, recordedAt = 0;
let cuePosition = 0;
const player = $('player');
const reversePlayer = $('reverse-player');
let playbackBuffer, playbackUrl, playbackVersion = 0;

let rewinding = false, rewindResume = false;
let scratching = false, scratchResume = false, scratchAngle = 0, scratchPointer, scratchMoved = false, scratchReverseOriginal, scratchReverseBuffer;
let scratchNode, scratchModule, scratchLoadedBuffer, scratchCursor = 0;
let reverseOriginal, reverseUrl, reverseSource, reverseVersion = 0;
let selectedId = 'demo', tracks = [], chunks = [], toastTimer, recordingLimit;
let recordingName, renameId;
let lastDrawAngle, lastMenuDraw = -Infinity;
const vinylElement = $('vinyl'), platterTimeElement = $('platter-time'), seekElement = $('seek'), timeElement = $('time'), optionsElement = $('options-dialog');
const deckSeekElement = $('deck-seek'), wavePlayheadElement = $('wave-playhead');
let waveWidth = 0, lastWavePosition;
new ResizeObserver(entries => { waveWidth = entries[0].contentRect.width; }).observe(wavePlayheadElement.parentElement);
function waveformPath(samples, columns = 1000, lower = false) {
  let path = '';
  for (let column = 0; column < columns; column++) {
    const start = Math.floor(column * samples.length / columns);
    const end = Math.max(start + 1, Math.floor((column + 1) * samples.length / columns));
    let peak = 0;
    for (let index = start; index < end && index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]));
    const height = Math.min(1, peak) * 28;
    path += `M${column + .5},${lower ? 0 : 28}V${(lower ? height : 28 - height).toFixed(2)}`;
  }
  return path;
}
function renderWaveforms() {
  $('wave-left').setAttribute('d', waveformPath(buffer.getChannelData(0)));
  $('wave-right').setAttribute('d', waveformPath(buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1)), 1000, true));
}
const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function recordingTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4800); }
function setupAudio() {
  if (!context) { context = new (window.AudioContext || window.webkitAudioContext)(); gain = context.createGain(); gain.gain.value = 1; gain.connect(context.destination); }
  if (!source) { source = context.createMediaElementSource(player); source.connect(gain); }
  if (!reverseSource) { reverseSource = context.createMediaElementSource(reversePlayer); reverseSource.connect(gain); }
  player.preservesPitch = true;
  player.webkitPreservesPitch = true;
  player.mozPreservesPitch = true;
  reversePlayer.preservesPitch = true;
  reversePlayer.webkitPreservesPitch = true;
  reversePlayer.mozPreservesPitch = true;
}
async function audio() {
  setupAudio();
  if (context.state === 'suspended') await context.resume();
}
async function decodeTrack(blob) {
  if (!decoder) {
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    setupAudio();
    decoder = new OfflineContext(1, 1, context.sampleRate);
  }
  return decoder.decodeAudioData(await blob.arrayBuffer());
}
function position() { return playing && buffer && !player.seeking ? player.currentTime : offset; }
function detachSource() { playbackVersion++; player.pause(); }
function stopPlayback(reset = true) { const pos = position(); detachSource(); playing = false; offset = reset ? 0 : pos; update(); }
function startPlayback() {
  if (!buffer) return;
  detachSource();
  if (playbackBuffer !== buffer) {
    const previousUrl = playbackUrl;
    const track = tracks.find(t => t.id === selectedId);
    playbackUrl = URL.createObjectURL(track?.blob || wav(buffer));
    player.src = playbackUrl;
    playbackBuffer = buffer;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }
  if (offset >= buffer.duration) offset = 0;

  player.currentTime = offset; player.loop = looping; player.playbackRate = rate; player.preservesPitch = true;
  const version = playbackVersion;
  playing = true;
  player.play().catch(error => { if (version !== playbackVersion) return; playing = false; offset = 0; update(); handleError(error); });
  update();
}
player.onended = () => { playing = false; offset = 0; update(); };
function update() {
  $('vinyl').classList.toggle('recording', recording); $('play').classList.toggle('active', playing);
  $('record').classList.toggle('active', recording); $('record').querySelector('span:last-child').textContent = recording ? '録音終了' : '録音';
  $('record').disabled = busy || rewinding || scratching; $('play').disabled = busy || rewinding || scratching || recording; $('stop').disabled = busy; $('seek').disabled = recording || busy || rewinding || scratching;
  deckSeekElement.disabled = recording || busy || rewinding || scratching || !buffer;
  $('import-button').disabled = recording || busy || rewinding || scratching;
  $('rewind').disabled = recording || busy || scratching || !buffer;
  $('rewind').classList.toggle('active', rewinding); $('rewind').setAttribute('aria-pressed', String(rewinding));
  $('play').querySelector('span').textContent = playing ? '一時停止' : '再生';
  $('play').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('menu-play').disabled = busy || rewinding || scratching || recording || !buffer;
  $('menu-play').classList.toggle('active', playing);
  $('menu-play').setAttribute('aria-label', playing ? '選択した曲を一時停止' : '選択した曲を再生');
  $('menu-play').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('status').className = 'status sr-only' + (recording ? ' recording' : playing ? ' playing' : '');
  $('status').querySelector('span').textContent = busy ? '保存中' : recording ? '録音中' : scratching ? 'スクラッチ中' : rewinding ? '巻き戻し中' : playing ? '再生中' : '待機';
}
function renderSessions() {
  $('sessions').replaceChildren(); $('session-count').textContent = String(tracks.length).padStart(2, '0');
  for (const track of tracks) {
    const row = document.createElement('div'); row.className = 'session-row' + (track.id === selectedId ? ' active' : '');
    const choose = document.createElement('button'); choose.className = 'session-select'; choose.setAttribute('aria-label', `${track.name}を選択`); choose.setAttribute('aria-pressed', String(track.id === selectedId));
    choose.innerHTML = '<span class="session-icon"><svg class="icon"><use href="#i-' + (track.id === 'demo' ? 'play' : 'mic') + '"/></svg></span><span class="session-info"><b></b><small></small></span>';
    choose.querySelector('b').textContent = track.name; choose.querySelector('small').textContent = `${formatTime(track.duration)} · ${track.id === 'demo' ? 'デモトラック' : new Date(track.date).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}`;
    choose.onclick = () => selectTrack(track.id).catch(handleError); row.append(choose);
    if (track.id !== 'demo') {
      const rename = document.createElement('button'); rename.className = 'session-action'; rename.setAttribute('aria-label', `${track.name}の名前を変更`); rename.innerHTML = '<svg class="icon"><use href="#i-edit"/></svg>';
      rename.onclick = () => { renameId = track.id; $('rename-name').value = track.name; $('rename-dialog').showModal(); $('rename-name').select(); }; row.append(rename);
    }
    const download = document.createElement('button'); download.className = 'session-action'; download.setAttribute('aria-label', `${track.name}をダウンロード`); download.innerHTML = '<svg class="icon"><use href="#i-download"/></svg>'; download.onclick = () => downloadTrack(track).catch(handleError); row.append(download);
    if (track.id !== 'demo') { const remove = document.createElement('button'); remove.className = 'session-action'; remove.setAttribute('aria-label', `${track.name}を削除`); remove.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>'; remove.onclick = () => deleteTrack(track).catch(handleError); row.append(remove); }
    $('sessions').append(row);
  }
}
async function selectTrack(id) {
  if (recording || busy) { toast('録音が終わってから選択できます。'); return; }
  const track = tracks.find(t => t.id === id); if (!track) return;
  endScratch(false);
  endRewind(false);
  busy = true; stopPlayback(); update();
  try { await audio(); const next = track.buffer || await decodeTrack(track.blob); track.buffer = next; buffer = next; selectedId = id; cuePosition = 0;
    for (const other of tracks) if (other !== track) delete other.buffer;
    playbackBuffer = null; player.removeAttribute('src'); player.load();
    if (playbackUrl) { URL.revokeObjectURL(playbackUrl); playbackUrl = null; }
    renderWaveforms();
    await warmReversePlayback();
    await prepareScratchPlayback();
    $('track-title').replaceChildren(document.createTextNode(track.name)); renderSessions();
  } finally { busy = false; update(); }
}
async function renameTrack(track, value) {
  const name = value.trim();
  if (!name || name.length > 80) throw new Error('Invalid track name');
  if (db) {
    const { buffer: unused, ...stored } = track;
    await database('readwrite', store => store.put({ ...stored, name }));
  }
  track.name = name;
  if (selectedId === track.id) $('track-title').textContent = name;
  renderSessions();
}
function handleError(error) { console.error(error); toast('音声を処理できませんでした。別のファイルやブラウザでお試しください。'); }
function openDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open('loop-room', 1); request.onupgradeneeded = () => request.result.createObjectStore('tracks', { keyPath: 'id' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function database(mode, action) { return new Promise((resolve, reject) => { const tx = db.transaction('tracks', mode); const request = action(tx.objectStore('tracks')); let result; request.onsuccess = () => { result = request.result; }; tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
async function saveTrack(blob, name) {
  const decoded = await decodeTrack(blob);
  if (!decoded.duration) throw new Error('Empty audio');
  const track = { id: crypto.randomUUID(), name, date: Date.now(), duration: decoded.duration, blob, buffer: decoded };
  if (db) { try { const { buffer: unused, ...stored } = track; await database('readwrite', store => store.put(stored)); } catch { toast('端末への保存に失敗しました。ダウンロードで音声を保存してください。'); } }
  else toast('このブラウザでは保存できません。ダウンロードで音声を保存してください。');
  tracks.push(track); return track;
}
function releaseMic() { clearTimeout(recordingLimit); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; if (micSource) micSource.disconnect(); if (analyser) analyser.disconnect(); micSource = null; analyser = null; }
async function startRecording() {
  if (busy) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { toast('マイクを使うには HTTPS または localhost で開いてください。'); return; }
  if (!window.MediaRecorder) { toast('このブラウザは録音に対応していません。'); return; }
  busy = true; stopPlayback(); update();
  try {
    await audio(); stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); chunks = [];
    micSource = context.createMediaStreamSource(stream); analyser = context.createAnalyser(); analyser.fftSize = 256; micSource.connect(analyser);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const type = recorder.mimeType; releaseMic(); recording = false; busy = true; update();
      try { if (!chunks.length) throw new Error('Empty recording'); const blob = new Blob(chunks, { type }); const track = await saveTrack(blob, recordingName); busy = false; await selectTrack(track.id); if (db) toast('録音しました。再生してみましょう。'); }
      catch (error) { handleError(error); } finally { busy = false; update(); }
    };
    recorder.onerror = () => { if (recorder.state !== 'inactive') recorder.stop(); releaseMic(); recording = false; busy = false; update(); toast('録音が中断されました。'); };
    recordingName = recordingTimestamp(); recorder.start(250); recordedAt = performance.now(); recording = true;
    recordingLimit = setTimeout(() => { endRecording(); toast('10分に達したため録音を保存します。'); }, 600000);
  } catch (error) { releaseMic(); const messages = { NotAllowedError: 'マイクの利用を許可して、もう一度録音してください。', NotFoundError: 'マイクが見つかりません。端末の接続を確認してください。', NotReadableError: 'マイクを使用中の別のアプリを閉じてください。' }; toast(messages[error.name] || '録音を開始できませんでした。'); }
  finally { busy = false; update(); }
}
function endRecording() { if (recorder?.state === 'recording') { busy = true; recorder.stop(); update(); } }
function wav(b) {
  const channels = b.numberOfChannels, frames = b.length, ab = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(ab);
  const word = (at, value) => { for (let j = 0; j < value.length; j++) view.setUint8(at + j, value.charCodeAt(j)); };
  word(0, 'RIFF'); view.setUint32(4, ab.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, b.sampleRate, true); view.setUint32(28, b.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, ab.byteLength - 44, true);
  const data = Array.from({ length: channels }, (_, c) => b.getChannelData(c)); let at = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) { const s = Math.max(-1, Math.min(1, data[c][i])); view.setInt16(at, s < 0 ? s * 32768 : s * 32767, true); at += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}
async function downloadTrack(track) { await audio(); const decoded = track.buffer || await decodeTrack(track.blob); const url = URL.createObjectURL(wav(decoded)); const a = document.createElement('a'); a.href = url; a.download = track.name.replace(/[\\/:*?"<>|]/g, '_') + '.wav'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
async function deleteTrack(track) {
  if (recording || busy) { toast('音声の処理が終わってから削除できます。'); return; }
  if (!confirm(`「${track.name}」を削除しますか？`)) return;
  if (db) await database('readwrite', store => store.delete(track.id));
  tracks = tracks.filter(t => t.id !== track.id); if (selectedId === track.id) await selectTrack('demo'); renderSessions(); toast('セッションを削除しました。');
}
function rotationAngle(elapsed) { return elapsed * 90; }
function scratchDelta(previous, next) { return ((next - previous + 540) % 360) - 180; }
async function prepareScratchPlayback() {
  setupAudio();
  if (!scratchModule) scratchModule = context.audioWorklet.addModule(new URL('scratch-worklet.js?v=20261005-2', document.baseURI).href).catch(error => { scratchModule = null; throw error; });
  await scratchModule;
  if (!scratchNode) {
    scratchNode = new AudioWorkletNode(context, 'turntable-scratch', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    scratchNode.connect(gain);
    scratchNode.onprocessorerror = () => { endScratch(false); handleError(new Error('Scratch processor failed')); };
  }
  if (scratchLoadedBuffer !== buffer) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice());
    await new Promise(resolve => {
      scratchNode.port.onmessage = event => { if (event.data.type === 'loaded') resolve(); };
      scratchNode.port.postMessage({ type: 'load', channels, sampleRate: buffer.sampleRate }, channels.map(channel => channel.buffer));
    });
    scratchLoadedBuffer = buffer;
  }
}
function moveScratch(delta, seconds) {
  if (!scratchNode || scratchLoadedBuffer !== buffer) return;
  if (!scratching) {
    setupAudio();
    offset = position(); scratchResume = playing;
    scratchAngle = rotationAngle(offset);
    scratchCursor = offset;
    scratchNode.port.postMessage({ type: 'start', position: scratchCursor });
    detachSource(); playing = false; scratching = true; update();
    audio().catch(handleError);
  }
  scratchCursor += delta / 90;
  offset = ((scratchCursor % buffer.duration) + buffer.duration) % buffer.duration;
  scratchAngle = rotationAngle(offset);
  scratchNode.port.postMessage({ type: 'move', position: scratchCursor, seconds });
}
function endScratch(resume = true) {
  scratchPointer = null;
  if (!scratching) return;
  scratchNode?.port.postMessage({ type: 'stop' }); scratching = false;
  const restart = scratchResume; scratchResume = false;
  if (resume && restart && !busy && !recording) startPlayback(); else update();
}
function reverseAudio(input, audioContext) {
  const reversed = audioContext.createBuffer(input.numberOfChannels, input.length, input.sampleRate);
  for (let channel = 0; channel < input.numberOfChannels; channel++) {
    const original = input.getChannelData(channel), output = reversed.getChannelData(channel);
    for (let frame = 0; frame < input.length; frame++) output[frame] = original[input.length - 1 - frame];
  }
  return reversed;
}
function prepareReversePlayback() {
  if (reverseOriginal === buffer) return;
  if (scratchReverseOriginal !== buffer) {
    scratchReverseBuffer = reverseAudio(buffer, context);
    scratchReverseOriginal = buffer;
  }
  const previousUrl = reverseUrl;
  const track = tracks.find(item => item.id === selectedId);
  reverseUrl = URL.createObjectURL(track?.reverseBlob || wav(scratchReverseBuffer));
  reversePlayer.src = reverseUrl;
  reverseOriginal = buffer;
  reversePlayer.load();
  if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
}
async function warmReversePlayback() {
  prepareReversePlayback();
  if (reversePlayer.readyState >= 2) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { reversePlayer.removeEventListener('loadeddata', ready); reversePlayer.removeEventListener('error', failed); };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Reverse audio could not be loaded')); };
    reversePlayer.addEventListener('loadeddata', ready, { once: true });
    reversePlayer.addEventListener('error', failed, { once: true });
    if (reversePlayer.readyState >= 2) ready();
    else if (reversePlayer.error) failed();
  });
}
function advanceRewind() {
  // currentTime can still describe the previous position until the seek completes.
  if (!rewinding || reversePlayer.seeking || reversePlayer.readyState < 2) return;
  offset = Math.max(0, buffer.duration - reversePlayer.currentTime);
}
function startRewind() {
  if (rewinding || scratching || recording || busy || !buffer) return false;
  try { setupAudio(); prepareReversePlayback(); } catch (error) { handleError(error); return false; }
  offset = position(); rewindResume = playing; detachSource(); playing = false;
  reversePlayer.currentTime = buffer.duration - offset;
  reversePlayer.loop = false; reversePlayer.playbackRate = 2; reversePlayer.preservesPitch = true;
  rewinding = true;
  const version = ++reverseVersion;
  if (offset > 0) audio().then(() => { if (rewinding && version === reverseVersion) return reversePlayer.play(); }).catch(error => { if (version !== reverseVersion) return; endRewind(false); handleError(error); });
  update(); return true;
}
function endRewind(resume = true) {
  if (!rewinding) return;
  advanceRewind(); rewinding = false; reverseVersion++; reversePlayer.pause();
  const restart = rewindResume; rewindResume = false;
  if (resume && restart && !busy && !recording) startPlayback(); else update();
}
reversePlayer.onended = () => { if (rewinding) offset = 0; };
function draw() {
  advanceRewind();
  const pos = position(), progress = buffer ? pos / buffer.duration : 0;
  const seekValue = String(Math.round(progress * 1000));
  if (deckSeekElement.value !== seekValue) deckSeekElement.value = seekValue;
  const wavePosition = Math.round(progress * waveWidth * 10) / 10;
  if (wavePosition !== lastWavePosition) {
    wavePlayheadElement.style.transform = `translate3d(${wavePosition}px,0,0) translateX(-50%)`;
    lastWavePosition = wavePosition;
  }


  const angle = scratching ? scratchAngle : recording ? rotationAngle((performance.now() - recordedAt) / 1000) : rotationAngle(pos);
  if (angle !== lastDrawAngle) { vinylElement.style.setProperty('--angle', `${angle}deg`); lastDrawAngle = angle; }
  const elapsed = formatTime(recording ? (performance.now() - recordedAt) / 1000 : pos);
  if (platterTimeElement.textContent !== elapsed) platterTimeElement.textContent = elapsed;
  const now = performance.now();
  if (optionsElement.open && now - lastMenuDraw >= 100) {
    lastMenuDraw = now;
    seekElement.value = Math.round(progress * 1000);
    const text = recording ? elapsed : `${elapsed} / ${formatTime(buffer?.duration || 0)}`;
    if (timeElement.textContent !== text) timeElement.textContent = text;
  }
  requestAnimationFrame(draw);
}
$('record').onclick = () => recording ? endRecording() : startRecording();
$('rewind').addEventListener('pointerdown', event => { if (event.button !== 0 || !event.isPrimary) return; if (startRewind()) { event.preventDefault(); $('rewind').setPointerCapture(event.pointerId); } });
$('rewind').addEventListener('pointerup', () => endRewind());
$('rewind').addEventListener('pointercancel', () => endRewind(false));
$('rewind').addEventListener('lostpointercapture', () => endRewind());
$('rewind').addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) startRewind(); } });
$('rewind').addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); endRewind(); } });
$('rewind').addEventListener('blur', () => endRewind());
$('rewind').addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('blur', () => { endScratch(false); endRewind(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { endScratch(false); endRewind(false); } });
$('play').onclick = async () => { if (busy || recording || rewinding || scratching) return; if (playing) { stopPlayback(false); return; } try { await audio(); startPlayback(); } catch (e) { handleError(e); } };
$('menu-play').onclick = () => $('play').onclick();
$('stop').onclick = () => {
  if (busy) return;
  const wasPlaying = playing || (rewinding && rewindResume) || (scratching && scratchResume);
  endScratch(false); endRewind(false);
  if (recording) { stopPlayback(); endRecording(); return; }
  if (!buffer) return;
  if (wasPlaying) { stopPlayback(false); offset = cuePosition; player.currentTime = cuePosition; }
  else cuePosition = position();
  update();
};
$('speed').oninput = e => { rate = 2 ** Number(e.target.value); player.preservesPitch = true; player.playbackRate = rate; $('speed-value').textContent = rate.toFixed(2) + '×'; e.target.setAttribute('aria-valuetext', rate.toFixed(2) + '倍'); };
$('speed-reset').onclick = () => { $('speed').value = '0'; $('speed').oninput({ target: $('speed') }); };
function seekTo(value) {
  if (!buffer || recording || busy || rewinding || scratching) return;
  offset = Number(value) / 1000 * buffer.duration;
  if (playing) startPlayback();
}
$('seek').oninput = e => seekTo(e.target.value);
deckSeekElement.oninput = e => seekTo(e.target.value);
$('import-button').onclick = () => $('import-file').click();
$('import-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file || recording || busy) return;
  if (file.size > 50 * 1024 * 1024) { toast('50 MB 以下の音声ファイルを選んでください。'); return; }
  busy = true; stopPlayback(); update();
  try { await audio(); const track = await saveTrack(file, file.name.replace(/\.[^.]+$/, '')); busy = false; await selectTrack(track.id); }
  catch (error) { handleError(error); } finally { busy = false; update(); }
};
$('open-options').onclick = () => { endScratch(false); endRewind(false); $('options-dialog').showModal(); };
$('close-options').onclick = () => $('options-dialog').close();
$('cancel-rename').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = async event => {
  event.preventDefault();
  const track = tracks.find(item => item.id === renameId);
  const name = $('rename-name').value.trim();
  if (!track || !name) { $('rename-name').setCustomValidity('名前を入力してください。'); $('rename-name').reportValidity(); return; }
  $('save-rename').disabled = true;
  try { await renameTrack(track, name); $('rename-dialog').close(); }
  catch (error) { console.error(error); toast('名前を保存できませんでした。もう一度お試しください。'); }
  finally { $('save-rename').disabled = false; }
};
$('rename-name').oninput = () => $('rename-name').setCustomValidity('');
$('vinyl').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || recording || busy || rewinding || !buffer) return;
  audio().catch(handleError);
  const rect = $('vinyl').getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  scratchMoved = false;
  scratchPointer = { id: event.pointerId, cx, cy, x: event.clientX, y: event.clientY, angle: Math.atan2(event.clientY - cy, event.clientX - cx) * 180 / Math.PI, time: event.timeStamp };
  $('vinyl').setPointerCapture(event.pointerId);
});
$('vinyl').addEventListener('pointermove', event => {
  const pointer = scratchPointer;
  if (!pointer || pointer.id !== event.pointerId) return;
  if (!scratchMoved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
  scratchMoved = true; event.preventDefault();
  const angle = Math.atan2(event.clientY - pointer.cy, event.clientX - pointer.cx) * 180 / Math.PI;
  try { moveScratch(scratchDelta(pointer.angle, angle), (event.timeStamp - pointer.time) / 1000); }
  catch (error) { endScratch(false); handleError(error); }
  pointer.angle = angle; pointer.time = event.timeStamp;
});
$('vinyl').addEventListener('pointerup', () => endScratch());
$('vinyl').addEventListener('pointercancel', () => endScratch(false));
$('vinyl').addEventListener('lostpointercapture', () => endScratch());
$('vinyl').addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('pagehide', releaseMic);
// Keep the mobile viewport fixed, including Safari's gesture events.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, event => event.preventDefault(), { passive: false });
for (const type of ['touchstart', 'touchmove']) document.addEventListener(type, event => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', event => event.preventDefault());
async function init() {
  // Load the bundled demo locally without requesting a microphone or starting playback.
  setupAudio(); busy = true; update(); draw();
  try {
    const [response, reverseResponse] = await Promise.all([
      fetch(new URL('demo.mp3', document.baseURI)),
      fetch(new URL('demo-reverse.mp3', document.baseURI))
    ]);
    if (!response.ok || !reverseResponse.ok) throw new Error('Demo audio could not be loaded');
    const blob = await response.blob();
    const reverseBlob = await reverseResponse.blob();
    buffer = await decodeTrack(blob);
    tracks = [{ id: 'demo', name: 'Discourse on the Method', duration: buffer.duration, blob, buffer, reverseBlob }];
    renderWaveforms();
    await warmReversePlayback();
    await prepareScratchPlayback();
    $('track-title').textContent = tracks[0].name; renderSessions();
  } finally { busy = false; update(); }
  try { db = await openDatabase(); const saved = await database('readonly', store => store.getAll()); tracks.push(...saved.sort((a, b) => a.date - b.date)); renderSessions(); } catch { toast('端末への保存が使えません。録音後は音声をダウンロードしてください。'); }
}
init().catch(handleError);



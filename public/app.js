/* 局域网文件传输 — WebRTC 点对点直连客户端 */
'use strict';

const CHUNK = 64 * 1024;        // 每片 64KB
const BUF_HIGH = 1 * 1024 * 1024; // 超过 1MB 暂停发送（背压）
const BUF_LOW = 256 * 1024;    // 低于 256KB 恢复发送
const RECV_READY_TIMEOUT = 5 * 60 * 1000; // 发送端等待接收端"保存/就绪"的最长时长

// DOM
const $ = (id) => document.getElementById(id);
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const randomBtn = $('randomBtn');
const joinSection = $('joinSection');
const transferSection = $('transferSection');
const statusDot = $('statusDot');
const statusText = $('statusText');
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const lists = $('lists');
const leaveBtn = $('leaveBtn');

// 状态
let ws = null;
let pc = null;
let sendChannel = null;
let recvChannel = null;
let polite = false;
let makingOffer = false;
let ignoreOffer = false;
let candidateQueue = [];
let wsRetry = 0;        // WebSocket 重连退避计数
let joinedRoom = '';     // 已加入的房间码，用于断线自动重连
let reconnectTimer = null; // 待触发的重连定时器，避免手动连接产生双连接
let fsSupported = ('showSaveFilePicker' in window); // File System Access API 仅在安全上下文（HTTPS/localhost）可用
const sendCtxById = new Map();   // id -> { file, item, size }，断点续传用，resetConnection 不清空
const pendingRecvReady = new Map(); // id -> { resolve, timer }，发送端等待接收端就绪
const resuming = new Set();      // 正在进行续传的 id，避免重复触发
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // 默认 STUN，运行时可被 /config.json 覆盖（部署时设 ICE_SERVERS 环境变量）
// 拉取服务端透出的 ICE 配置（含可选 TURN），避免前端硬编码；包装成 promise 供 createConnection await
const iceConfigReady = (async () => {
  try {
    const r = await fetch('/config.json', { cache: 'no-store' });
    if (r.ok) { const c = await r.json(); if (Array.isArray(c.iceServers)) iceServers = c.iceServers; }
  } catch (e) { /* 用默认 STUN */ }
})();

/* ---------- 状态显示 ---------- */
function setStatus(text, state) {
  statusText.textContent = text;
  statusDot.className = 'dot ' + (state || 'off');
}

/* ---------- WebSocket 信令 ---------- */
function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { // 幂等：清理旧连接，避免自动重连与手动连接产生两条 WebSocket
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (e) {}
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    wsRetry = 0;
    if (joinedRoom) doJoin();
    else setStatus('未连接', 'off');
  };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; } // 局域网内任意可连 3000 端口的程序都可能发非法 JSON，解析失败直接忽略，避免白屏
    handleWs(msg);
  };
  ws.onclose = () => {
    setStatus('连接已断开，重连中…', 'off');
    resetConnection();
    const delay = Math.min(1000 * 2 ** wsRetry, 10000); // 指数退避，最多 10s
    wsRetry++;
    reconnectTimer = setTimeout(connect, delay);
  };
  ws.onerror = () => { /* 重连由 onclose 统一处理 */ };
}

function doJoin() {
  const room = (joinedRoom || roomInput.value).trim(); // 重连时优先用 joinedRoom（roomInput 可能已被清空）
  if (!room) { alert('请输入房间码'); return; }
  joinedRoom = room;
  ws.send(JSON.stringify({ type: 'join', room }));
  joinSection.querySelector('.row').style.opacity = '.55';
  joinSection.querySelector('.row').style.pointerEvents = 'none';
  joinBtn.textContent = '已加入';
}

function handleWs(msg) {
  switch (msg.type) {
    case 'joined':
      setStatus(msg.peers === 1 ? '等待对方加入…' : '已连接', 'wait');
      leaveBtn.hidden = false; // 已进入房间（等待或已连接）即展示离开按钮，方便中途换房，不必刷新
      break;
    case 'peer-ready':
      if (!pc) createConnection(msg.polite).catch((e) => console.error(e)); // createConnection 已改为 async，加 catch 避免异常冒泡到 handleWs
      break;
    case 'signal':
      onSignal(msg.data);
      break;
    case 'full':
      setStatus('房间已满（仅支持两人）', 'off');
      alert('该房间已有两人，请换一个房间码。');
      joinedRoom = '';
      resetConnection({ full: true }); // 可能正连在旧房间，先断开旧 P2P，避免留下孤儿连接、且 WS 抖动后无法重连回原房间
      break;
    case 'peer-left':
      setStatus('对方已离开，等待对方重新加入…', 'wait');
      resetConnection({ keepJoinUI: true }); // 保留 joinedRoom 与"已加入"外观，对方重连后 peer-ready 自动恢复
      break;
    case 'bad-room':
      setStatus('房间码无效（长度 1-64）', 'off');
      alert('房间码无效，请使用 1-64 个字符的房间码。');
      joinedRoom = '';
      resetConnection({ full: true }); // 与 'full' 同理：之前可能正连在旧房间的 P2P 上，先断开避免孤儿连接
      break;
  }
}

function signalRelay(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', data }));
  }
}

/* ---------- WebRTC 连接（完美协商） ---------- */
async function createConnection(isPolite) {
  await iceConfigReady; // 保证 TURN 配置已就绪，避免 ?room= 自动加入时 fetch 尚未返回而退化为硬编码 STUN（跨公网 TURN 失效）
  // 期间 WS 可能已断开并重启：此时创建 pc 会变成孤儿（resetConnection 已错过它），
  // 且会因 pc 非空导致重连后的 peer-ready 被跳过，永远协商不上。先查 ws 存活再建 pc。
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (pc) return; // 期间已被更早/并发的调用建立（如刚加载时 WS 断开重连又收到 peer-ready），直接复用，避免 pc 对象泄漏
  polite = isPolite; // 角色由服务端分配，保证双方一正一反，杜绝 25% 死锁
  pc = new RTCPeerConnection({ iceServers });

  sendChannel = pc.createDataChannel('file');
  setupChannel(sendChannel);

  pc.ondatachannel = (e) => {
    recvChannel = e.channel;
    setupChannel(recvChannel);
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      signalRelay({ description: pc.localDescription });
    } catch (err) {
      console.error('协商失败', err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) signalRelay({ candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      setStatus('已连接 · 可传输文件', 'on');
      transferSection.hidden = false;
      leaveBtn.hidden = false;
      updateSendable(); // DataChannel 可能已先 open，这里兜底确保拖拽区可用
    } else if (s === 'connecting') {
      setStatus('正在建立连接…', 'wait');
    } else if (s === 'failed' || s === 'closed') {
      setStatus('连接断开', 'off');
    } else if (s === 'disconnected') {
      // WebRTC 的 disconnected 是可能自恢复的临时状态（切 WiFi、网络抖动），通常几秒后回到 connected
      setStatus('连接不稳定…', 'wait');
    }
  };
}

function setupChannel(ch) {
  ch.binaryType = 'arraybuffer';
  ch.onopen = () => {
    updateSendable();
    if (ch === recvChannel) maybeResume(); // 接收通道重开（重连）时，若传输中断则请求续传
  };
  ch.onclose = updateSendable;
  ch.onmessage = onChannelMessage;
}

function updateSendable() {
  // 只判断 DataChannel 是否真的可写——DataChannel open 通常早于 pc connectionState 变更
  const ok = sendChannel && sendChannel.readyState === 'open';
  dropzone.style.opacity = ok ? '1' : '.5';
  dropzone.style.pointerEvents = ok ? 'auto' : 'none';
}

async function onSignal({ description, candidate }) {
  if (!pc) return;
  try {
    if (description) {
      const offerCollision =
        description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(description);
      // 冲刷缓冲的候选
      for (const c of candidateQueue) {
        try { await pc.addIceCandidate(c); } catch (e) { /* ignore */ }
      }
      candidateQueue = [];

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        signalRelay({ description: pc.localDescription });
      }
    } else if (candidate) {
      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        candidateQueue.push(candidate);
      } else {
        try { await pc.addIceCandidate(candidate); } catch (e) {
          if (!ignoreOffer) console.warn('addIceCandidate', e);
        }
      }
    }
  } catch (err) {
    console.error('信令处理失败', err);
  }
}

function resetConnection({ keepJoinUI = false, full = false } = {}) {
  // 断开/对端离开时默认保留在传文件上下文（recvCtx 未 done 即保留），供断点续传；
  // 只有用户主动"离开房间"传 full:true 才彻底清空。语义清晰，不再有 keepTransfer 被强行覆盖的歧义。
  // 有未完成的接收 → 保留；列表里已经有完成的条目 → 也保留（避免断线抖动清空历史）
  const keepTransfer = !full && (
    (recvCtx && !recvCtx.done) ||
    lists.querySelector('.item.done') !== null
  );
  candidateQueue = [];
  sendQueue.length = 0; // 清空进行中的发送队列（sendCtxById 保留，支持续传）
  // 释放已生成但未下载的接收 Blob URL：仅在确实清空传输（full 主动离开 / 无已完成历史）时 revoke，
  // 否则与 keepTransfer 保留下来的「已完成」下载链接脱节，导致断线重连后旧链接变死链
  if (!keepTransfer) {
    for (const { url } of recvUrls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    recvUrls.length = 0;
  }
  // 解除所有等待接收端就绪的 Promise：直接以 false resolve，避免对端掉线后发送端卡在 waitRecvReady 最长 5 分钟
  for (const { resolve, timer } of pendingRecvReady.values()) {
    clearTimeout(timer);
    resolve(false);
  }
  pendingRecvReady.clear();
  if (sendChannel) { try { sendChannel.close(); } catch (e) {} }
  if (recvChannel) { try { recvChannel.close(); } catch (e) {} }
  if (pc) {
    // 先解绑事件再 close：pc.close() 会异步把 connectionState 置为 closed 并触发 onconnectionstatechange，
    // 若不在此解绑，handler 执行时 pc 已被置空，读到 null.connectionState 抛 TypeError
    pc.onconnectionstatechange = null;
    pc.onicecandidate = null;
    pc.onnegotiationneeded = null;
    pc.ondatachannel = null;
    try { pc.close(); } catch (e) {}
  }
  pc = sendChannel = recvChannel = null;
  if (!keepTransfer) {
    if (recvCtx && recvCtx.writer) { try { recvCtx.writer.abort(); } catch (e) {} } // 放弃未完成的落盘
    recvCtx = null;
    lists.innerHTML = '';
  }
  transferSection.hidden = true;
  leaveBtn.hidden = !keepJoinUI; // 等待对方重连时仍保留离开按钮，避免用户被困住只能刷新
  if (keepJoinUI) {
    // peer-left：保留 joinedRoom 等待对方重连，加入行维持"已加入"外观，
    // 对方重新加入时服务端发 peer-ready，会重新 createConnection 自动恢复
    joinSection.querySelector('.row').style.opacity = '.55';
    joinSection.querySelector('.row').style.pointerEvents = 'none';
    joinBtn.textContent = '已加入';
  } else {
    resetJoinUI();      // 恢复加入行，避免 UI 卡死
    if (full) roomInput.value = ''; // 只在用户主动离开时清空输入框，断线重连不清（joinedRoom 仍在，重连后自动 doJoin）
  }
}

function resetJoinUI() {
  const row = joinSection.querySelector('.row');
  row.style.opacity = '1';
  row.style.pointerEvents = 'auto';
  joinBtn.textContent = '加入';
}

/* ---------- 文件发送（发送端串行化，避免多文件分片交错） ---------- */
const sendQueue = [];
let sending = false;

function queueFile(file) {
  const id = fileId(); // 用 crypto 生成，避免与续传 key 碰撞
  const item = addItem(id, file.name, file.size, '发送', false);
  sendCtxById.set(id, { file, item, size: file.size }); // 保留引用，断点续传时按 id 找回
  sendQueue.push({ id, item });
  pump();
}

async function pump() {
  if (sending) return;
  sending = true;
  try {
    while (sendQueue.length) {
      const { id, item } = sendQueue.shift();
      try {
        await sendFile(id, item);
      } catch (err) {
        // 单个文件失败绝不能穿透 while 循环，否则 sending 永远 = true 导致整页死锁
        console.error('发送文件失败', err);
        fail(item, id, '发送失败'); // 统一收口，失败提示与重试按钮交给 fail()，避免与 try 内分支逻辑漂移
      }
    }
  } finally {
    sending = false;
  }
}

function retryFile(id) {
  const ctx = sendCtxById.get(id);
  if (!ctx) return;
  delete ctx.rejected; // 清空上次的拒绝标记，避免重试后对方超时（resolve(false)）被误报为「对方拒绝接收」
  sendQueue.push({ id, item: ctx.item }); // sendCtxById 保留着 file 引用，断点续传时按 id 找回
  pump();
}

function addRetryButton(item, id) {
  let actions = item.querySelector('.item-actions');
  if (!actions) { actions = document.createElement('div'); actions.className = 'item-actions'; item.appendChild(actions); }
  if (actions.querySelector('.retry')) return;
  const btn = document.createElement('button');
  btn.className = 'retry';
  btn.textContent = '重试';
  btn.addEventListener('click', () => { btn.remove(); retryFile(id); });
  actions.appendChild(btn);
}

// 发送失败的统一收尾：给出提示并补一个重试入口（重试不靠重新拖文件，sendCtxById 里还存着 file）
function fail(item, id, msg) {
  setMeta(item, msg);
  addRetryButton(item, id);
}

async function sendFile(id, item, startOffset = 0) {
  const ctx = sendCtxById.get(id);
  if (!ctx) return fail(item, id, '发送失败');
  const { file, size } = ctx;
  if (!sendChannel || sendChannel.readyState !== 'open') return fail(item, id, '连接已断开');
  if (startOffset === 0) {
    // 全新传输：先发元信息，等接收端就绪（手势保存 / Blob 兜底）后再发分片，避免发送端空等
    sendChannel.send(JSON.stringify({ type: 'file-meta', id, name: file.name, size, mime: file.type }));
    if (!await waitRecvReady(id)) {
      // 对方拒绝/超时：给出准确提示，并提供重试入口（重新发 file-meta 即可再提议）
      const rejected = sendCtxById.get(id)?.rejected;
      setMeta(item, rejected ? '对方拒绝接收' : '对方未保存');
      addRetryButton(item, id);
      return;
    }
    // await 期间连接可能已断开并置空 sendChannel，写属性前必须复查，避免 TypeError: Cannot set properties of null
    if (!sendChannel || sendChannel.readyState !== 'open') return fail(item, id, '连接中断');
  }
  sendChannel.bufferedAmountLowThreshold = BUF_LOW;
  let offset = startOffset; // 续传时从断点开始，不重发 file-meta
  while (offset < size) {
    if (sendChannel.readyState !== 'open') return fail(item, id, '连接中断');
    if (sendChannel.bufferedAmount > BUF_HIGH) {
      // 对端在背压期间掉线时 bufferedamountlow 不会触发，必须同时监听 close 以防永久挂起
      const ch = sendChannel;
      await new Promise((res) => {
        const done = () => {
          ch.removeEventListener('close', done);
          ch.onbufferedamountlow = null;
          res();
        };
        ch.onbufferedamountlow = done;
        ch.addEventListener('close', done, { once: true });
      });
      if (ch.readyState !== 'open') return fail(item, id, '连接中断');
    }
    const end = Math.min(offset + CHUNK, size);
    const buf = await file.slice(offset, end).arrayBuffer();
    // arrayBuffer() 是异步的，挂起期间对端可能已掉线并把 sendChannel 置空，发送前必须复查
    if (!sendChannel || sendChannel.readyState !== 'open') {
      return fail(item, id, '连接中断'); // 统一收口，确保这条失败分支也有重试入口
    }
    sendChannel.send(buf);
    offset = end;
    setProgress(item, offset, size);
  }
  sendChannel.send(JSON.stringify({ type: 'file-done', id }));
  setProgress(item, size, size); // 收尾确保进度条跳到 100%
  item.classList.add('done');
  setMeta(item, '已发送');
  sendCtxById.delete(id); // 发送完成，无需再续传
}

function waitRecvReady(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRecvReady.delete(id);
      resolve(false); // 超时：接收端迟迟未保存，放弃该文件
    }, RECV_READY_TIMEOUT);
    pendingRecvReady.set(id, { resolve, timer });
  });
}

/* ---------- 文件接收（单一 recvCtx，发送端已串行化，分片不会交错） ---------- */
let recvCtx = null; // { meta, chunks, received, item }
const recvUrls = []; // 接收端生成的 Blob URL 记录，结构 { url, a }；超过上限释放最旧的并禁用对应下载按钮
const MAX_RECV_URLS = 8;

async function onChannelMessage(e) {
  if (typeof e.data === 'string') {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { console.error('收到非法信令', err); return; }
    if (msg.type === 'file-meta') {
      onFileMeta(msg);
    } else if (msg.type === 'file-done') {
      if (!recvCtx || recvCtx.done) return;
      const ctx = recvCtx; // 局部引用：writer.close() 异步期间可能触发 resetConnection 置空 recvCtx
      recvCtx = null; // 先清空，避免 await 期间被同 id 新 file-meta 复用（发送端恰在此时重试）导致新节点被标「已完成」、进度错位
      ctx.done = true;
      if (ctx.writer) {
        // 流式落盘：文件已写入磁盘，无需下载链接
        try { await ctx.writer.close(); } catch (err) { /* ignore */ }
        ctx.item.classList.add('done');
        setMeta(ctx.item, '已保存到本地');
      } else {
        const blob = new Blob(ctx.chunks, { type: ctx.meta.mime || '' });
        finishReceive(ctx.item, URL.createObjectURL(blob));
      }
    } else if (msg.type === 'recv-ready') {
      // 接收端已就绪（手势保存 / Blob 兜底），解除发送端等待
      const p = pendingRecvReady.get(msg.id);
      if (p) { clearTimeout(p.timer); pendingRecvReady.delete(msg.id); p.resolve(true); }
    } else if (msg.type === 'resume-request') {
      // 接收端请求从断点续传
      if (resuming.has(msg.id)) return;
      const ctx = sendCtxById.get(msg.id);
      if (!ctx) return;
      if (msg.offset >= ctx.size) {
        // 接收端已有全部字节，只是 file-done 在断线窗口丢了：重发 file-done 收尾即可
        if (sendChannel && sendChannel.readyState === 'open') {
          sendChannel.send(JSON.stringify({ type: 'file-done', id: msg.id }));
          sendCtxById.delete(msg.id);
        }
        return;
      }
      resuming.add(msg.id);
      sendFile(msg.id, ctx.item, msg.offset).finally(() => resuming.delete(msg.id));
    } else if (msg.type === 'recv-reject') {
      // 接收端拒绝接收：立即解除发送端等待（若还在等），并标记失败，避免发送端空等 5 分钟
      const p = pendingRecvReady.get(msg.id);
      if (p) { clearTimeout(p.timer); pendingRecvReady.delete(msg.id); p.resolve(false); }
      const ctx = sendCtxById.get(msg.id);
      if (ctx) ctx.rejected = true;
    }
  } else if (recvCtx && !recvCtx.done) {
    // 二进制分片：有可写流则直接落盘（流式，不占内存）；否则累积到内存（Blob 兜底）
    const ctx = recvCtx; // 局部引用：await 写盘期间可能触发 resetConnection 置空 recvCtx
    if (ctx.writer) {
      try { await ctx.writer.write(e.data); } catch (err) { console.error('写入失败', err); }
    } else {
      ctx.chunks.push(e.data);
    }
    // 写盘返回后若已被 reset（ctx 不再是当前 recvCtx 或已标记完成），不再更新，避免读空引用
    if (ctx === recvCtx && !ctx.done) {
      ctx.received += e.data.byteLength;
      setProgress(ctx.item, ctx.received, ctx.meta.size);
    }
  }
}

function onFileMeta(msg) {
  if (recvCtx && !recvCtx.done) {
    // 收到新的 file-meta 而仍有未完成的接收：放弃上一个（避免落盘流泄漏/静默丢文件），开始新的
    console.warn('收到新的 file-meta，放弃上一个未完成的接收', recvCtx.id);
    if (recvCtx.writer) { try { recvCtx.writer.abort(); } catch (e) {} }
    recvCtx.done = true;
  }
  // 同一 id 重试时复用原 DOM 条目，避免列表里出现两条同名项
  let item = lists.querySelector(`.item[data-id="${CSS.escape(msg.id)}"]`); // CSS.escape 防御任意 id 破坏选择器
  if (item) {
    item.classList.remove('done');
    const bar = item.querySelector('.bar > i'); if (bar) bar.style.width = '0%';
    const actions = item.querySelector('.item-actions'); if (actions) actions.remove();
  } else {
    item = addItem(msg.id, msg.name, msg.size, '接收', true);
  }
  recvCtx = { id: msg.id, meta: msg, item, received: 0, chunks: [], writer: null, done: false };
  if (fsSupported) {
    setMeta(item, '等待你选择保存位置');
    addSaveButton(item, msg);
  } else {
    setMeta(item, '接收中');
    sendRecvReady(msg.id); // 不支持 FS Access（如 HTTP 局域网 IP）时走 Blob 兜底，立即就绪
  }
  addRejectButton(item, msg); // 接收端可拒绝，避免发送端空等 5 分钟
}

function addSaveButton(item, msg) {
  let actions = item.querySelector('.item-actions');
  if (!actions) { actions = document.createElement('div'); actions.className = 'item-actions'; item.appendChild(actions); }
  if (actions.querySelector('.save')) return; // 避免重复添加（重连续传时）
  const btn = document.createElement('button');
  btn.className = 'save';
  btn.textContent = '保存为…';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const ctx = recvCtx;
    if (!ctx || ctx.id !== msg.id || ctx.done) { btn.disabled = false; return; } // 弹窗前连接已重置/被替换/已被拒绝或完成
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: msg.name });
      if (recvCtx !== ctx || ctx.done) return;          // 弹窗期间连接断开/被拒绝，ctx 已失效
      ctx.writer = await handle.createWritable();
      if (recvCtx !== ctx || ctx.done) { try { ctx.writer.abort(); } catch (e) {} return; } // 落盘流已失效/已被拒，丢弃
      setMeta(item, '接收中');
      sendRecvReady(msg.id); // 手势完成，通知发送端开始发送
      btn.textContent = '已就绪';
    } catch (err) {
      if (err && err.name === 'AbortError') { btn.disabled = false; return; } // 用户取消，保留按钮
      if (recvCtx === ctx && !ctx.done) { // 其他错误回退 Blob 兜底（仅当 ctx 仍有效且未被拒，避免空引用/误发 recv-ready）
        ctx.writer = null;
        setMeta(item, '接收中');
        sendRecvReady(msg.id);
      }
    }
  });
  actions.appendChild(btn);
}

function addRejectButton(item, msg) {
  let actions = item.querySelector('.item-actions');
  if (!actions) { actions = document.createElement('div'); actions.className = 'item-actions'; item.appendChild(actions); }
  if (actions.querySelector('.reject')) return;
  const btn = document.createElement('button');
  btn.className = 'reject';
  btn.textContent = '拒绝';
  btn.addEventListener('click', () => rejectReceive(msg.id));
  actions.appendChild(btn);
}

function rejectReceive(id) {
  sendRecvReject(id);
  if (recvCtx && recvCtx.id === id && !recvCtx.done) {
    if (recvCtx.writer) { try { recvCtx.writer.abort(); } catch (e) {} }
    recvCtx.done = true;
    setMeta(recvCtx.item, '已拒绝');
    // 同步禁用保存/拒绝按钮，让 UI 与状态一致，并阻止「拒绝后再点保存」造成 writer 泄漏与状态错乱
    const saveBtn = recvCtx.item.querySelector('.save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '已拒绝'; }
    const rejectBtn = recvCtx.item.querySelector('.reject');
    if (rejectBtn) { rejectBtn.disabled = true; rejectBtn.textContent = '已拒绝'; }
  }
}

function sendRecvReject(id) {
  if (sendChannel && sendChannel.readyState === 'open') {
    sendChannel.send(JSON.stringify({ type: 'recv-reject', id }));
  }
}

function sendRecvReady(id) {
  if (sendChannel && sendChannel.readyState === 'open') {
    sendChannel.send(JSON.stringify({ type: 'recv-ready', id }));
  }
}

function sendResumeRequest(id, offset) {
  if (sendChannel && sendChannel.readyState === 'open') {
    sendChannel.send(JSON.stringify({ type: 'resume-request', id, offset }));
  }
}

function maybeResume() {
  // 重连后由接收端的可写流/分片决定是否续传
  if (!recvCtx || recvCtx.done) return;
  if (recvCtx.writer) {
    if (recvCtx.received === 0) reAddSaveButton(recvCtx.item, recvCtx.meta); // 无数据可续，重新走保存（语义比重发空 file-meta 更直接）
    else sendResumeRequest(recvCtx.id, recvCtx.received); // 已有可写流，从断点续传
  } else if (fsSupported) {
    reAddSaveButton(recvCtx.item, recvCtx.meta); // FS 未保存：重新展示保存按钮（需手势）
  } else {
    sendResumeRequest(recvCtx.id, recvCtx.received); // Blob 兜底：直接续传，无需手势
  }
}

function reAddSaveButton(item, meta) {
  if (item.querySelector('.save')) return;
  setMeta(item, '等待你选择保存位置');
  addSaveButton(item, meta);
}

function finishReceive(item, url) {
  if (!item) return;
  item.classList.add('done');
  setMeta(item, '接收完成'); // 明确完成状态（原空串会被 setMeta 的短路判断吞掉，显示为进度残留）
  const a = document.createElement('a');
  a.className = 'dl';
  a.href = url;
  a.download = item.dataset.name || 'file';
  a.textContent = '下载';
  a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 60000), { once: true }); // 点击后 60s 释放，足够下载完成
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  actions.appendChild(a);
  item.appendChild(actions);
  // 小于 50MB 的文件自动触发一次下载，免去手动点击（大文件保留手动，避免误触占用带宽）
  const sz = Number(item.dataset.size || 0);
  if (sz && sz < 50 * 1024 * 1024) {
    try { a.click(); } catch (e) {}
  }
  // 未下载的 URL 超过上限时，释放最旧的并同步把对应下载按钮标记为已过期，
  // 避免用户点到已被 revoke 的链接而报 ERR_FILE_NOT_FOUND
  recvUrls.push({ url, a });
  while (recvUrls.length > MAX_RECV_URLS) {
    const { url: u, a: el } = recvUrls.shift();
    try { URL.revokeObjectURL(u); } catch (e) {}
    el.removeAttribute('href');
    el.textContent = '已过期';
    el.style.opacity = '.4';
    el.style.pointerEvents = 'none';
  }
}

/* ---------- 列表 UI ---------- */
function addItem(id, name, size, dir, isRecv) {
  const item = document.createElement('div');
  item.className = 'item';
  item.dataset.id = id;
  item.dataset.name = name;
  item.dataset.size = size;
  item.innerHTML = `
    <div class="item-head">
      <div class="item-name"><span class="dir">${dir}</span>${escapeHtml(name)}</div>
      <div class="item-meta">${formatSize(size)}</div>
    </div>
    <div class="bar"><i></i></div>
  `;
  lists.prepend(item);
  return item;
}

function setProgress(item, received, size) {
  if (!item) return;
  const pct = size ? Math.min(100, Math.round((received / size) * 100)) : 0;
  const bar = item.querySelector('.bar > i');
  if (bar) bar.style.width = pct + '%';
  if (!item.classList.contains('done')) {
    const meta = item.querySelector('.item-meta');
    if (meta) meta.textContent = `${formatSize(received)} / ${formatSize(size)}`;
  }
}

function setMeta(item, text) {
  const meta = item.querySelector('.item-meta');
  if (meta && text) meta.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 用 crypto 生成随机串，替代 Math.random 避免碰撞（文件 id 兼作续传 key，撞了会很麻烦）
function fileId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // UUIDv4 版本/变体位
  b[8] = (b[8] & 0x3f) | 0x80;
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function randRoom() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => (x % 36).toString(36)).join('').slice(0, 6); // 6 位 base36，可读且无碰撞
}

/* ---------- 事件绑定 ---------- */
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) { alert('请输入房间码'); return; }
  joinedRoom = room;
  if (!ws || ws.readyState >= 2) connect();      // CLOSED/CLOSING → 新建连接
  else if (ws.readyState === WebSocket.OPEN) doJoin();   // 已开 → 直接加入
  // CONNECTING：onopen 会按 joinedRoom 自动 doJoin
});

randomBtn.addEventListener('click', () => {
  roomInput.value = randRoom(); // 用 crypto 生成 6 位 base36，降低撞码
});

roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

fileInput.addEventListener('change', (e) => {
  for (const f of e.target.files) queueFile(f);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); })
);
dropzone.addEventListener('drop', (e) => {
  for (const f of e.dataTransfer.files) queueFile(f);
});

leaveBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bye' }));
  joinedRoom = '';
  sendCtxById.clear(); // 离开房间清空续传上下文
  resetConnection({ full: true }); // 强制清空在传文件（用户主动离开房间）
  setStatus('未连接', 'off');
});

// 初始
setStatus('未连接', 'off');
dropzone.style.opacity = '.5';
dropzone.style.pointerEvents = 'none';

// 二维码配对：从 URL 解析房间码（?room=xxxx），自动填入并加入
const params = new URLSearchParams(location.search);
const urlRoom = params.get('room');
if (urlRoom) {
  roomInput.value = urlRoom;
  joinedRoom = urlRoom;
  connect(); // 自动连接并按 joinedRoom 加入
}

// 二维码按钮：生成可分享的加入链接二维码，对方扫码即自动填入房间码
const qrBtn = $('qrBtn');
const qrBox = $('qrBox');
const qrImg = $('qrImg');
const qrUrl = $('qrUrl');
qrBtn.addEventListener('click', () => {
  let room = roomInput.value.trim();
  if (!room) { randomBtn.click(); room = roomInput.value.trim(); }
  const url = `${location.origin}/?room=${encodeURIComponent(room)}`;
  try {
    const qr = qrcode(0, 'M'); // typeNumber 0 = 自动，ECC 'M'
    qr.addData(url);
    qr.make();
    qrImg.innerHTML = qr.createImgTag(4, 8);
    qrUrl.textContent = url;
    qrBox.hidden = false;
  } catch (err) {
    alert('生成二维码失败：' + err.message);
  }
});
$('qrClose').addEventListener('click', () => { qrBox.hidden = true; });

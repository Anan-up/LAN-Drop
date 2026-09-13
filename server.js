const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();

// CSP：仅允许同源资源与必要的 ws/wss 连接，挡住内联注入（qrcode.js 用 data:image/gif，已在 img-src 白名单）
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'");
  next();
});

// 部署时通过环境变量 ICE_SERVERS 注入 TURN/STUN，例如：
// ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
// 前端拉取此配置用于 RTCPeerConnection，无需改动前端代码即可跨公网（需 TURN 中继）。
app.get('/config.json', (req, res) => {
  let iceServers;
  try {
    iceServers = JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
  } catch {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  res.json({ iceServers });
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
// 信令消息都是几百字节，8KB 上限足够，避免恶意/误发大包撑爆内存
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

// roomCode -> Set<ws>
const rooms = new Map();

// 每连接每秒最多消息数，超出直接丢弃，防止脚本刷爆 CPU（信令只做转发）
const MSG_RATE_LIMIT = 100;

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { /* 对端刚好关闭，静默忽略 */ }
  }
}

function leave(ws) {
  const room = ws.room;
  if (room && rooms.has(room)) {
    const peers = rooms.get(room);
    peers.delete(ws);
    // 通知房间内剩余成员对方离开
    for (const p of peers) send(p, { type: 'peer-left' });
    if (peers.size === 0) rooms.delete(room);
  }
  ws.room = null;
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws._winStart = Date.now();
  ws._msgCount = 0;

  ws.on('message', (raw) => {
    // 简单滑动窗口限流：每 1s 窗口内超过 MSG_RATE_LIMIT 条直接丢弃，防止脚本刷爆 CPU。
    // 注意：限流必须在 JSON.parse 之前，否则恶意脚本可持续发非法 JSON 让 parse 空转、绕过计数。
    const now = Date.now();
    if (now - ws._winStart >= 1000) { ws._winStart = now; ws._msgCount = 0; }
    if (++ws._msgCount > MSG_RATE_LIMIT) return;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      leave(ws); // 先退出旧房间
      const room = String(msg.room || '').trim();
      if (!room || room.length > 64) { send(ws, { type: 'bad-room' }); return; }

      if (!rooms.has(room)) rooms.set(room, new Set());
      const peers = rooms.get(room);

      if (peers.size >= 2) {
        send(ws, { type: 'full' });
        return;
      }

      ws.room = room;
      peers.add(ws);
      send(ws, { type: 'joined', peers: peers.size });

      // 两人到齐，通知双方开始协商，并分配 polite 角色（后加入者为 polite）
      if (peers.size === 2) {
        let i = 0;
        for (const p of peers) {
          send(p, { type: 'peer-ready', polite: i === 1 });
          i++;
        }
      }
    } else if (msg.type === 'signal') {
      // 把信令原样转发给同房间的另一个人（显式校验房间一致）
      const peers = ws.room ? rooms.get(ws.room) : null;
      if (!peers) return;
      for (const p of peers) {
        if (p !== ws && p.room === ws.room) send(p, { type: 'signal', data: msg.data });
      }
    } else if (msg.type === 'bye') {
      leave(ws);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`局域网文件传输服务已启动`);
  console.log(`本机访问:   http://localhost:${PORT}`);
  console.log(`局域网访问: http://<本机IP>:${PORT}`);
});

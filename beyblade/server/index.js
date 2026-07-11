"use strict";
/*
 * 旋風對決 連線對戰伺服器
 * 職責很輕：撮合兩位玩家、收集雙方的「陀螺選擇 + 發射轉速」，
 * 湊齊後發下同一顆亂數種子，戰鬥由兩邊客戶端跑同一套確定性模擬。
 */
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const httpServer = createServer(app);

const isDevelopment = process.env.NODE_ENV !== "production";
const allowedOrigins = ["https://joechiboo.github.io", process.env.CLIENT_URL].filter(Boolean);
const corsOptions = {
  origin: isDevelopment ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ : allowedOrigins,
  credentials: true,
};
app.use(cors(corsOptions));

const io = new Server(httpServer, { cors: corsOptions });

/* rooms: roomId -> {
 *   players: [socketId, socketId|null],
 *   picks:   [key|null, key|null],
 *   dirs:    [1|-1, 1|-1],           // 迴旋方向，影響戰鬥物理，必須同步
 *   powers:  [number|null, number|null],
 *   createdAt: number,
 * } */
const rooms = new Map();

function makeRoomId() {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000)); // 4 位數字，小朋友好輸入
  } while (rooms.has(id));
  return id;
}

function getRoomBySocket(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return null;
  const room = rooms.get(roomId);
  return room ? { roomId, room } : null;
}

io.on("connection", (socket) => {
  console.log(`connected: ${socket.id}`);

  socket.on("create_room", () => {
    const roomId = makeRoomId();
    rooms.set(roomId, {
      players: [socket.id, null],
      picks: [null, null],
      dirs: [1, 1],
      powers: [null, null],
      createdAt: Date.now(),
    });
    socket.data.roomId = roomId;
    socket.data.idx = 0;
    socket.join(roomId);
    socket.emit("room_created", { roomId, idx: 0 });
    console.log(`room ${roomId} created by ${socket.id}`);
  });

  socket.on("join_room", ({ roomId }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return socket.emit("err_msg", { message: "找不到這個房間，確認代碼再試一次！" });
    if (room.players[1]) return socket.emit("err_msg", { message: "這個房間已經滿了！" });
    room.players[1] = socket.id;
    socket.data.roomId = roomId;
    socket.data.idx = 1;
    socket.join(roomId);
    io.to(roomId).emit("room_ready", { roomId });
    console.log(`room ${roomId} ready`);
  });

  socket.on("pick", ({ top, dir }) => {
    const ctx = getRoomBySocket(socket);
    if (!ctx) return;
    const { roomId, room } = ctx;
    room.picks[socket.data.idx] = top;
    room.dirs[socket.data.idx] = dir === -1 ? -1 : 1;
    socket.to(roomId).emit("opponent_picked");
    if (room.picks[0] && room.picks[1]) {
      io.to(roomId).emit("reveal", { picks: room.picks, dirs: room.dirs });
    }
  });

  socket.on("launch", ({ power }) => {
    const ctx = getRoomBySocket(socket);
    if (!ctx) return;
    const { roomId, room } = ctx;
    room.powers[socket.data.idx] = Math.max(0, Math.min(1, Number(power) || 0));
    socket.to(roomId).emit("opponent_launched");
    if (room.powers[0] !== null && room.powers[1] !== null) {
      const seed = Math.floor(Math.random() * 0x7fffffff);
      io.to(roomId).emit("battle_start", { picks: room.picks, dirs: room.dirs, powers: room.powers, seed });
      console.log(`room ${roomId} battle: ${room.picks.join(" vs ")} seed=${seed}`);
    }
  });

  // 任一方按「再戰／重選」，整房一起進入下一輪
  socket.on("again", ({ repick }) => {
    const ctx = getRoomBySocket(socket);
    if (!ctx) return;
    const { roomId, room } = ctx;
    room.powers = [null, null];
    if (repick) { room.picks = [null, null]; room.dirs = [1, 1]; }
    io.to(roomId).emit("again", { repick: !!repick });
  });

  socket.on("disconnect", () => {
    console.log(`disconnected: ${socket.id}`);
    const ctx = getRoomBySocket(socket);
    if (!ctx) return;
    const { roomId } = ctx;
    socket.to(roomId).emit("opponent_left");
    rooms.delete(roomId);
    console.log(`room ${roomId} closed`);
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Beyblade Battle Server", status: "running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", rooms: rooms.size, uptime: process.uptime() });
});

// 清掉放超過 30 分鐘的殭屍房
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 30 * 60 * 1000) rooms.delete(id);
  }
}, 60000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`⚡ Beyblade server running on port ${PORT}`);
});

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const cors = require("cors");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");

BigInt.prototype.toJSON = function () { return this.toString(); };

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: true,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/api/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails?.[0]?.value;
        const displayName = profile.displayName;
        if (!googleId || !email || !displayName) {
          return done(new Error("Missing required Google profile fields"));
        }
        const user = await prisma.user.upsert({
          where: { googleId },
          update: { email, nickname: displayName },
          create: { googleId, email, nickname: displayName, totalWins: 0, totalGames: 0 },
        });
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    },
  ),
);

async function ensurePlayerForUser(userId) {
  const existingPlayer = await prisma.player.findFirst({ where: { userId, roomId: 1 } });
  if (existingPlayer) return existingPlayer;
  return prisma.player.create({
    data: {
      roomId: 1,
      userId,
      cash: 2000000n,
      totalAsset: 2000000n,
      location: 0,
      assets: { create: { samsung: 0, tesla: 0, lockheed: 0, gold: 0, bitcoin: 0 } },
    },
    include: { assets: true },
  });
}

async function rollDiceForUser({ userId }) {
  return prisma.$transaction(async (tx) => {
    const player = await tx.player.findFirst({ where: { userId } });
    if (!player) throw new Error("Player not found");
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const isDouble = dice1 === dice2;
    const oldLocation = player.location;
    const newLocation = (oldLocation + dice1 + dice2) % 32;
    const passedStart = newLocation < oldLocation;
    const salary = passedStart ? 200000n : 0n;
    const hasExtraTurn = isDouble && !player.extraTurnUsed;
    const updatedPlayer = await tx.player.update({
      where: { id: player.id },
      data: { location: newLocation, cash: player.cash + salary, extraTurnUsed: hasExtraTurn ? true : false },
    });
    if (!hasExtraTurn) {
      const room = await tx.room.findUnique({ where: { id: player.roomId } });
      if (!room) throw new Error("Room not found");
      const playerCount = await tx.player.count({ where: { roomId: player.roomId } });
      if (playerCount === 0) throw new Error("Player count is zero");
      await tx.room.update({ where: { id: player.roomId }, data: { turnPlayerIdx: (room.turnPlayerIdx + 1) % playerCount } });
    }
    return { dice1, dice2, isDouble, hasExtraTurn, oldLocation, newLocation, passedStart, player: updatedPlayer, roomId: player.roomId };
  });
}

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/api/auth/google/callback", passport.authenticate("google", { failureRedirect: "/" }), (req, res) => { res.redirect("/"); });
app.get("/api/auth/logout", (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    const cookieName = "connect.sid";
    if (req.session) {
      req.session.destroy(() => { res.clearCookie(cookieName); res.redirect("/"); });
      return;
    }
    res.clearCookie(cookieName);
    res.redirect("/");
  });
});

app.get("/", async (req, res) => {
  try { if (req.isAuthenticated && req.isAuthenticated()) await ensurePlayerForUser(req.user.id); } catch (e) {}
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/me", async (req, res) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { players: true } });
    return res.json(user);
  } catch (e) {
    return res.status(500).json({ error: "Failed to load user" });
  }
});

app.get("/api/map", async (req, res) => {
  try {
    const mapData = await prisma.mapNode.findMany({ include: { gameLands: { where: { roomId: 1 } } }, orderBy: { nodeIdx: "asc" } });
    res.json(mapData);
  } catch (e) {
    res.status(500).json({ error: "Map load failed" });
  }
});

app.get("/api/test/roll", async (req, res) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: "Unauthorized" });
    const result = await rollDiceForUser({ userId: req.user.id });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: "Failed to roll dice" });
  }
});

app.get("/api/bigint-test", (req, res) => { res.json({ cash: 2000000n, totalAsset: 2000000n }); });

app.post("/api/game/purchase", async (req, res) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: "Unauthorized" });
    const player = await prisma.player.findFirst({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: "Player not found" });
    const mapNode = await prisma.mapNode.findUnique({ where: { nodeIdx: player.location } });
    if (!mapNode || mapNode.type !== "LAND") return res.status(400).json({ error: "Not a land tile" });
    const existingLand = await prisma.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: player.location } });
    if (existingLand?.ownerId) return res.status(400).json({ error: "Land already owned" });
    if (player.cash < mapNode.basePrice) return res.status(400).json({ error: "Insufficient cash" });
    const result = await prisma.$transaction(async (tx) => {
      const freshPlayer = await tx.player.findUnique({ where: { id: player.id } });
      if (!freshPlayer) throw new Error("Player not found");
      const freshLand = await tx.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: player.location } });
      if (freshLand?.ownerId) throw new Error("Land already owned");
      const updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: freshPlayer.cash - mapNode.basePrice } });
      const land = await tx.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: player.location } });
      if (land) {
        await tx.gameLand.update({ where: { id: land.id }, data: { ownerId: player.id } });
      } else {
        await tx.gameLand.create({ data: { roomId: player.roomId, nodeIdx: player.location, ownerId: player.id, purchasePrice: mapNode.basePrice } });
      }
      return { cash: updatedPlayer.cash, nodeIdx: player.location };
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: "Failed to purchase land" });
  }
});

app.post("/api/test/purchase-cheat", async (req, res) => {
  try {
    const player = await prisma.player.findFirst({ where: { userId: 1 } });
    if (!player) return res.status(404).json({ error: "Player not found" });
    const mapNode = await prisma.mapNode.findUnique({ where: { nodeIdx: player.location } });
    if (!mapNode || mapNode.type !== "LAND") return res.status(400).json({ error: "Not a land tile" });
    const existingLand = await prisma.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: player.location } });
    if (existingLand?.ownerId) return res.status(400).json({ error: "Land already owned" });
    if (player.cash < mapNode.basePrice) return res.status(400).json({ error: "Insufficient cash" });
    const result = await prisma.$transaction(async (tx) => {
      const freshPlayer = await tx.player.findUnique({ where: { id: player.id } });
      if (!freshPlayer) throw new Error("Player not found");
      const freshLand = await tx.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: player.location } });
      if (freshLand?.ownerId) throw new Error("Land already owned");
      const updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: freshPlayer.cash - mapNode.basePrice } });
      const land = await tx.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: player.location } });
      if (land) {
        await tx.gameLand.update({ where: { id: land.id }, data: { ownerId: player.id } });
      } else {
        await tx.gameLand.create({ data: { roomId: player.roomId, nodeIdx: player.location, ownerId: player.id, purchasePrice: mapNode.basePrice } });
      }
      return { cash: updatedPlayer.cash, nodeIdx: player.location };
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: "Failed to purchase land" });
  }
});

const io = new Server(server, { cors: { origin: "*" } });
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, () => {
    passport.initialize()(socket.request, {}, () => {
      passport.session()(socket.request, {}, next);
    });
  });
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  socket.on("join_room", async (roomId) => {
    try {
      const sessionUserId = socket.request.session?.userId || socket.request.session?.passport?.user?.id || socket.request.user?.id;
      if (!sessionUserId) {
        socket.emit("join_error", { message: "User session not found" });
        return;
      }
      const player = await prisma.player.create({
        data: { roomId, userId: sessionUserId, socketId: socket.id, cash: 2000000n, totalAsset: 2000000n, assets: { create: { samsung: 0, tesla: 0, lockheed: 0, gold: 0, bitcoin: 0 } } },
        include: { assets: true },
      });
      socket.join(roomId);
      socket.emit("join_success", { roomId, message: "Join success", player });
    } catch (e) {
      socket.emit("join_error", { message: "Failed to join room" });
    }
  });
  socket.on("roll_dice", async () => {
    console.log("주사위 요청 수신", socket.id);
    try {
      const userId = socket.request.user?.id || socket.request.session?.passport?.user?.id || socket.request.session?.userId;
      if (!userId) {
        socket.emit("roll_error", { message: "로그인 세션 만료" });
        console.log("전송 실패: 로그인 세션 만료");
        return;
      }
      const result = await rollDiceForUser({ userId });
      console.log(`계산된 위치: ${result.oldLocation} -> ${result.newLocation}`);
      socket.emit("dice_rolled", {
        userId,
        dice1: result.dice1,
        dice2: result.dice2,
        isDouble: result.isDouble,
        hasExtraTurn: result.hasExtraTurn,
        passedStart: result.passedStart,
        player: result.player,
      });
      console.log("전송 성공 여부: true");
    } catch (e) {
      socket.emit("roll_error", { message: e?.message || "Failed to roll dice" });
      console.log("전송 실패", e?.message || e);
    }
  });
});

async function initGame() {
  try {
    const room = await prisma.room.findUnique({ where: { id: 1 } });
    if (!room) await prisma.room.create({ data: { id: 1, roomCode: "DEMO", status: "WAITING" } });
  } catch (e) {
    console.error(e);
  }
}

server.listen(3000, async () => {
  await initGame();
  console.log("Server running at http://localhost:3000");
});

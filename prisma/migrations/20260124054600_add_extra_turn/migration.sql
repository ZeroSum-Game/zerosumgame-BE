-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('WAITING', 'PLAYING', 'ENDED');

-- CreateEnum
CREATE TYPE "Character" AS ENUM ('MUSK', 'LEE', 'TRUMP', 'PUTIN');

-- CreateEnum
CREATE TYPE "TileType" AS ENUM ('START', 'LAND', 'STOCK', 'MINI', 'EXPO', 'ISLAND', 'JAIL', 'TAX', 'KEY');

-- CreateEnum
CREATE TYPE "Continent" AS ENUM ('ASIA', 'EUROPE', 'AFRICA', 'AMERICA', 'SPECIAL');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "totalGames" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" SERIAL NOT NULL,
    "roomCode" TEXT NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'WAITING',
    "currentTurn" INTEGER NOT NULL DEFAULT 1,
    "maxTurn" INTEGER NOT NULL DEFAULT 10,
    "turnPlayerIdx" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "roomId" INTEGER NOT NULL,
    "socketId" TEXT,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "isHost" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "character" "Character",
    "cash" BIGINT NOT NULL DEFAULT 2000000,
    "totalAsset" BIGINT NOT NULL DEFAULT 2000000,
    "location" INTEGER NOT NULL DEFAULT 0,
    "isBankrupt" BOOLEAN NOT NULL DEFAULT false,
    "isResting" BOOLEAN NOT NULL DEFAULT false,
    "extraTurnUsed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerAsset" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "samsung" INTEGER NOT NULL DEFAULT 0,
    "tesla" INTEGER NOT NULL DEFAULT 0,
    "lockheed" INTEGER NOT NULL DEFAULT 0,
    "gold" INTEGER NOT NULL DEFAULT 0,
    "bitcoin" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlayerAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapNode" (
    "nodeIdx" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TileType" NOT NULL,
    "continent" "Continent" NOT NULL DEFAULT 'SPECIAL',
    "basePrice" BIGINT NOT NULL DEFAULT 0,
    "baseToll" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "MapNode_pkey" PRIMARY KEY ("nodeIdx")
);

-- CreateTable
CREATE TABLE "GameLand" (
    "id" SERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "nodeIdx" INTEGER NOT NULL,
    "ownerId" INTEGER,
    "isLandmark" BOOLEAN NOT NULL DEFAULT false,
    "hasWorldCup" BOOLEAN NOT NULL DEFAULT false,
    "purchasePrice" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "GameLand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" SERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "priceSamsung" BIGINT NOT NULL DEFAULT 50000,
    "priceTesla" BIGINT NOT NULL DEFAULT 300000,
    "priceLockheed" BIGINT NOT NULL DEFAULT 100000,
    "priceGold" BIGINT NOT NULL DEFAULT 100000,
    "priceBtc" BIGINT NOT NULL DEFAULT 50000000,
    "prevSamsung" BIGINT NOT NULL DEFAULT 50000,
    "prevTesla" BIGINT NOT NULL DEFAULT 300000,
    "prevLockheed" BIGINT NOT NULL DEFAULT 100000,
    "prevGold" BIGINT NOT NULL DEFAULT 100000,
    "prevBtc" BIGINT NOT NULL DEFAULT 50000000,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameLog" (
    "id" SERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "turn" INTEGER,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Room_roomCode_key" ON "Room"("roomCode");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerAsset_playerId_key" ON "PlayerAsset"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_roomId_key" ON "Market"("roomId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerAsset" ADD CONSTRAINT "PlayerAsset_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameLand" ADD CONSTRAINT "GameLand_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameLand" ADD CONSTRAINT "GameLand_nodeIdx_fkey" FOREIGN KEY ("nodeIdx") REFERENCES "MapNode"("nodeIdx") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameLand" ADD CONSTRAINT "GameLand_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameLog" ADD CONSTRAINT "GameLog_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

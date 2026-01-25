const express=require("express");

const INITIAL_CASH=3000000n;
const MUSK_BONUS=1000000n;
const LEE_START_SAMSUNG_SHARES=10;
const TRUMP_TOLL_BONUS_RATE=0.05;
const PUTIN_WAR_BONUS=10;
const WAR_BASE_RATE=30;
const WAR_RATIO_RATE=40;
const WAR_BASE_MIN=30;
const WAR_BASE_MAX=70;
const WAR_FINAL_MIN=25;
const WAR_FINAL_MAX=80;
const WORLD_CUP_COST=800000n;
const LANDMARK_RATE_NUM=2n;
const LANDMARK_RATE_DEN=5n;
const TAKEOVER_RATE_NUM=3n;
const TAKEOVER_RATE_DEN=2n;
const SELL_RATE_NUM=7n;
const SELL_RATE_DEN=10n;

const LAND_PRICE_BY_NODE={1:535500n,3:665000n,5:756000n,6:735000n,7:700000n,10:770000n,11:630000n,13:567000n,15:598500n,17:661500n,19:1001000n,21:770000n,22:924000n,23:885000n,26:630000n,27:567000n,29:735000n,31:1078000n};
const LAND_STABILITY_BY_NODE={1:0.9,3:1.0,5:0.9,6:1.0,7:1.0,10:1.0,11:0.9,13:0.9,15:0.9,17:0.9,19:1.1,21:1.0,22:1.1,23:1.1,26:0.9,27:0.9,29:1.0,31:1.1};
const LAND_TOLL_BY_NODE={1:85000n,3:95000n,5:120000n,6:105000n,7:100000n,10:110000n,11:100000n,13:90000n,15:95000n,17:105000n,19:130000n,21:110000n,22:120000n,23:115000n,26:100000n,27:90000n,29:105000n,31:140000n};

const STOCK_WAR_WEIGHT={stock:0.8,gold:1.0,bitcoin:0.6};
const CHARACTER_LABEL={MUSK:"MUSK",LEE:"LEE",TRUMP:"TRUMP",PUTIN:"PUTIN"};
const WAR_LINE_RANGES=[{name:"ASIA",start:0,end:7},{name:"EUROPE",start:8,end:15},{name:"AFRICA",start:16,end:23},{name:"AMERICA",start:24,end:31}];
const NEUTRAL_NODES=new Set([0,3,12,16,20,24,28,30]);

function createGameLogic({prisma,io,market}){
  const warState={active:false,warLine:null,warNode:null,turnsLeft:0,recoveryActive:false,recoveryLine:1,recoveryNode:1};
  const roomTurnOrder=new Map();
  const currentTurnUserByRoom=new Map();
  const turnStateByRoom=new Map();
  const actionWindowByRoom=new Map();
  const landVisitCount=new Map();
  const landLastAction=new Map();
  const lastCardByRoom=new Map();

  function getLandKey(playerId,nodeIdx){return `${playerId}:${nodeIdx}`;}
  function getVisitCount(playerId,nodeIdx){return landVisitCount.get(getLandKey(playerId,nodeIdx))||0;}
  function setVisitCount(playerId,nodeIdx,count){landVisitCount.set(getLandKey(playerId,nodeIdx),count);}
  function incrementVisit(playerId,nodeIdx){setVisitCount(playerId,nodeIdx,getVisitCount(playerId,nodeIdx)+1);}
  function getLastAction(playerId,nodeIdx){return landLastAction.get(getLandKey(playerId,nodeIdx))||null;}
  function setLastAction(playerId,nodeIdx,action){landLastAction.set(getLandKey(playerId,nodeIdx),action);}

  function getLineIndex(nodeIdx){return WAR_LINE_RANGES.findIndex((range)=>nodeIdx>=range.start&&nodeIdx<=range.end);}
  function getAdjacentLines(lineIdx){const adjacent=[];if(lineIdx>0)adjacent.push(lineIdx-1);if(lineIdx<WAR_LINE_RANGES.length-1)adjacent.push(lineIdx+1);return adjacent;}
  function getWarLandMultiplier(nodeIdx,isOwned){
    if(NEUTRAL_NODES.has(nodeIdx)||!isOwned)return 1;
    const lineIdx=getLineIndex(nodeIdx);
    if(warState.active){
      if(nodeIdx===warState.warNode)return 0.5;
      if(lineIdx===warState.warLine)return 0.75;
      return 1.1;
    }
    if(warState.recoveryActive&&lineIdx===warState.warLine){
      return nodeIdx===warState.warNode?warState.recoveryNode:warState.recoveryLine;
    }
    return 1;
  }
  function applyWarMultiplier(value,nodeIdx,isOwned){
    const mult=getWarLandMultiplier(nodeIdx,isOwned);
    return BigInt(Math.round(Number(value)*mult));
  }
  function getWarPayload(){
    return{
      active:warState.active,
      warLine:warState.warLine,
      warNode:warState.warNode,
      turnsLeft:warState.turnsLeft,
      recoveryActive:warState.recoveryActive,
      recoveryLine:warState.recoveryLine,
      recoveryNode:warState.recoveryNode,
      adjacentLines:warState.warLine!=null?getAdjacentLines(warState.warLine):[]
    };
  }

  async function getLatestPlayersByUser(tx,roomId){
    const players=await tx.player.findMany({where:{roomId},orderBy:{id:"desc"}});
    const byUser=new Map();
    for(const p of players){
      if(!byUser.has(p.userId))byUser.set(p.userId,p);
    }
    return Array.from(byUser.values());
  }

  async function getTurnPlayerId(tx,roomId){
    const room=await tx.room.findUnique({where:{id:roomId}});
    if(!room)return null;
    const players=await getLatestPlayersByUser(tx,roomId);
    if(players.length===0)return null;
    const turnOrder=roomTurnOrder.get(roomId);
    if(turnOrder&&turnOrder.length){
      const playerSet=new Set(players.map((p)=>p.id));
      const filtered=turnOrder.filter((id)=>playerSet.has(id));
      if(filtered.length){
        roomTurnOrder.set(roomId,filtered);
        return filtered[room.turnPlayerIdx%filtered.length];
      }
      roomTurnOrder.delete(roomId);
    }
    const sorted=players.slice().sort((a,b)=>a.id-b.id);
    return sorted[room.turnPlayerIdx%sorted.length].id;
  }

  function getLandBasePrice(nodeIdx){return LAND_PRICE_BY_NODE[nodeIdx]||0n;}
  function getLandBaseToll(nodeIdx,baseToll){return LAND_TOLL_BY_NODE[nodeIdx]||baseToll||0n;}
  function calcLandPriceFromToll(baseToll,nodeIdx){
    const stability=LAND_STABILITY_BY_NODE[nodeIdx];
    const toll=getLandBaseToll(nodeIdx,baseToll);
    if(!stability||!toll)return getLandBasePrice(nodeIdx);
    return BigInt(Math.round(Number(toll)*7*stability));
  }
  function getEffectiveLandPrice(baseToll,nodeIdx,isOwned){
    const basePrice=calcLandPriceFromToll(baseToll,nodeIdx);
    return applyWarMultiplier(basePrice,nodeIdx,isOwned);
  }
  function clamp(value,min,max){return Math.max(min,Math.min(max,value));}

  async function computeTotals(tx,playerId){
    const player=await tx.player.findUnique({where:{id:playerId},include:{assets:true,lands:true}});
    if(!player)throw new Error("Player not found");
    const marketData=await market.getOrCreateMarket(tx,player.roomId);
    const landTotal=player.lands.reduce((sum,land)=>sum+land.purchasePrice,0n);
    const assets=player.assets||{samsung:0,tesla:0,lockheed:0,gold:0,bitcoin:0};
    const stockTotal=BigInt(assets.samsung)*marketData.priceSamsung+BigInt(assets.tesla)*marketData.priceTesla+BigInt(assets.lockheed)*marketData.priceLockheed+BigInt(assets.gold)*marketData.priceGold+BigInt(assets.bitcoin)*marketData.priceBtc;
    const totalAsset=player.cash+landTotal+stockTotal;
    return{player,assets,market:marketData,landTotal,stockTotal,totalAsset};
  }

  async function emitAssetUpdate(playerId){
    if(!io)return;
    try{
      const payload=await prisma.$transaction(async(tx)=>{
        const totals=await computeTotals(tx,playerId);
        await tx.player.update({where:{id:playerId},data:{totalAsset:totals.totalAsset}});
        return{roomId:totals.player.roomId,userId:totals.player.userId,cash:totals.player.cash,totalAsset:totals.totalAsset};
      });
      io.to(payload.roomId).emit("asset_update",payload);
    }catch(e){}
  }

  function calcWarAssetValue(assets,marketData,cash){
    const stockValue=BigInt(assets.samsung)*marketData.priceSamsung+BigInt(assets.tesla)*marketData.priceTesla+BigInt(assets.lockheed)*marketData.priceLockheed;
    const goldValue=BigInt(assets.gold)*marketData.priceGold;
    const coinValue=BigInt(assets.bitcoin)*marketData.priceBtc;
    const weightedStock=Number(stockValue)*STOCK_WAR_WEIGHT.stock;
    const weightedGold=Number(goldValue)*STOCK_WAR_WEIGHT.gold;
    const weightedCoin=Number(coinValue)*STOCK_WAR_WEIGHT.bitcoin;
    return Number(cash)+weightedStock+weightedGold+weightedCoin;
  }
  function calcWarWinRate({myAsset,oppAsset,character}){
    const ratio=myAsset+oppAsset===0?0.5:myAsset/(myAsset+oppAsset);
    const baseRaw=WAR_BASE_RATE+(ratio*WAR_RATIO_RATE);
    const base=clamp(baseRaw,WAR_BASE_MIN,WAR_BASE_MAX);
    const characterBonus=character===CHARACTER_LABEL.PUTIN?PUTIN_WAR_BONUS:0;
    return clamp(base+characterBonus,WAR_FINAL_MIN,WAR_FINAL_MAX);
  }
  function applyTrumpBonus(toll,ownerCharacter){
    if(ownerCharacter!==CHARACTER_LABEL.TRUMP)return toll;
    return BigInt(Math.round(Number(toll)*(1+TRUMP_TOLL_BONUS_RATE)));
  }

  async function autoSellAssets(tx,player,amount,marketData){
    if(player.cash>=amount)return{player,autoSales:[],covered:true};
    const assets=player.assets||await tx.playerAsset.create({data:{playerId:player.id}});
    const sellOrder=[
      {key:"bitcoin",price:marketData.priceBtc},
      {key:"gold",price:marketData.priceGold},
      {key:"samsung",price:marketData.priceSamsung},
      {key:"tesla",price:marketData.priceTesla},
      {key:"lockheed",price:marketData.priceLockheed}
    ];
    let updatedPlayer=player;
    let updatedAssets=assets;
    const autoSales=[];
    for(const item of sellOrder){
      if(updatedPlayer.cash>=amount)break;
      const owned=updatedAssets[item.key]||0;
      if(owned<=0)continue;
      const remaining=amount-updatedPlayer.cash;
      const price=item.price;
      const needed=(remaining+price-1n)/price;
      const sellQty=Math.min(owned,Number(needed));
      if(sellQty<=0)continue;
      const proceeds=price*BigInt(sellQty);
      updatedAssets=await tx.playerAsset.update({where:{playerId:player.id},data:{[item.key]:owned-sellQty}});
      updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:updatedPlayer.cash+proceeds}});
      autoSales.push({symbol:item.key,quantity:sellQty,price,proceeds});
    }
    const covered=updatedPlayer.cash>=amount;
    if(!covered){
      updatedPlayer=await tx.player.update({where:{id:player.id},data:{isBankrupt:true}});
    }
    return{player:updatedPlayer,autoSales,covered};
  }

  async function rollDiceForUser({userId}){
    return prisma.$transaction(async(tx)=>{
      const player=await tx.player.findFirst({where:{userId},orderBy:{id:"desc"}});
      if(!player)throw new Error("Player not found");
      const room=await tx.room.findUnique({where:{id:player.roomId}});
      if(!room||room.status!=="PLAYING")throw new Error("Game not started");
      const currentTurnId=await getTurnPlayerId(tx,player.roomId);
      if(currentTurnId!==player.id)throw new Error("Not your turn");
      const turnState=turnStateByRoom.get(player.roomId)||{userId:player.userId,rolled:false,extraRoll:false};
      if(turnState.userId!==player.userId){
        turnState.userId=player.userId;
        turnState.rolled=false;
        turnState.extraRoll=false;
      }
      if(turnState.rolled&&!turnState.extraRoll)throw new Error("Already rolled");
      const dice1=Math.floor(Math.random()*6)+1;
      const dice2=Math.floor(Math.random()*6)+1;
      const isDouble=dice1===dice2;
      const oldLocation=player.location;
      const newLocation=(oldLocation+dice1+dice2)%32;
      const passedStart=newLocation<oldLocation;
      const salary=passedStart?200000n:0n;
      const hasExtraTurn=isDouble&&!player.extraTurnUsed;
      const currentMarket=await market.getOrCreateMarket(tx,player.roomId);
      const driftUpdates={};
      Object.values(market.MARKET_SYMBOLS).forEach((cfg)=>{
        const drift=(Math.random()*0.1)-0.05;
        driftUpdates[cfg.prevField]=currentMarket[cfg.priceField];
        driftUpdates[cfg.priceField]=market.applyMarketDelta(currentMarket[cfg.priceField],drift);
      });
      let marketData=await tx.market.update({where:{roomId:player.roomId},data:driftUpdates});
      let updatedPlayer=await tx.player.update({where:{id:player.id},data:{location:newLocation,cash:player.cash+salary,extraTurnUsed:hasExtraTurn?true:false}});
      turnState.rolled=true;
      turnState.extraRoll=hasExtraTurn;
      turnStateByRoom.set(player.roomId,turnState);
      actionWindowByRoom.set(player.roomId,{userId:player.userId,location:newLocation});
      let cardEvent=null;
      let tollOwnerId=null;
      let warStarted=false;
      let warEnded=false;
      const keyTiles=[12,20,28];
      if(keyTiles.includes(newLocation)){
        const cards=[
          {title:"\uC0DD\uC77C \uCD95\uD558\uAE08",description:"+100,000\uC6D0 \uC9C0\uAE09",amount:100000n},
          {title:"\uC138\uAE08 \uB0A9\uBD80",description:"-50,000\uC6D0 \uB0A9\uBD80",amount:-50000n},
          {title:"\uBCF5\uAD8C \uB2F9\uCCA8",description:"+200,000\uC6D0 \uB2F9\uCCA8",amount:200000n},
          {title:"\uAD50\uD1B5 \uBC94\uCE59\uAE08",description:"-30,000\uC6D0 \uB0A9\uBD80",amount:-30000n},
          {title:"\uBC30\uB2F9\uAE08 \uC218\uB839",description:"+150,000\uC6D0 \uC218\uB839",amount:150000n}
        ];
        const lastIdx=lastCardByRoom.get(player.roomId);
        let idx=Math.floor(Math.random()*cards.length);
        if(cards.length>1&&idx===lastIdx)idx=(idx+1)%cards.length;
        lastCardByRoom.set(player.roomId,idx);
        const picked=cards[idx];
        const nextCash=updatedPlayer.cash+picked.amount;
        updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:nextCash}});
        cardEvent={title:picked.title,description:picked.description,amount:picked.amount,location:newLocation,playerId:player.id,userId:player.userId,cash:updatedPlayer.cash};
        const symbols=Object.keys(market.MARKET_SYMBOLS);
        const target=symbols[Math.floor(Math.random()*symbols.length)];
        const cfg=market.MARKET_SYMBOLS[target];
        const eventDelta=picked.amount>=0n?0.02:-0.02;
        const nextPrice=market.applyMarketDelta(marketData[cfg.priceField],eventDelta);
        marketData=await tx.market.update({where:{roomId:player.roomId},data:{[cfg.prevField]:marketData[cfg.priceField],[cfg.priceField]:nextPrice}});
      }
      if(newLocation===8&&!warState.active){
        const playerCount=await tx.player.count({where:{roomId:player.roomId}});
        warState.active=true;
        warState.warLine=getLineIndex(newLocation);
        warState.warNode=newLocation;
        warState.turnsLeft=playerCount;
        warState.recoveryActive=false;
        warState.recoveryLine=0.75;
        warState.recoveryNode=0.5;
        warStarted=true;
      }
      const autoSellEvents=[];
      if(newLocation===30){
        const totals=await computeTotals(tx,updatedPlayer.id);
        const tax=totals.totalAsset/10n;
        const sold=await autoSellAssets(tx,updatedPlayer,tax,marketData);
        updatedPlayer=sold.player;
        const payAmount=updatedPlayer.cash<tax?updatedPlayer.cash:tax;
        updatedPlayer=await tx.player.update({where:{id:updatedPlayer.id},data:{cash:updatedPlayer.cash-payAmount}});
        if(sold.autoSales.length)autoSellEvents.push({type:"TAX",items:sold.autoSales,amount:tax,paid:payAmount,bankrupt:!sold.covered});
      }
      const mapNode=await tx.mapNode.findUnique({where:{nodeIdx:newLocation}});
      if(mapNode?.type==="LAND"){
        const land=await tx.gameLand.findFirst({where:{roomId:updatedPlayer.roomId,nodeIdx:newLocation}});
        if(land&&land.ownerId===updatedPlayer.id){
          incrementVisit(updatedPlayer.id,newLocation);
        }else if(land&&land.ownerId&&land.ownerId!==updatedPlayer.id){
          const owner=await tx.player.findUnique({where:{id:land.ownerId}});
          if(owner){
            let toll=getLandBaseToll(newLocation,mapNode.baseToll);
            toll=applyTrumpBonus(toll,owner.character);
            toll=applyWarMultiplier(toll,newLocation,true);
            const sold=await autoSellAssets(tx,updatedPlayer,toll,marketData);
            updatedPlayer=sold.player;
            const payAmount=updatedPlayer.cash<toll?updatedPlayer.cash:toll;
            updatedPlayer=await tx.player.update({where:{id:updatedPlayer.id},data:{cash:updatedPlayer.cash-payAmount}});
            await tx.player.update({where:{id:owner.id},data:{cash:owner.cash+payAmount}});
            tollOwnerId=owner.id;
            if(sold.autoSales.length)autoSellEvents.push({type:"TOLL",items:sold.autoSales,amount:toll,paid:payAmount,bankrupt:!sold.covered,ownerId:owner.id});
          }
        }
      }
      const turnPlayerId=await getTurnPlayerId(tx,updatedPlayer.roomId);
      const turnUserId=currentTurnUserByRoom.get(updatedPlayer.roomId)||player.userId;
      return{dice1,dice2,isDouble,hasExtraTurn,oldLocation,newLocation,passedStart,player:updatedPlayer,roomId:updatedPlayer.roomId,cardEvent,tollOwnerId,turnPlayerId,turnUserId,market:marketData,war:getWarPayload(),warStarted,warEnded,autoSellEvents};
    });
  }

  function createGameRoutes({requireAuth}){
    const router=express.Router();

    router.get("/api/me",requireAuth,async(req,res)=>{
      try{
        const result=await prisma.$transaction(async(tx)=>{
          const player=await tx.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"}});
          if(!player)return{cash:0,location:0};
          const totals=await computeTotals(tx,player.id);
          return{cash:totals.player.cash,location:totals.player.location,totalAsset:totals.totalAsset,character:totals.player.character,userId:totals.player.userId,playerId:totals.player.id};
        });
        return res.json(result);
      }catch(e){
        return res.status(500).json({error:"Failed to load user"});
      }
    });

    router.get("/api/map",async(req,res)=>{
      try{
        const mapData=await prisma.mapNode.findMany({include:{gameLands:{where:{roomId:1}}},orderBy:{nodeIdx:"asc"}});
        const normalized=mapData.map((node)=>{
          if(node.type!=="LAND")return node;
          const basePrice=getLandBasePrice(node.nodeIdx);
          return{...node,basePrice};
        });
        res.json(normalized);
      }catch(e){
        res.status(500).json({error:"Map load failed"});
      }
    });

    router.get("/api/players/:id/assets",async(req,res)=>{
      try{
        const userId=Number(req.params.id);
        if(!Number.isInteger(userId))return res.status(400).json({error:"Invalid user id"});
        const result=await prisma.$transaction(async(tx)=>{
          const player=await tx.player.findFirst({where:{userId},orderBy:{id:"desc"}});
          if(!player)throw new Error("Player not found");
          const totals=await computeTotals(tx,player.id);
          return{cash:totals.player.cash,lands:totals.player.lands,assets:totals.assets,stockTotal:totals.stockTotal,landTotal:totals.landTotal,totalAsset:totals.totalAsset};
        });
        return res.json(result);
      }catch(e){
        const message=e?.message==="Player not found"?e.message:"Failed to load assets";
        return res.status(404).json({error:message});
      }
    });

    router.get("/api/users/profile",requireAuth,async(req,res)=>{
      try{
        const user=await prisma.user.findUnique({where:{id:req.user.id},select:{nickname:true,totalWins:true,totalGames:true}});
        if(!user)return res.status(404).json({error:"User not found"});
        const winRate=user.totalGames===0?0:Math.round((user.totalWins/user.totalGames)*10000)/10000;
        return res.json({nickname:user.nickname,totalWins:user.totalWins,totalGames:user.totalGames,winRate});
      }catch(e){
        return res.status(500).json({error:"Failed to load profile"});
      }
    });

    router.post("/api/game/character",requireAuth,async(req,res)=>{
      try{
        const character=String(req.body?.character||"").toUpperCase();
        if(!CHARACTER_LABEL[character])return res.status(400).json({error:"Invalid character"});
        const result=await prisma.$transaction(async(tx)=>{
          const player=await tx.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"},include:{assets:true,room:true}});
          if(!player)throw new Error("Player not found");
          if(player.room?.status!=="WAITING")throw new Error("Game already started");
          // 현재 접속 중인 플레이어(socketId가 있는)만 캐릭터 중복 체크
          const others=await getLatestPlayersByUser(tx,player.roomId);
          const activeOthers=others.filter((p)=>p.socketId&&p.userId!==player.userId);
          if(activeOthers.some((p)=>p.character===character))throw new Error("Character already taken");
          let cash=INITIAL_CASH;
          let assets=player.assets||await tx.playerAsset.create({data:{playerId:player.id}});
          assets=await tx.playerAsset.update({where:{playerId:player.id},data:{samsung:0,tesla:0,lockheed:0,gold:0,bitcoin:0}});
          if(character===CHARACTER_LABEL.MUSK)cash+=MUSK_BONUS;
          if(character===CHARACTER_LABEL.LEE){
            assets=await tx.playerAsset.update({where:{playerId:player.id},data:{samsung:LEE_START_SAMSUNG_SHARES}});
          }
          const updated=await tx.player.update({where:{id:player.id},data:{character,cash,totalAsset:cash,location:0,extraTurnUsed:false}});
          return{playerId:player.id,character:updated.character,cash:updated.cash,roomId:player.roomId,userId:player.userId};
        });
        await emitAssetUpdate(result.playerId);
        if(io)io.to(result.roomId).emit("character_update",{playerId:result.playerId,userId:result.userId,character:result.character});
        return res.json({playerId:result.playerId,character:result.character,cash:result.cash});
      }catch(e){
        const message=e?.message||"Failed to set character";
        return res.status(400).json({error:message});
      }
    });

    router.post("/api/game/worldcup",requireAuth,async(req,res)=>{
      try{
        const targetNodeIdx=Number(req.body?.nodeIdx);
        if(!Number.isInteger(targetNodeIdx))return res.status(400).json({error:"Invalid node"});
        const result=await prisma.$transaction(async(tx)=>{
          const host=await tx.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"}});
          if(!host)throw new Error("Player not found");
          if(host.location!==16)throw new Error("Not on EXPO");
          if(host.cash<WORLD_CUP_COST)throw new Error("Insufficient cash");
          const hostLand=await tx.gameLand.findFirst({where:{roomId:host.roomId,nodeIdx:targetNodeIdx,ownerId:host.id}});
          if(!hostLand)throw new Error("Land not owned");
          const mapNode=await tx.mapNode.findUnique({where:{nodeIdx:targetNodeIdx}});
          if(!mapNode||mapNode.type!=="LAND")throw new Error("Invalid land");
          const updatedHost=await tx.player.update({where:{id:host.id},data:{cash:host.cash-WORLD_CUP_COST}});
          const players=await tx.player.findMany({where:{roomId:host.roomId}});
          const tollBase=getLandBaseToll(targetNodeIdx,mapNode.baseToll);
          const hostToll=applyWarMultiplier(applyTrumpBonus(tollBase,updatedHost.character),targetNodeIdx,true);
          for(const p of players){
            const movingData={location:targetNodeIdx};
            if(p.id!==updatedHost.id){
              const cash=p.cash-hostToll;
              await tx.player.update({where:{id:p.id},data:{...movingData,cash}});
              await tx.player.update({where:{id:updatedHost.id},data:{cash:updatedHost.cash+hostToll}});
              updatedHost.cash+=hostToll;
            }else{
              await tx.player.update({where:{id:p.id},data:movingData});
            }
          }
          return{roomId:host.roomId,hostId:host.id,nodeIdx:targetNodeIdx};
        });
        const roomPlayers=await prisma.player.findMany({where:{roomId:result.roomId},select:{id:true}});
        for(const p of roomPlayers){
          await emitAssetUpdate(p.id);
        }
        if(io)io.to(result.roomId).emit("worldcup",{hostId:result.hostId,nodeIdx:result.nodeIdx});
        return res.json(result);
      }catch(e){
        const message=e?.message||"Failed to host worldcup";
        return res.status(400).json({error:message});
      }
    });

    router.post("/api/game/war/lose",requireAuth,async(req,res)=>{
      try{
        const loserUserId=Number(req.body?.loserUserId);
        if(!Number.isInteger(loserUserId))return res.status(400).json({error:"Invalid loser"});
        const result=await prisma.$transaction(async(tx)=>{
          const loser=await tx.player.findFirst({where:{userId:loserUserId},orderBy:{id:"desc"}});
          if(!loser)throw new Error("Player not found");
          const destroyed=await destroyMostExpensiveLandmark(tx,loser.id);
          return{roomId:loser.roomId,loserId:loser.id,destroyed};
        });
        if(result.destroyed&&io){
          io.to(result.roomId).emit("landmark_destroyed",{loserId:result.loserId,landId:result.destroyed.id});
        }
        return res.json({ok:true});
      }catch(e){
        const message=e?.message||"Failed to process war loss";
        return res.status(400).json({error:message});
      }
    });

    router.post("/api/game/war-rate",requireAuth,async(req,res)=>{
      try{
        const opponentUserId=Number(req.body?.opponentUserId);
        if(!Number.isInteger(opponentUserId))return res.status(400).json({error:"Invalid opponent"});
        const result=await prisma.$transaction(async(tx)=>{
          const me=await tx.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"},include:{assets:true}});
          const opp=await tx.player.findFirst({where:{userId:opponentUserId},orderBy:{id:"desc"},include:{assets:true}});
          if(!me||!opp)throw new Error("Player not found");
          const marketData=await market.getOrCreateMarket(tx,me.roomId);
          const myAsset=calcWarAssetValue(me.assets||{samsung:0,tesla:0,lockheed:0,gold:0,bitcoin:0},marketData,me.cash);
          const oppAsset=calcWarAssetValue(opp.assets||{samsung:0,tesla:0,lockheed:0,gold:0,bitcoin:0},marketData,opp.cash);
          const winRate=calcWarWinRate({myAsset,oppAsset,character:me.character});
          return{myAsset,oppAsset,winRate};
        });
        return res.json(result);
      }catch(e){
        const message=e?.message||"Failed to calc war rate";
        return res.status(400).json({error:message});
      }
    });

    router.get("/api/test/roll",requireAuth,async(req,res)=>{
      try{
        const result=await rollDiceForUser({userId:req.user.id});
        return res.json(result);
      }catch(e){
        return res.status(500).json({error:"Failed to roll dice"});
      }
    });

    router.get("/api/bigint-test",(req,res)=>{
      res.json({cash:INITIAL_CASH,totalAsset:INITIAL_CASH});
    });

    router.post("/api/game/purchase",requireAuth,async(req,res)=>{
      try{
        const action=String(req.body?.action||"BUY").toUpperCase();
        const player=await prisma.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"}});
        if(!player)return res.status(404).json({error:"Player not found"});
        const targetNodeIdx=Number.isInteger(Number(req.body?.nodeIdx))?Number(req.body.nodeIdx):player.location;
        const isRemote=targetNodeIdx!==player.location;
        if(isRemote&&player.location!==0)return res.status(400).json({error:"Remote action not allowed"});
        const mapNode=await prisma.mapNode.findUnique({where:{nodeIdx:targetNodeIdx}});
        if(!mapNode||mapNode.type!=="LAND")return res.status(400).json({error:`Invalid tile type: ${mapNode?.type||"UNKNOWN"}`});
        const result=await prisma.$transaction(async(tx)=>{
          const freshPlayer=await tx.player.findUnique({where:{id:player.id}});
          if(!freshPlayer)throw new Error("Player not found");
          const currentTurn=currentTurnUserByRoom.get(player.roomId);
          if(currentTurn&&currentTurn!==player.userId)throw new Error("Not your turn");
          const actionWindow=actionWindowByRoom.get(player.roomId);
          if(!actionWindow||actionWindow.userId!==player.userId||actionWindow.location!==player.location)throw new Error("Action window closed");
          const freshLand=await tx.gameLand.findFirst({where:{roomId:player.roomId,nodeIdx:targetNodeIdx}});
          const visitCount=getVisitCount(player.id,targetNodeIdx);
          const lastAction=getLastAction(player.id,targetNodeIdx);
          const canUpgrade=visitCount>0&&lastAction!=="BUY"&&lastAction!=="TAKEOVER";
          if(action==="BUY"){
            if(isRemote)throw new Error("Remote action not allowed");
            if(freshLand&&freshLand.ownerId!=null)throw new Error("Land already owned");
            const landPrice=getEffectiveLandPrice(mapNode.baseToll,targetNodeIdx,false);
            if(freshPlayer.cash<landPrice)throw new Error("Insufficient cash");
            const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:freshPlayer.cash-landPrice}});
            if(freshLand){
              await tx.gameLand.update({where:{id:freshLand.id},data:{ownerId:player.id,isLandmark:false,purchasePrice:landPrice}});
            }else{
              await tx.gameLand.create({data:{roomId:player.roomId,nodeIdx:targetNodeIdx,ownerId:player.id,purchasePrice:landPrice}});
            }
            setVisitCount(player.id,targetNodeIdx,0);
            setLastAction(player.id,targetNodeIdx,"BUY");
            return{playerId:player.id,cash:updatedPlayer.cash,nodeIdx:targetNodeIdx,action};
          }
          if(action==="TAKEOVER"){
            if(isRemote)throw new Error("Remote action not allowed");
            if(!freshLand||!freshLand.ownerId||freshLand.ownerId===player.id)throw new Error("Invalid takeover");
            if(freshLand.isLandmark)throw new Error("Landmark protected");
            const landPrice=getEffectiveLandPrice(mapNode.baseToll,targetNodeIdx,true);
            const takeoverCost=landPrice*TAKEOVER_RATE_NUM/TAKEOVER_RATE_DEN;
            if(freshPlayer.cash<takeoverCost)throw new Error("Insufficient cash");
            const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:freshPlayer.cash-takeoverCost}});
            await tx.gameLand.update({where:{id:freshLand.id},data:{ownerId:player.id,isLandmark:false,purchasePrice:takeoverCost}});
            setVisitCount(player.id,targetNodeIdx,0);
            setLastAction(player.id,targetNodeIdx,"TAKEOVER");
            return{playerId:player.id,cash:updatedPlayer.cash,nodeIdx:targetNodeIdx,action,cost:takeoverCost};
          }
          if(action==="LANDMARK"){
            if(!freshLand||freshLand.ownerId!==player.id)throw new Error("Not your land");
            if(freshLand.isLandmark)throw new Error("Already landmark");
            if(!canUpgrade)throw new Error("Revisit required");
            const landPrice=getEffectiveLandPrice(mapNode.baseToll,targetNodeIdx,true);
            const buildCost=landPrice*LANDMARK_RATE_NUM/LANDMARK_RATE_DEN;
            if(freshPlayer.cash<buildCost)throw new Error("Insufficient cash");
            const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:freshPlayer.cash-buildCost}});
            await tx.gameLand.update({where:{id:freshLand.id},data:{isLandmark:true,purchasePrice:freshLand.purchasePrice+buildCost}});
            setLastAction(player.id,targetNodeIdx,"LANDMARK");
            return{playerId:player.id,cash:updatedPlayer.cash,nodeIdx:targetNodeIdx,action,cost:buildCost};
          }
          if(action==="SELL"){
            if(!freshLand||freshLand.ownerId!==player.id)throw new Error("Not your land");
            if(!canUpgrade)throw new Error("Revisit required");
            const refund=freshLand.purchasePrice*SELL_RATE_NUM/SELL_RATE_DEN;
            const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:freshPlayer.cash+refund}});
            await tx.gameLand.update({where:{id:freshLand.id},data:{ownerId:null,isLandmark:false,purchasePrice:0}});
            setLastAction(player.id,targetNodeIdx,"SELL");
            return{playerId:player.id,cash:updatedPlayer.cash,nodeIdx:targetNodeIdx,action,refund};
          }
          throw new Error("Invalid action");
        });
        await emitAssetUpdate(result.playerId);
        return res.json(result);
      }catch(e){
        const message=e?.message||"Failed to purchase land";
        return res.status(400).json({error:message});
      }
    });

    router.get("/api/test/purchase-cheat",requireAuth,async(req,res)=>{
      try{
        const player=await prisma.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"}});
        if(!player)return res.status(404).json({error:"Player not found"});
        const mapNode=await prisma.mapNode.findUnique({where:{nodeIdx:player.location}});
        if(!mapNode)return res.status(404).json({error:"Map node not found"});
        const land=await prisma.gameLand.findFirst({where:{roomId:player.roomId,nodeIdx:player.location}});
        if(land){
          await prisma.gameLand.update({where:{id:land.id},data:{ownerId:null}});
        }else{
          await prisma.gameLand.create({data:{roomId:player.roomId,nodeIdx:player.location,ownerId:null}});
        }
        return res.json({ok:true,nodeIdx:player.location});
      }catch(e){
        return res.status(500).json({error:"Failed to clear land owner"});
      }
    });

    router.get("/api/test/reset-lands",async(req,res)=>{
      try{
        await prisma.gameLand.deleteMany();
        return res.json({ok:true});
      }catch(e){
        return res.status(500).json({error:"Failed to reset lands"});
      }
    });

    return router;
  }

  async function destroyMostExpensiveLandmark(tx,playerId){
    const landmarks=await tx.gameLand.findMany({where:{ownerId:playerId,isLandmark:true},orderBy:{purchasePrice:"desc"}});
    if(landmarks.length===0)return null;
    const target=landmarks[0];
    return tx.gameLand.update({where:{id:target.id},data:{isLandmark:false}});
  }

  return{
    INITIAL_CASH,
    CHARACTER_LABEL,
    warState,
    roomTurnOrder,
    currentTurnUserByRoom,
    turnStateByRoom,
    actionWindowByRoom,
    getTurnPlayerId,
    getLatestPlayersByUser,
    getWarPayload,
    computeTotals,
    emitAssetUpdate,
    rollDiceForUser,
    calcWarAssetValue,
    calcWarWinRate,
    applyTrumpBonus,
    autoSellAssets,
    getLandBaseToll,
    getLandBasePrice,
    getEffectiveLandPrice,
    getVisitCount,
    setVisitCount,
    setLastAction,
    incrementVisit,
    getLastAction,
    createGameRoutes
  };
}

module.exports={createGameLogic,CHARACTER_LABEL,INITIAL_CASH};

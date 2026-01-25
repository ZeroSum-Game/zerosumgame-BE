const express=require("express");

const MARKET_SYMBOLS={
  SAMSUNG:{key:"samsung",priceField:"priceSamsung",prevField:"prevSamsung"},
  TESLA:{key:"tesla",priceField:"priceTesla",prevField:"prevTesla"},
  LOCKHEED:{key:"lockheed",priceField:"priceLockheed",prevField:"prevLockheed"},
  GOLD:{key:"gold",priceField:"priceGold",prevField:"prevGold"},
  BITCOIN:{key:"bitcoin",priceField:"priceBtc",prevField:"prevBtc"}
};
const MARKET_DEFAULTS={
  priceSamsung:100000n,
  priceTesla:500000n,
  priceLockheed:800000n,
  priceGold:200000n,
  priceBtc:5000000n,
  prevSamsung:100000n,
  prevTesla:500000n,
  prevLockheed:800000n,
  prevGold:200000n,
  prevBtc:5000000n
};

function createMarketModule({prisma}){
  const tradeLockByRoom=new Map();

  function normalizeSymbol(symbol){
    if(!symbol)return null;
    const key=String(symbol).trim().toUpperCase();
    return MARKET_SYMBOLS[key]?key:null;
  }
  function applyMarketDelta(price,deltaRate){
    const next=Math.max(1,Math.round(Number(price)*(1+deltaRate)));
    return BigInt(next);
  }
  async function getOrCreateMarket(tx,roomId){
    return tx.market.upsert({where:{roomId},update:{},create:{roomId,...MARKET_DEFAULTS}});
  }
  async function resetMarketDefaults(tx,roomId){
    return tx.market.upsert({where:{roomId},update:{...MARKET_DEFAULTS},create:{roomId,...MARKET_DEFAULTS}});
  }
  function getTradeSnapshot(roomId,userId,market){
    const existing=tradeLockByRoom.get(roomId);
    if(!existing||existing.userId!==userId){
      const snapshot={samsung:market.priceSamsung,tesla:market.priceTesla,lockheed:market.priceLockheed,gold:market.priceGold,bitcoin:market.priceBtc};
      tradeLockByRoom.set(roomId,{userId,prices:snapshot});
      return snapshot;
    }
    return existing.prices;
  }
  function clearTradeLock(roomId){
    tradeLockByRoom.delete(roomId);
  }

  function createMarketRoutes({requireAuth,gameLogic}){
    const router=express.Router();

    router.get("/api/market",async(req,res)=>{
      try{
        const market=await prisma.$transaction(async(tx)=>getOrCreateMarket(tx,1));
        return res.json({samsung:market.priceSamsung,tesla:market.priceTesla,lockheed:market.priceLockheed,gold:market.priceGold,bitcoin:market.priceBtc});
      }catch(e){
        return res.status(500).json({error:"Failed to load market"});
      }
    });

    router.post("/api/game/stock/sell",requireAuth,async(req,res)=>{
      try{
        const {stockName,quantity}=req.body||{};
        const norm=normalizeSymbol(stockName);
        const qty=Number(quantity);
        if(!norm||!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:"Invalid request"});
        const result=await prisma.$transaction(async(tx)=>{
          const player=await tx.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"},include:{assets:true}});
          if(!player)throw new Error("Player not found");
          const currentTurn=gameLogic.currentTurnUserByRoom.get(player.roomId);
          if(currentTurn&&currentTurn!==player.userId)throw new Error("Not your turn");
          const actionWindow=gameLogic.actionWindowByRoom.get(player.roomId);
          if(!actionWindow||actionWindow.userId!==player.userId||actionWindow.location!==player.location)throw new Error("Action window closed");
          const market=await getOrCreateMarket(tx,player.roomId);
          const snapshot=getTradeSnapshot(player.roomId,player.userId,market);
          const priceKey=MARKET_SYMBOLS[norm].key;
          const price=snapshot[priceKey];
          const total=price*BigInt(qty);
          const assets=player.assets||await tx.playerAsset.create({data:{playerId:player.id}});
          const currentQty=assets[priceKey];
          if(currentQty<qty)throw new Error("Insufficient assets");
          const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:player.cash+total}});
          const updatedAssets=await tx.playerAsset.update({where:{playerId:player.id},data:{[priceKey]:currentQty-qty}});
          return{playerId:player.id,roomId:player.roomId,cash:updatedPlayer.cash,assets:updatedAssets,price,quantity:qty,type:"SELL",symbol:norm,market};
        });
        await gameLogic.emitAssetUpdate(result.playerId);
        return res.json(result);
      }catch(e){
        const message=e?.message==="Insufficient assets"||e?.message==="Player not found"||e?.message==="Not your turn"?e.message:"Failed to sell stock";
        return res.status(400).json({error:message});
      }
    });

    router.post("/api/game/stock",requireAuth,async(req,res)=>{
      try{
        const {symbol,quantity,type}=req.body||{};
        const norm=normalizeSymbol(symbol);
        const qty=Number(quantity);
        const action=String(type||"").toUpperCase();
        if(!norm||!Number.isInteger(qty)||qty<=0||(action!=="BUY"&&action!=="SELL"))return res.status(400).json({error:"Invalid request"});
        const result=await prisma.$transaction(async(tx)=>{
          const player=await tx.player.findFirst({where:{userId:req.user.id},orderBy:{id:"desc"},include:{assets:true}});
          if(!player)throw new Error("Player not found");
          const currentTurn=gameLogic.currentTurnUserByRoom.get(player.roomId);
          if(currentTurn&&currentTurn!==player.userId)throw new Error("Not your turn");
          const actionWindow=gameLogic.actionWindowByRoom.get(player.roomId);
          if(!actionWindow||actionWindow.userId!==player.userId||actionWindow.location!==player.location)throw new Error("Action window closed");
          const market=await getOrCreateMarket(tx,player.roomId);
          const snapshot=getTradeSnapshot(player.roomId,player.userId,market);
          const priceKey=MARKET_SYMBOLS[norm].key;
          const price=snapshot[priceKey];
          const total=price*BigInt(qty);
          const assets=player.assets||await tx.playerAsset.create({data:{playerId:player.id}});
          const currentQty=assets[priceKey];
          if(action==="BUY"){
            if(player.cash<total)throw new Error("Insufficient cash");
            const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:player.cash-total}});
            const updatedAssets=await tx.playerAsset.update({where:{playerId:player.id},data:{[priceKey]:currentQty+qty}});
            return{playerId:player.id,roomId:player.roomId,cash:updatedPlayer.cash,assets:updatedAssets,price,quantity:qty,type:action,symbol:norm,market};
          }
          if(currentQty<qty)throw new Error("Insufficient assets");
          const updatedPlayer=await tx.player.update({where:{id:player.id},data:{cash:player.cash+total}});
          const updatedAssets=await tx.playerAsset.update({where:{playerId:player.id},data:{[priceKey]:currentQty-qty}});
          return{playerId:player.id,roomId:player.roomId,cash:updatedPlayer.cash,assets:updatedAssets,price,quantity:qty,type:action,symbol:norm,market};
        });
        await gameLogic.emitAssetUpdate(result.playerId);
        return res.json(result);
      }catch(e){
        const message=e?.message==="Insufficient cash"||e?.message==="Insufficient assets"||e?.message==="Player not found"||e?.message==="Not your turn"?e.message:"Failed to trade stock";
        return res.status(400).json({error:message});
      }
    });

    return router;
  }

  return{MARKET_SYMBOLS,MARKET_DEFAULTS,normalizeSymbol,applyMarketDelta,getOrCreateMarket,resetMarketDefaults,getTradeSnapshot,clearTradeLock,createMarketRoutes};
}

module.exports={createMarketModule,MARKET_SYMBOLS,MARKET_DEFAULTS};

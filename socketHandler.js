function initSocketHandlers({io,prisma,auth,gameLogic,market}){
  const lobbyStateByRoom=new Map();
  const socketUserMap=new Map();
  const orderPickingByRoom=new Map();
  const rollingUserByRoom=new Map();

  io.use((socket,next)=>{
    try{
      const token=socket.handshake.auth?.token;
      if(!token)return next(new Error("Unauthorized"));
      const user=auth.verifySocketToken(token);
      socket.user=user;
      return next();
    }catch(err){
      return next(new Error("Unauthorized"));
    }
  });

  function getLobbyState(roomId){
    if(!lobbyStateByRoom.has(roomId)){
      lobbyStateByRoom.set(roomId,{hostUserId:null,readyUserIds:new Set(),players:new Map()});
    }
    return lobbyStateByRoom.get(roomId);
  }

  function buildLobbyPayload(roomId){
    const lobby=getLobbyState(roomId);
    const players=Array.from(lobby.players.values()).map((p)=>({
      userId:p.userId,
      playerId:p.playerId,
      nickname:p.nickname||`Player${p.userId}`,
      character:p.character||null,
      ready:lobby.readyUserIds.has(p.userId),
      isHost:lobby.hostUserId===p.userId
    }));
    const allReady=players.length>0&&players.every((p)=>p.ready);
    return{hostUserId:lobby.hostUserId,players,allReady};
  }

  function resetWarState(){
    if(!gameLogic.warState)return;
    gameLogic.warState.active=false;
    gameLogic.warState.warLine=null;
    gameLogic.warState.warNode=null;
    gameLogic.warState.turnsLeft=0;
    gameLogic.warState.recoveryActive=false;
    gameLogic.warState.recoveryLine=1;
    gameLogic.warState.recoveryNode=1;
  }

  function isActiveSocketId(socketId){
    return !!socketId&&!!io&&!!io.sockets&&!!io.sockets.sockets&&io.sockets.sockets.has(socketId);
  }

  async function getActivePlayersByUser(roomId){
    const players=await gameLogic.getLatestPlayersByUser(prisma,roomId);
    return players.filter((p)=>isActiveSocketId(p.socketId));
  }

  async function syncLobbyPlayers(roomId){
    const lobby=getLobbyState(roomId);
    if(lobby.players.size>0)return lobby;
    const players=await getActivePlayersByUser(roomId);
    if(players.length===0)return lobby;
    const users=await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}});
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    players.forEach((p)=>{
      lobby.players.set(p.userId,{
        userId:p.userId,
        nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
        playerId:p.id,
        character:p.character||null
      });
    });
    if(!lobby.hostUserId&&players.length>0)lobby.hostUserId=players[0].userId;
    return lobby;
  }

  async function buildResumePayload(roomId){
    const activePlayers=await getActivePlayersByUser(roomId);
    const players=activePlayers.length?activePlayers:await gameLogic.getLatestPlayersByUser(prisma,roomId);
    const users=players.length?await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}}):[];
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    const playersPayload=players.map((p)=>({
      playerId:p.id,
      userId:p.userId,
      nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
      character:p.character||null,
      location:typeof p.location==="number"?p.location:0,
      cash:p.cash,
      totalAsset:p.totalAsset
    }));
    const playerIdSet=new Set(playersPayload.map((p)=>p.playerId));
    const storedOrder=gameLogic.roomTurnOrder.get(roomId);
    const turnOrderPlayerIds=storedOrder?storedOrder.filter((id)=>playerIdSet.has(id)):playersPayload.map((p)=>p.playerId);
    if(turnOrderPlayerIds.length)gameLogic.roomTurnOrder.set(roomId,turnOrderPlayerIds);
    else gameLogic.roomTurnOrder.delete(roomId);
    const playerIdToUser=new Map(playersPayload.map((p)=>[p.playerId,p.userId]));
    const turnOrder=turnOrderPlayerIds.map((id)=>playerIdToUser.get(id)).filter((id)=>id!=null);
    const turnPlayerId=turnOrderPlayerIds.length?await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,roomId)):null;
    let currentTurn=gameLogic.currentTurnUserByRoom.get(roomId)||null;
    if(!currentTurn&&turnPlayerId){
      const turnPlayer=await prisma.player.findUnique({where:{id:turnPlayerId},select:{userId:true}});
      currentTurn=turnPlayer?.userId||null;
      if(currentTurn)gameLogic.currentTurnUserByRoom.set(roomId,currentTurn);
    }
    if(currentTurn&&!gameLogic.turnStateByRoom.get(roomId)){
      gameLogic.turnStateByRoom.set(roomId,{userId:currentTurn,rolled:false,extraRoll:false});
    }
    return{turnPlayerId,currentTurn,turnOrder,turnOrderPlayerIds,players:playersPayload};
  }

  async function ensureCurrentTurnUser(roomId){
    let currentTurn=gameLogic.currentTurnUserByRoom.get(roomId)||null;
    if(currentTurn)return currentTurn;
    const turnPlayerId=await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,roomId));
    if(!turnPlayerId)return null;
    const turnPlayer=await prisma.player.findUnique({where:{id:turnPlayerId},select:{userId:true}});
    currentTurn=turnPlayer?.userId||null;
    if(currentTurn)gameLogic.currentTurnUserByRoom.set(roomId,currentTurn);
    return currentTurn;
  }

  async function buildStartPayload(roomId,turnOrderPlayerIds){
    const players=await prisma.player.findMany({where:{id:{in:turnOrderPlayerIds}}});
    const users=await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}});
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    const byId=new Map(players.map((p)=>[p.id,p]));
    const orderedPlayers=turnOrderPlayerIds.map((id)=>byId.get(id)).filter(Boolean);
    const playersPayload=orderedPlayers.map((p)=>({
      playerId:p.id,
      userId:p.userId,
      nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
      character:p.character||null,
      location:typeof p.location==="number"?p.location:0,
      cash:p.cash,
      totalAsset:p.totalAsset
    }));
    const currentTurn=gameLogic.currentTurnUserByRoom.get(roomId)||playersPayload[0]?.userId||null;
    const turnOrder=playersPayload.map((p)=>p.userId);
    return{players:playersPayload,currentTurn,turnOrder,turnOrderPlayerIds,turnPlayerId:playersPayload[0]?.playerId||null};
  }

  io.on("connection",(socket)=>{
    socket.on("join_room",async(roomId)=>{
      try{
        const sessionUserId=socket.user?.id;
        const numericRoomId=Number(roomId);
        if(!sessionUserId||!Number.isInteger(numericRoomId)){
          socket.emit("join_error",{message:"Invalid room"});
          return;
        }
        const resolvedRoomId=numericRoomId;
        let room=await prisma.room.findUnique({where:{id:resolvedRoomId}});
        if(!room){
          room=await prisma.room.create({data:{id:resolvedRoomId,roomCode:"MAIN",status:"WAITING"}});
        }
        const lobbyState=getLobbyState(resolvedRoomId);
        const MAX_PLAYERS=4;
        if(!lobbyState.players.has(sessionUserId)&&lobbyState.players.size>=MAX_PLAYERS){
          socket.emit("join_error",{message:`Room is full (${MAX_PLAYERS} max)`});
          return;
        }
        if(room.status==="ENDED"&&lobbyState.players.size===0){
          room=await prisma.room.update({where:{id:resolvedRoomId},data:{status:"WAITING",turnPlayerIdx:0,currentTurn:1}});
          gameLogic.currentTurnUserByRoom.delete(resolvedRoomId);
          gameLogic.roomTurnOrder.delete(resolvedRoomId);
          gameLogic.actionWindowByRoom.delete(resolvedRoomId);
          gameLogic.turnStateByRoom.delete(resolvedRoomId);
          market.clearTradeLock(resolvedRoomId);
          rollingUserByRoom.delete(resolvedRoomId);
          orderPickingByRoom.delete(resolvedRoomId);
          resetWarState();
        }
        const user=await prisma.user.findUnique({where:{id:sessionUserId}});
        let player=await prisma.player.findFirst({where:{roomId:resolvedRoomId,userId:sessionUserId},orderBy:{id:"desc"},include:{assets:true}});
        if(!player){
          player=await prisma.player.create({
            data:{
              roomId:resolvedRoomId,
              userId:sessionUserId,
              socketId:socket.id,
              cash:gameLogic.INITIAL_CASH,
              totalAsset:gameLogic.INITIAL_CASH,
              assets:{create:{samsung:0,tesla:0,lockheed:0,gold:0,bitcoin:0}}
            },
            include:{assets:true}
          });
        }else{
          player=await prisma.player.update({where:{id:player.id},data:{socketId:socket.id},include:{assets:true}});
        }
        if(room.status==="WAITING"&&player.character){
          player=await prisma.player.update({where:{id:player.id},data:{character:null},include:{assets:true}});
        }
        if(room.status==="PLAYING"){
          await syncLobbyPlayers(resolvedRoomId);
          if(!gameLogic.roomTurnOrder.get(resolvedRoomId)){
            const activePlayers=await getActivePlayersByUser(resolvedRoomId);
            const fallbackOrder=activePlayers.slice().sort((a,b)=>a.id-b.id).map((p)=>p.id);
            if(fallbackOrder.length)gameLogic.roomTurnOrder.set(resolvedRoomId,fallbackOrder);
          }
        }
        socket.join(resolvedRoomId);
        socketUserMap.set(socket.id,{roomId:resolvedRoomId,userId:sessionUserId});
        const lobby=getLobbyState(resolvedRoomId);
        lobby.players.set(sessionUserId,{userId:sessionUserId,nickname:user?.nickname||`Player${sessionUserId}`,playerId:player.id,character:player.character});
        if(!lobby.hostUserId)lobby.hostUserId=sessionUserId;
        if(room.status==="PLAYING"){
          await ensureCurrentTurnUser(resolvedRoomId);
        }
        const turnPlayerId=await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,resolvedRoomId));
        const marketData=await prisma.$transaction(async(tx)=>market.getOrCreateMarket(tx,resolvedRoomId));
        const lobbyPayload=buildLobbyPayload(resolvedRoomId);
        socket.emit("join_success",{roomId:resolvedRoomId,message:"Join success",player,turnPlayerId,war:gameLogic.getWarPayload(),roomStatus:room.status,lobby:lobbyPayload,currentTurn:gameLogic.currentTurnUserByRoom.get(resolvedRoomId)||null});
        socket.emit("market_update",{samsung:marketData.priceSamsung,tesla:marketData.priceTesla,lockheed:marketData.priceLockheed,gold:marketData.priceGold,bitcoin:marketData.priceBtc,prevSamsung:marketData.prevSamsung,prevTesla:marketData.prevTesla,prevLockheed:marketData.prevLockheed,prevGold:marketData.prevGold,prevBtc:marketData.prevBtc});
        socket.emit("war_state",gameLogic.getWarPayload());
        io.to(resolvedRoomId).emit("lobby_update",lobbyPayload);
        await gameLogic.emitAssetUpdate(player.id);
        if(room.status==="PLAYING"){
          const resumePayload=await buildResumePayload(resolvedRoomId);
          socket.emit("game_start",resumePayload);
        }
      }catch(err){
        socket.emit("join_error",{message:"Failed to join room"});
      }
    });

    socket.on("set_ready",async({ready})=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info)return;
        const lobby=getLobbyState(info.roomId);
        const player=await prisma.player.findFirst({where:{userId:info.userId,roomId:info.roomId},orderBy:{id:"desc"}});
        const isReady=!!ready;
        if(isReady&&(!player||!player.character)){
          socket.emit("ready_error",{message:"Select a character before ready"});
          return;
        }
        if(isReady)lobby.readyUserIds.add(info.userId);
        else lobby.readyUserIds.delete(info.userId);
        if(player){
          const entry=lobby.players.get(info.userId);
          if(entry){
            entry.character=player.character||null;
            entry.playerId=player.id;
          }
          if(player.character)io.to(info.roomId).emit("character_update",{playerId:player.id,userId:info.userId,character:player.character});
        }
        io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
      }catch(err){}
    });

    socket.on("start_game",async()=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("start_error",{message:"Room not joined"});
          return;
        }
        const roomId=info.roomId;
        const room=await prisma.room.findUnique({where:{id:roomId}});
        if(!room){
          socket.emit("start_error",{message:"Room not found"});
          return;
        }
        if(room.status==="PLAYING"){
          socket.emit("start_error",{message:"Game already started"});
          return;
        }
        if(orderPickingByRoom.has(roomId)){
          socket.emit("start_error",{message:"Order picking already started"});
          return;
        }
        const lobby=await syncLobbyPlayers(roomId);
        if(lobby.hostUserId!==info.userId){
          socket.emit("start_error",{message:"Only the host can start"});
          return;
        }
        const activePlayers=await getActivePlayersByUser(roomId);
        if(activePlayers.length<2){
          socket.emit("start_error",{message:"At least 2 players are required"});
          return;
        }
        const users=await prisma.user.findMany({where:{id:{in:activePlayers.map((p)=>p.userId)}},select:{id:true,nickname:true}});
        const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
        activePlayers.forEach((p)=>{
          const entry=lobby.players.get(p.userId);
          if(entry){
            entry.playerId=p.id;
            entry.character=p.character||null;
            entry.nickname=entry.nickname||nicknameByUser.get(p.userId)||`Player${p.userId}`;
          }else{
            lobby.players.set(p.userId,{
              userId:p.userId,
              nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
              playerId:p.id,
              character:p.character||null
            });
          }
        });
        const lobbyPayload=buildLobbyPayload(roomId);
        if(lobbyPayload.players.length<2||!lobbyPayload.allReady){
          socket.emit("start_error",{message:"All players must be ready"});
          return;
        }
        if(activePlayers.some((p)=>!p.character)){
          socket.emit("start_error",{message:"All players must select a character"});
          return;
        }
        const availableCards=Array.from({length:activePlayers.length},(_,i)=>i+1);
        orderPickingByRoom.set(roomId,{
          availableCards,
          picks:new Map(),
          players:activePlayers.map((p)=>({
            userId:p.userId,
            playerId:p.id,
            nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
            character:p.character||null
          }))
        });
        io.to(roomId).emit("order_picking_start",{availableCards});
      }catch(err){
        socket.emit("start_error",{message:"Failed to start game"});
      }
    });

    socket.on("pick_order_card",async(cardNumber)=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("pick_error",{message:"Room not joined"});
          return;
        }
        const roomId=info.roomId;
        const orderState=orderPickingByRoom.get(roomId);
        if(!orderState){
          socket.emit("pick_error",{message:"Order picking not active"});
          return;
        }
        const pick=Number(cardNumber);
        if(!Number.isInteger(pick)){
          socket.emit("pick_error",{message:"Invalid card"});
          return;
        }
        if(!orderState.availableCards.includes(pick)){
          socket.emit("pick_error",{message:"Invalid card"});
          return;
        }
        if(orderState.picks.has(info.userId)){
          socket.emit("pick_error",{message:"Already picked"});
          return;
        }
        if(Array.from(orderState.picks.values()).includes(pick)){
          socket.emit("pick_error",{message:"Card already taken"});
          return;
        }
        orderState.picks.set(info.userId,pick);
        const pickedCards=Array.from(orderState.picks.values());
        io.to(roomId).emit("order_card_picked",{userId:info.userId,cardNumber:pick,pickedCards});

        if(orderState.picks.size===orderState.players.length){
          const pickByUser=new Map(orderState.picks);
          const ordered=orderState.players
            .map((p)=>({
              ...p,
              cardNumber:pickByUser.get(p.userId)
            }))
            .filter((p)=>Number.isInteger(p.cardNumber))
            .sort((a,b)=>a.cardNumber-b.cardNumber);
          const orderResults=ordered.map((p,idx)=>({
            userId:p.userId,
            playerId:p.playerId,
            cardNumber:p.cardNumber,
            turnOrder:idx+1,
            nickname:p.nickname
          }));
          const turnOrderPlayerIds=ordered.map((p)=>p.playerId);
          gameLogic.roomTurnOrder.set(roomId,turnOrderPlayerIds);
          const firstUserId=ordered[0]?.userId||null;
          if(firstUserId)gameLogic.currentTurnUserByRoom.set(roomId,firstUserId);
          if(firstUserId)gameLogic.turnStateByRoom.set(roomId,{userId:firstUserId,rolled:false,extraRoll:false});
          gameLogic.actionWindowByRoom.delete(roomId);
          market.clearTradeLock(roomId);

          await prisma.$transaction(async(tx)=>{
            await tx.room.update({where:{id:roomId},data:{status:"PLAYING",turnPlayerIdx:0,currentTurn:1,maxTurn:10}});
            await market.resetMarketDefaults(tx,roomId);
          });

          io.to(roomId).emit("order_picking_complete",{orderResults});
          orderPickingByRoom.delete(roomId);

          setTimeout(()=>{
            void (async()=>{
              try{
                const payload=await buildStartPayload(roomId,turnOrderPlayerIds);
                io.to(roomId).emit("game_start",payload);
                io.to(roomId).emit("lobby_update",buildLobbyPayload(roomId));
              }catch(err){
                io.to(roomId).emit("start_error",{message:"Failed to start game"});
              }
            })();
          },1200);
        }
      }catch(err){
        socket.emit("pick_error",{message:"Failed to pick card"});
      }
    });

    socket.on("roll_dice",async()=>{
      try{
        const userId=socket.user?.id;
        if(!userId){
          socket.emit("roll_error",{message:"Login session expired"});
          return;
        }
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("roll_error",{message:"Room not joined"});
          return;
        }
        const rollingUserId=rollingUserByRoom.get(info.roomId);
        if(rollingUserId&&rollingUserId!==userId){
          socket.emit("roll_error",{message:"Another player is rolling"});
          return;
        }
        if(rollingUserId===userId){
          socket.emit("roll_error",{message:"Already rolling"});
          return;
        }
        const result=await gameLogic.rollDiceForUser({userId});
        if(result.turnUserId)gameLogic.currentTurnUserByRoom.set(result.roomId,result.turnUserId);
        rollingUserByRoom.set(info.roomId,userId);
        io.to(info.roomId).emit("dice_rolling_started",{userId});
        setTimeout(()=>{
          try{
            io.to(result.roomId).emit("dice_rolled",{userId,dice1:result.dice1,dice2:result.dice2,isDouble:result.isDouble,hasExtraTurn:result.hasExtraTurn,passedStart:result.passedStart,player:result.player,turnPlayerId:result.turnPlayerId,turnUserId:result.turnUserId,autoSellEvents:result.autoSellEvents});
            io.to(result.roomId).emit("playerMove",{userId,playerId:result.player.id,character:result.player.character,oldLocation:result.oldLocation,newLocation:result.newLocation,dice1:result.dice1,dice2:result.dice2,isDouble:result.isDouble,hasExtraTurn:result.hasExtraTurn,passedStart:result.passedStart,turnPlayerId:result.turnPlayerId,turnUserId:result.turnUserId,autoSellEvents:result.autoSellEvents});
            if(result.cardEvent){
              io.to(result.roomId).emit("drawCard",result.cardEvent);
            }
            if(result.market){
              io.to(result.roomId).emit("market_update",{samsung:result.market.priceSamsung,tesla:result.market.priceTesla,lockheed:result.market.priceLockheed,gold:result.market.priceGold,bitcoin:result.market.priceBtc,prevSamsung:result.market.prevSamsung,prevTesla:result.market.prevTesla,prevLockheed:result.market.prevLockheed,prevGold:result.market.prevGold,prevBtc:result.market.prevBtc});
            }
            if(result.war){
              io.to(result.roomId).emit("war_state",result.war);
              if(result.warStarted)io.to(result.roomId).emit("war_start",result.war);
              if(result.warEnded)io.to(result.roomId).emit("war_end",result.war);
            }
            gameLogic.emitAssetUpdate(result.player.id);
            if(result.tollOwnerId)gameLogic.emitAssetUpdate(result.tollOwnerId);
          }catch(err){
            if(rollingUserByRoom.get(info.roomId)===userId){
              rollingUserByRoom.delete(info.roomId);
              io.to(info.roomId).emit("dice_roll_cancelled",{userId,reason:"EMIT_FAILED"});
            }
            socket.emit("roll_error",{message:"Failed to broadcast dice result"});
            return;
          }
          if(rollingUserByRoom.get(info.roomId)===userId){
            rollingUserByRoom.delete(info.roomId);
          }
        },800);
      }catch(err){
        socket.emit("roll_error",{message:err?.message||"Failed to roll dice"});
      }
    });

    socket.on("end_turn",async()=>{
      try{
        const userId=socket.user?.id;
        if(!userId){
          socket.emit("turn_error",{message:"Login session expired"});
          return;
        }
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("turn_error",{message:"Room not joined"});
          return;
        }
        if(rollingUserByRoom.get(info.roomId)){
          socket.emit("turn_error",{message:"Dice is still rolling"});
          return;
        }
        const currentTurnUserId=await ensureCurrentTurnUser(info.roomId);
        if(!currentTurnUserId||currentTurnUserId!==userId){
          socket.emit("turn_error",{message:"Not your turn"});
          return;
        }
        const turnState=gameLogic.turnStateByRoom.get(info.roomId);
        if(!turnState||!turnState.rolled){
          socket.emit("turn_error",{message:"Roll before ending"});
          return;
        }
        if(turnState.extraRoll){
          socket.emit("turn_error",{message:"Extra turn available"});
          return;
        }
        gameLogic.actionWindowByRoom.delete(info.roomId);
        market.clearTradeLock(info.roomId);
        await prisma.player.updateMany({where:{roomId:info.roomId,userId},data:{extraTurnUsed:false}});

        const turnResult=await prisma.$transaction(async(tx)=>{
          const room=await tx.room.findUnique({where:{id:info.roomId}});
          if(!room)throw new Error("Room not found");
          const allPlayers=await gameLogic.getLatestPlayersByUser(tx,info.roomId);
          const activePlayers=allPlayers.filter((p)=>isActiveSocketId(p.socketId));
          const players=activePlayers.length?activePlayers:allPlayers;
          if(players.length===0)throw new Error("No players in room");
          let turnOrder=gameLogic.roomTurnOrder.get(info.roomId);
          const playerIds=players.map((p)=>p.id);
          const playerIdSet=new Set(playerIds);
          if(turnOrder&&turnOrder.length){
            const filtered=turnOrder.filter((id)=>playerIdSet.has(id));
            const filteredSet=new Set(filtered);
            const missing=playerIds.filter((id)=>!filteredSet.has(id));
            turnOrder=missing.length?filtered.concat(missing):filtered;
          }
          if(!turnOrder||turnOrder.length===0){
            turnOrder=players.slice().sort((a,b)=>a.id-b.id).map((p)=>p.id);
          }
          gameLogic.roomTurnOrder.set(info.roomId,turnOrder);
          const nextIndex=(room.turnPlayerIdx+1)%turnOrder.length;
          const wrapped=nextIndex===0;
          const nextTurn=wrapped?room.currentTurn+1:room.currentTurn;
          const reachedEnd=nextTurn>room.maxTurn;
          const updateData=reachedEnd?{status:"ENDED"}:{status:"PLAYING",turnPlayerIdx:nextIndex,currentTurn:nextTurn};
          await tx.room.update({where:{id:info.roomId},data:updateData});
          const nextPlayerId=turnOrder[nextIndex];
          const nextPlayer=await tx.player.findUnique({where:{id:nextPlayerId},select:{userId:true}});
          return{room,turnOrder,nextIndex,wrapped,nextTurn,reachedEnd,nextPlayerId,nextUserId:nextPlayer?.userId||null};
        });

        let warEnded=false;
        if(gameLogic.warState.active){
          gameLogic.warState.turnsLeft=Math.max(0,gameLogic.warState.turnsLeft-1);
          if(gameLogic.warState.turnsLeft<=0){
            resetWarState();
            warEnded=true;
          }
        }
        const warPayload=gameLogic.getWarPayload();
        if(warEnded){
          io.to(info.roomId).emit("war_end",warPayload);
        }

        if(turnResult.reachedEnd){
          const latestPlayers=await gameLogic.getLatestPlayersByUser(prisma,info.roomId);
          const rankings=latestPlayers
            .slice()
            .sort((a,b)=>{
              if(a.totalAsset===b.totalAsset)return 0;
              return a.totalAsset>b.totalAsset?-1:1;
            })
            .map((p)=>({playerId:p.id,totalAsset:p.totalAsset}));
          io.to(info.roomId).emit("game_end",{rankings,maxTurn:turnResult.room.maxTurn});
          return;
        }

        if(turnResult.nextUserId){
          gameLogic.currentTurnUserByRoom.set(info.roomId,turnResult.nextUserId);
          gameLogic.turnStateByRoom.set(info.roomId,{userId:turnResult.nextUserId,rolled:false,extraRoll:false});
        }else{
          gameLogic.currentTurnUserByRoom.delete(info.roomId);
          gameLogic.turnStateByRoom.delete(info.roomId);
        }

        io.to(info.roomId).emit("turn_update",{turnPlayerId:turnResult.nextPlayerId,currentTurn:turnResult.nextUserId,war:warPayload});
      }catch(err){
        socket.emit("turn_error",{message:err?.message||"Failed to end turn"});
      }
    });

    socket.on("disconnect",async()=>{
      try{
        await prisma.player.updateMany({where:{socketId:socket.id},data:{socketId:null}});
      }catch(err){}

      const info=socketUserMap.get(socket.id);
      if(!info)return;
      socketUserMap.delete(socket.id);
      const lobby=getLobbyState(info.roomId);
      lobby.players.delete(info.userId);
      lobby.readyUserIds.delete(info.userId);
      if(lobby.hostUserId===info.userId){
        const nextHost=lobby.players.keys().next();
        lobby.hostUserId=nextHost.done?null:nextHost.value;
      }
      if(rollingUserByRoom.get(info.roomId)===info.userId){
        rollingUserByRoom.delete(info.roomId);
      }
      if(lobby.players.size===0){
        lobbyStateByRoom.delete(info.roomId);
        gameLogic.roomTurnOrder.delete(info.roomId);
        gameLogic.currentTurnUserByRoom.delete(info.roomId);
        gameLogic.turnStateByRoom.delete(info.roomId);
        gameLogic.actionWindowByRoom.delete(info.roomId);
        market.clearTradeLock(info.roomId);
        rollingUserByRoom.delete(info.roomId);
        orderPickingByRoom.delete(info.roomId);
        resetWarState();
        return;
      }
      io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
    });
  });

  return{getLobbyState,buildLobbyPayload,socketUserMap,lobbyStateByRoom};
}

module.exports={initSocketHandlers};

const http = require('http');
const { Server } = require("socket.io");
const { OpenAI } = require('openai');

const server = http.createServer();
const io = new Server(server, { cors: { origin: "*" } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TURN_DURATION = 30;
const MAX_TURNS = 10;
const colors = ["#E53935", "#1E88E5", "#43A047", "#FDD835", "#8E24AA", "#D81B60", "#F4511E", "#3949AB"];

let players = {};
let hostId = null;
let gameState = { status: 'lobby' };
let timerInterval = null;

function resetGame() {
    const seedWords = ["Futuro", "Natureza", "Arte", "Sociedade", "Conhecimento", "Justiça"];
    const randomSeed = seedWords[Math.floor(Math.random() * seedWords.length)];
    
    Object.values(players).forEach(p => {
        p.score = 0;
        p.submitted = false;
        p.lastGuess = null;
    });

    gameState = {
        status: 'playing',
        players: Object.values(players),
        hostId: hostId,
        chain: [{ word: randomSeed, playerId: null }],
        turn: 1,
        maxTurns: MAX_TURNS,
        isRoundActive: true,
        isEvaluating: false,
    };
}

function startTurnTimer() {
    gameState.timeLeft = TURN_DURATION;
    io.emit('timer', gameState.timeLeft);
    if(timerInterval) clearInterval(timerInterval);
    
    timerInterval = setInterval(() => {
        if(gameState.timeLeft > 0) {
            gameState.timeLeft--;
            io.emit('timer', gameState.timeLeft);
        }
        if (gameState.timeLeft <= 0) {
            clearInterval(timerInterval);
            if (!gameState.isEvaluating) {
                evaluateRound();
            }
        }
    }, 1000);
}

async function evaluateRound() {
    if (gameState.isEvaluating) return;
    gameState.isEvaluating = true;
    gameState.isRoundActive = false;
    clearInterval(timerInterval);
    io.emit('gameState', gameState);

    const lastTermInChain = gameState.chain[gameState.chain.length - 1].word;
    const guesses = Object.values(players)
                          .filter(p => p.submitted)
                          .map(p => ({ groupId: p.id, word: p.lastGuess }));

    if (guesses.length === 0) {
        io.emit('roundResult', "Ninguém jogou nesta rodada. Pulando...");
        startNextTurn();
        return;
    }

    try {
        const systemPrompt = `Você é um motor de análise semântica. Avalie a força da conexão entre um "termo-alvo" e "termos candidatos". Considere todas as formas de conexão. Retorne uma pontuação de 0 a 100. Responda APENAS com um objeto JSON válido com a chave "results", contendo um array de objetos com "word" e "score". Ex: {"results": [{"word": "Futuro", "score": 92}]}`;
        const userPrompt = `Alvo: "${lastTermInChain}". Candidatos: [${guesses.map(g => `"${g.word}"`).join(', ')}].`;
        
        const chatCompletion = await openai.chat.completions.create({
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            model: 'gpt-3.5-turbo',
            response_format: { type: "json_object" },
        });

        const resultJson = JSON.parse(chatCompletion.choices[0].message.content);
        const results = resultJson.results || [];
        
        results.forEach(result => {
            const guess = guesses.find(g => g.word.toLowerCase() === result.word.toLowerCase());
            if (guess) guess.score = result.score;
        });
        
        guesses.sort((a, b) => (b.score || 0) - (a.score || 0));
        const winnerOfTheRound = guesses[0];
        let alertMessage = `Fim do Turno ${gameState.turn}!\n\nMelhor Conexão: "${winnerOfTheRound.word}" (${winnerOfTheRound.score || 0}%) de ${players[winnerOfTheRound.groupId].name}!\n\n--- PONTOS DA RODADA ---\n`;
        
        guesses.forEach(guess => {
            let pointsToAdd = (guess.score >= 57) ? 2 : 0;
            if (guess.groupId === winnerOfTheRound.groupId) pointsToAdd += 5;
            players[guess.groupId].score += pointsToAdd;
            alertMessage += `${players[guess.groupId].name} ("${guess.word}"): ${guess.score || 0}% -> +${pointsToAdd} pontos\n`;
        });
        
        const randomIndex = Math.floor(Math.random() * guesses.length);
        const nextNodeData = guesses[randomIndex];
        gameState.chain.push({ word: nextNodeData.word, playerId: nextNodeData.groupId });
        alertMessage += `\n--- SALTO SEMÂNTICO! ---\nA próxima palavra é: "${nextNodeData.word}"!`;

        io.emit('roundResult', alertMessage);
        
    } catch (error) {
        console.error("Erro ao avaliar:", error);
        io.emit('roundResult', "Ocorreu um erro ao falar com a IA. Pulando turno.");
    } finally {
        startNextTurn();
    }
}

function startNextTurn() {
    if (gameState.turn >= MAX_TURNS) {
        gameState.status = 'finished';
        io.emit('gameOver', { players: Object.values(players), hostId: hostId });
        return;
    }
    gameState.turn++;
    gameState.isRoundActive = true;
    gameState.isEvaluating = false;
    Object.values(players).forEach(p => { 
        p.submitted = false; 
        p.lastGuess = null;
    });
    io.emit('gameState', gameState);
    startTurnTimer();
}

io.use((socket, next) => {
    const name = socket.handshake.auth.name;
    if (!name) return next(new Error("Nome inválido"));
    socket.name = name;
    next();
});

io.on('connection', (socket) => {
    if (gameState.status === 'playing' || Object.keys(players).length >= 50) {
        socket.disconnect(); 
        return;
    }

    // Lógica para definir o Host
    if (socket.name.toUpperCase() === 'LIDER' && !Object.values(players).some(p => p.isHost)) {
        hostId = socket.id;
    }
    
    players[socket.id] = { 
        id: socket.id, 
        name: socket.name, 
        color: colors[Object.keys(players).length % colors.length], 
        score: 0, 
        submitted: false, 
        lastGuess: null 
    };

    io.emit('lobbyState', { players: Object.values(players), hostId: hostId });

    socket.on('startGame', () => {
        if (socket.id === hostId && gameState.status !== 'playing') {
            resetGame();
            io.emit('gameState', gameState);
            startTurnTimer();
        }
    });

    socket.on('submitGuess', (word) => {
        if (players[socket.id] && gameState.isRoundActive && !players[socket.id].submitted) {
            players[socket.id].lastGuess = word;
            players[socket.id].submitted = true;
            io.emit('gameState', { ...gameState, players: Object.values(players) });
            if (Object.values(players).every(p => p.submitted)) {
                evaluateRound();
            }
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const wasHost = socket.id === hostId;
            delete players[socket.id];
            // Se o host se desconectar, anula a posição de host. O próximo a entrar como "LIDER" pode assumir.
            if (wasHost) {
                hostId = null;
            }
            io.emit('lobbyState', { players: Object.values(players), hostId: hostId });
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

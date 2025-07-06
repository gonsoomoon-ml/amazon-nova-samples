import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { fromIni } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient } from './client';
import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'fs';

// Configure AWS credentials
const AWS_PROFILE_NAME = process.env.AWS_PROFILE || 'bedrock-test';

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 프롬프트 관리 시스템
class PromptManager {
    private promptsPath = path.join(__dirname, '../public/prompts');

    public getPromptList(): string[] {
        try {
            const files = readdirSync(this.promptsPath);
            return files
                .filter(file => file.endsWith('.md'))
                .map(file => file.replace('.md', ''));
        } catch (error) {
            console.error('Error reading prompts directory:', error);
            return [];
        }
    }

    public getPromptContent(promptName: string): string | null {
        try {
            const filePath = path.join(this.promptsPath, `${promptName}.md`);
            return readFileSync(filePath, 'utf-8');
        } catch (error) {
            console.error(`Error reading prompt ${promptName}:`, error);
            return null;
        }
    }

    public parsePromptMetadata(content: string): { title: string; description: string; prompt: string } {
        const lines = content.split('\n');
        let title = '';
        let description = '';
        let prompt = '';

        // 첫 번째 줄에서 제목 추출
        if (lines[0].startsWith('# ')) {
            title = lines[0].substring(2).trim();
        }

        // description 줄 찾기
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].startsWith('description:')) {
                description = lines[i].substring(12).trim();
                break;
            }
        }

        // 첫 번째 빈 줄 이후의 내용을 프롬프트로 사용
        let promptStartIndex = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '' && i > 0) {
                promptStartIndex = i + 1;
                break;
            }
        }

        prompt = lines.slice(promptStartIndex).join('\n').trim();

        return { title, description, prompt };
    }
}

// 프롬프트 매니저 인스턴스 생성
const promptManager = new PromptManager();

// Create the AWS Bedrock client
const bedrockClient = new NovaSonicBidirectionalStreamClient({
    requestHandlerConfig: {
        maxConcurrentStreams: 10,
    },
    clientConfig: {
        region: process.env.AWS_REGION || "us-east-1",
        credentials: fromIni({ profile: AWS_PROFILE_NAME })
    }
});

// Periodically check for and close inactive sessions (every minute)
// Sessions with no activity for over 5 minutes will be force closed
setInterval(() => {
    console.log("Session cleanup check");
    const now = Date.now();

    // Check all active sessions
    bedrockClient.getActiveSessions().forEach(sessionId => {
        const lastActivity = bedrockClient.getLastActivityTime(sessionId);

        // If no activity for 5 minutes, force close
        if (now - lastActivity > 5 * 60 * 1000) {
            console.log(`Closing inactive session ${sessionId} after 5 minutes of inactivity`);
            try {
                bedrockClient.forceCloseSession(sessionId);
            } catch (error) {
                console.error(`Error force closing inactive session ${sessionId}:`, error);
            }
        }
    });
}, 60000);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// 프롬프트 API 엔드포인트 - any 타입으로 우회
app.get('/api/prompts', (req: any, res: any) => {
    try {
        const promptList = promptManager.getPromptList();
        console.log('Available prompts:', promptList);
        res.json(promptList);
    } catch (error) {
        console.error('Error getting prompt list:', error);
        res.status(500).json({ error: 'Failed to get prompt list' });
    }
});

app.get('/api/prompts/:name', (req: any, res: any) => {
    try {
        const promptName = req.params.name;
        const content = promptManager.getPromptContent(promptName);
        
        if (!content) {
            return res.status(404).json({ error: 'Prompt not found' });
        }

        const metadata = promptManager.parsePromptMetadata(content);
        
        // 프롬프트 이름을 응답에 포함
        const response = {
            ...metadata,
            promptName: promptName  // 프롬프트 이름 추가
        };
        
        console.log(`Prompt ${promptName}:`, metadata);
        res.json(response);
    } catch (error) {
        console.error('Error getting prompt content:', error);
        res.status(500).json({ error: 'Failed to get prompt content' });
    }
});

// Health check endpoint
app.get('/health', (req: any, res: any) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Create a unique session ID for this client
    const sessionId = socket.id;

    try {
        // Create session with the new API
        const session = bedrockClient.createStreamSession(sessionId);
        // bedrockClient.initiateSession(sessionId)  // ❌ 이 줄 제거

        setInterval(() => {
            const connectionCount = Object.keys(io.sockets.sockets).length;
            console.log(`Active socket connections: ${connectionCount}`);
        }, 60000);

        // Set up event handlers
        session.onEvent('contentStart', (data) => {
            console.log('contentStart:', data);
            socket.emit('contentStart', data);
        });

        session.onEvent('textOutput', (data) => {
            console.log('Text output:', data);
            socket.emit('textOutput', data);
        });

        session.onEvent('audioOutput', (data) => {
            console.log('Audio output received, sending to client');
            socket.emit('audioOutput', data);
        });

        session.onEvent('error', (data) => {
            console.error('Error in session:', data);
            socket.emit('error', data);
        });

        session.onEvent('toolUse', (data) => {
            console.log('Tool use detected:', data.toolName);
            socket.emit('toolUse', data);
        });

        session.onEvent('toolResult', (data) => {
            console.log('Tool result received');
            socket.emit('toolResult', data);
        });

        session.onEvent('contentEnd', (data) => {
            console.log('Content end received: ', data);
            socket.emit('contentEnd', data);
        });

        session.onEvent('streamComplete', () => {
            console.log('Stream completed for client:', socket.id);
            socket.emit('streamComplete');
        });

        // Simplified audioInput handler without rate limiting
        socket.on('audioInput', async (audioData) => {
            try {
                console.log('🎤 Audio input received from client:', socket.id); // ✅ 로그 추가
                console.log('📊 Audio data length:', typeof audioData === 'string' ? audioData.length : audioData.byteLength); // ✅ 로그 추가
                
                // Convert base64 string to Buffer
                const audioBuffer = typeof audioData === 'string'
                    ? Buffer.from(audioData, 'base64')
                    : Buffer.from(audioData);

                console.log(' Streaming audio to Nova Sonic...'); // ✅ 로그 추가
                // Stream the audio
                await session.streamAudio(audioBuffer);

            } catch (error) {
                console.error('❌ Error processing audio:', error);
                socket.emit('error', {
                    message: 'Error processing audio',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        socket.on('promptStart', async (data) => {  // ✅ data 매개변수 추가
            try {
                console.log('Prompt start received', data);
                
                // promptName을 세션에 설정
                if (data && data.promptName) {
                    bedrockClient.setPromptName(sessionId, data.promptName);
                }
                
                await session.setupPromptStart();
            } catch (error) {
                console.error('Error processing prompt start:', error);
                socket.emit('error', {
                    message: 'Error processing prompt start',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        socket.on('systemPrompt', async (data) => {
            try {
                console.log('System prompt received', data);
                
                // promptName을 세션에 설정
                if (data.promptName) {
                    bedrockClient.setPromptName(sessionId, data.promptName);
                }
                
                // prompt 문자열만 전달
                await session.setupSystemPrompt(undefined, data.prompt);
            } catch (error) {
                console.error('Error processing system prompt:', error);
                socket.emit('error', {
                    message: 'Error processing system prompt',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        socket.on('audioStart', async (data) => {
            try {
                console.log('Audio start received', data);
                await session.setupStartAudio();
            } catch (error) {
                console.error('Error processing audio start:', error);
                socket.emit('error', {
                    message: 'Error processing audio start',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        socket.on('stopAudio', async () => {
            try {
                console.log('Stop audio requested, beginning proper shutdown sequence');

                // Chain the closing sequence
                await Promise.all([
                    session.endAudioContent()
                        .then(() => session.endPrompt())
                        .then(() => session.close())
                        .then(() => console.log('Session cleanup complete'))
                ]);
            } catch (error) {
                console.error('Error processing streaming end events:', error);
                socket.emit('error', {
                    message: 'Error processing streaming end events',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        // 새로운 이벤트: 세션 시작
        socket.on('startSession', async () => {
            try {
                console.log('Starting session for:', sessionId);
                await bedrockClient.initiateSession(sessionId);
            } catch (error) {
                console.error('Error starting session:', error);
                socket.emit('error', {
                    message: 'Error starting session',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        // Handle disconnection
        socket.on('disconnect', async () => {
            console.log('Client disconnected abruptly:', socket.id);

            if (bedrockClient.isSessionActive(sessionId)) {
                try {
                    console.log(`Beginning cleanup for abruptly disconnected session: ${socket.id}`);

                    // Add explicit timeouts to avoid hanging promises
                    const cleanupPromise = Promise.race([
                        (async () => {
                            await session.endAudioContent();
                            await session.endPrompt();
                            await session.close();
                        })(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Session cleanup timeout')), 3000)
                        )
                    ]);

                    await cleanupPromise;
                    console.log(`Successfully cleaned up session after abrupt disconnect: ${socket.id}`);
                } catch (error) {
                    console.error(`Error cleaning up session after disconnect: ${socket.id}`, error);
                    try {
                        bedrockClient.forceCloseSession(sessionId);
                        console.log(`Force closed session: ${sessionId}`);
                    } catch (e) {
                        console.error(`Failed even force close for session: ${sessionId}`, e);
                    }
                } finally {
                    // Make sure socket is fully closed in all cases
                    if (socket.connected) {
                        socket.disconnect(true);
                    }
                }
            }
        });

    } catch (error) {
        console.error('Error creating session:', error);
        socket.emit('error', {
            message: 'Failed to initialize session',
            details: error instanceof Error ? error.message : String(error)
        });
        socket.disconnect();
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to access the application`);
    console.log(`API endpoints:`);
    console.log(`  GET /api/prompts - Get list of available prompts`);
    console.log(`  GET /api/prompts/:name - Get specific prompt content`);
    console.log(`  GET /health - Health check`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    const forceExitTimer = setTimeout(() => {
        console.error('Forcing server shutdown after timeout');
        process.exit(1);
    }, 5000);

    try {
        // First close Socket.IO server which manages WebSocket connections
        await new Promise(resolve => io.close(resolve));
        console.log('Socket.IO server closed');

        // Then close all active sessions
        const activeSessions = bedrockClient.getActiveSessions();
        console.log(`Closing ${activeSessions.length} active sessions...`);

        await Promise.all(activeSessions.map(async (sessionId) => {
            try {
                await bedrockClient.closeSession(sessionId);
                console.log(`Closed session ${sessionId} during shutdown`);
            } catch (error) {
                console.error(`Error closing session ${sessionId} during shutdown:`, error);
                bedrockClient.forceCloseSession(sessionId);
            }
        }));

        // Now close the HTTP server with a promise
        await new Promise(resolve => server.close(resolve));
        clearTimeout(forceExitTimer);
        console.log('Server shut down');
        process.exit(0);
    } catch (error) {
        console.error('Error during server shutdown:', error);
        process.exit(1);
    }
});
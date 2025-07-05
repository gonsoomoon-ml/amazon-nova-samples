import { AudioPlayer } from './lib/play/AudioPlayer.js';
import { ChatHistoryManager } from "./lib/util/ChatHistoryManager.js";

// Connect to the server
const socket = io();

// DOM elements
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusElement = document.getElementById('status');
const chatContainer = document.getElementById('chat-container');
const promptSelect = document.getElementById('prompt-select');

// Chat history management
let chat = { history: [] };
const chatRef = { current: chat };
const chatHistoryManager = ChatHistoryManager.getInstance(
    chatRef,
    (newChat) => {
        chat = { ...newChat };
        chatRef.current = chat;
        updateChatUI();
    }
);

// Audio processing variables
let audioContext;
let audioStream;
let isStreaming = false;
let processor;
let sourceNode;
let waitingForAssistantResponse = false;
let waitingForUserTranscription = false;
let userThinkingIndicator = null;
let assistantThinkingIndicator = null;
let transcriptionReceived = false;
let displayAssistantText = false;
let role;
const audioPlayer = new AudioPlayer();
let sessionInitialized = false;

let samplingRatio = 1;
const TARGET_SAMPLE_RATE = 16000; 
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

// 프롬프트 정의
const PROMPTS = {
    friend: {
        name: "Friendly Chat",
        content: "You are a friend. The user and you will engage in a spoken " +
            "dialog exchanging the transcripts of a natural real-time conversation. Keep your responses short, " +
            "generally two or three sentences for chatty scenarios."
    },
    english_tutor: {
        name: "English Conversation Tutor",
        content: "You are a friendly English conversation tutor. Help the user improve their English speaking skills through natural conversation. " +
            "Gently correct pronunciation and grammar when needed. Keep responses encouraging and educational. " +
            "Use clear, well-paced speech and provide helpful feedback. " +
            "Ask follow-up questions to encourage more speaking practice."
    },
    customer_service: {
        name: "Customer Service Agent",
        content: "You are a professional customer service representative. Be helpful, patient, and solution-oriented. " +
            "Listen carefully to customer concerns and provide clear, helpful solutions. " +
            "Always be polite and professional in your responses. " +
            "Ask clarifying questions when needed to better understand the customer's issue."
    },
    travel_guide: {
        name: "Travel Guide",
        content: "You are an experienced travel guide with knowledge of destinations worldwide. " +
            "Help travelers plan trips, find attractions, and navigate new places. " +
            "Share cultural insights and local tips. Be enthusiastic about travel and destinations. " +
            "Provide practical advice about transportation, accommodation, and local customs."
    },
    cooking_assistant: {
        name: "Cooking Assistant",
        content: "You are a helpful cooking assistant. Help users with recipes, cooking techniques, and kitchen tips. " +
            "Provide step-by-step instructions and cooking advice. " +
            "Be encouraging and make cooking fun and accessible. " +
            "Ask about dietary preferences and cooking experience level."
    },
    fitness_coach: {
        name: "Fitness Coach",
        content: "You are an encouraging fitness coach. Help users with exercise routines, workout plans, and fitness motivation. " +
            "Provide safe and effective exercise guidance. " +
            "Be supportive and adapt to different fitness levels. " +
            "Ask about fitness goals and current activity level."
    }
};

// 현재 선택된 프롬프트
let currentPrompt = 'friend';
let SYSTEM_PROMPT = PROMPTS[currentPrompt].content;

// 프롬프트 변경 이벤트 리스너
if (promptSelect) {
    promptSelect.addEventListener('change', async (event) => {
        const newPrompt = event.target.value;
        if (newPrompt !== currentPrompt) {
            await changePrompt(newPrompt);
        }
    });
}

// 프롬프트 변경 함수
async function changePrompt(newPrompt) {
    try {
        // UI 피드백
        if (promptSelect) {
            promptSelect.classList.add('changing');
        }
        
        // 프롬프트 변경
        currentPrompt = newPrompt;
        SYSTEM_PROMPT = PROMPTS[currentPrompt].content;
        
        // 세션이 이미 초기화된 경우 프롬프트 업데이트
        if (sessionInitialized) {
            socket.emit('systemPrompt', SYSTEM_PROMPT);
            statusElement.textContent = `Switched to ${PROMPTS[currentPrompt].name}`;
            statusElement.className = "ready";
            
            // 3초 후 상태 메시지 제거
            setTimeout(() => {
                if (statusElement.textContent.includes('Switched to')) {
                    statusElement.textContent = "Ready to start streaming";
                }
            }, 3000);
        }
        
        console.log(`Changed prompt to: ${PROMPTS[currentPrompt].name}`);
        
        // 애니메이션 제거
        setTimeout(() => {
            if (promptSelect) {
                promptSelect.classList.remove('changing');
            }
        }, 500);
        
    } catch (error) {
        console.error('Error changing prompt:', error);
        statusElement.textContent = "Error changing prompt";
        statusElement.className = "error";
    }
}

// Initialize WebSocket audio
async function initAudio() {
    try {
        statusElement.textContent = "Requesting microphone access...";
        statusElement.className = "connecting";

        // Request microphone access
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        if (isFirefox) {
            //firefox doesn't allow audio context have differnt sample rate than what the user media device offers
            audioContext = new AudioContext();
        } else {
            audioContext = new AudioContext({
                sampleRate: TARGET_SAMPLE_RATE
            });
        }

        //samplingRatio - is only relevant for firefox, for Chromium based browsers, it's always 1
        samplingRatio = audioContext.sampleRate / TARGET_SAMPLE_RATE;
        console.log(`Debug AudioContext- sampleRate: ${audioContext.sampleRate} samplingRatio: ${samplingRatio}`)
        

        await audioPlayer.start();

        statusElement.textContent = "Microphone ready. Click Start to begin.";
        statusElement.className = "ready";
        startButton.disabled = false;
    } catch (error) {
        console.error("Error accessing microphone:", error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

// Initialize the session with Bedrock
async function initializeSession() {
    if (sessionInitialized) return;

    statusElement.textContent = "Initializing session...";

    try {
        // Send events in sequence
        socket.emit('promptStart');
        socket.emit('systemPrompt', SYSTEM_PROMPT);
        socket.emit('audioStart');

        // Mark session as initialized
        sessionInitialized = true;
        statusElement.textContent = "Session initialized successfully";
    } catch (error) {
        console.error("Failed to initialize session:", error);
        statusElement.textContent = "Error initializing session";
        statusElement.className = "error";
    }
}

async function startStreaming() {
    if (isStreaming) return;

    try {
        // First, make sure the session is initialized
        if (!sessionInitialized) {
            await initializeSession();
        }

        // Create audio processor
        sourceNode = audioContext.createMediaStreamSource(audioStream);

        // Use ScriptProcessorNode for audio processing
        if (audioContext.createScriptProcessor) {
            processor = audioContext.createScriptProcessor(512, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!isStreaming) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const numSamples = Math.round(inputData.length / samplingRatio)
                const pcmData = isFirefox ? (new Int16Array(numSamples)) : (new Int16Array(inputData.length));
                
                // Convert to 16-bit PCM
                if (isFirefox) {                    
                    for (let i = 0; i < inputData.length; i++) {
                        //NOTE: for firefox the samplingRatio is not 1, 
                        // so it will downsample by skipping some input samples
                        // A better approach is to compute the mean of the samplingRatio samples.
                        // or pass through a low-pass filter first 
                        // But skipping is a preferable low-latency operation
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i * samplingRatio])) * 0x7FFF;
                    }
                } else {
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                    }
                }
                

                // Convert to base64 (browser-safe way)
                const base64Data = arrayBufferToBase64(pcmData.buffer);

                // Send to server
                socket.emit('audioInput', base64Data);
            };

            sourceNode.connect(processor);
            processor.connect(audioContext.destination);
        }

        isStreaming = true;
        startButton.disabled = true;
        stopButton.disabled = false;
        statusElement.textContent = "Streaming... Speak now";
        statusElement.className = "recording";

        // Show user thinking indicator when starting to record
        transcriptionReceived = false;
        showUserThinkingIndicator();

    } catch (error) {
        console.error("Error starting recording:", error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

// Convert ArrayBuffer to base64 string
function arrayBufferToBase64(buffer) {
    const binary = [];
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary.push(String.fromCharCode(bytes[i]));
    }
    return btoa(binary.join(''));
}

function stopStreaming() {
    if (!isStreaming) return;

    isStreaming = false;

    // Clean up audio processing
    if (processor) {
        processor.disconnect();
        sourceNode.disconnect();
    }

    startButton.disabled = false;
    stopButton.disabled = true;
    statusElement.textContent = "Processing...";
    statusElement.className = "processing";

    audioPlayer.stop();
    // Tell server to finalize processing
    socket.emit('stopAudio');

    // End the current turn in chat history
    chatHistoryManager.endTurn();
}

// Base64 to Float32Array conversion
function base64ToFloat32Array(base64String) {
    try {
        const binaryString = window.atob(base64String);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        return float32Array;
    } catch (error) {
        console.error('Error in base64ToFloat32Array:', error);
        throw error;
    }
}

// Process message data and add to chat history
function handleTextOutput(data) {
    console.log("Processing text output:", data);
    if (data.content) {
        const messageData = {
            role: data.role,
            message: data.content
        };
        chatHistoryManager.addTextMessage(messageData);
    }
}

// Update the UI based on the current chat history
function updateChatUI() {
    if (!chatContainer) {
        console.error("Chat container not found");
        return;
    }

    // Clear existing chat messages
    chatContainer.innerHTML = '';

    // Add all messages from history
    chat.history.forEach(item => {
        if (item.endOfConversation) {
            const endDiv = document.createElement('div');
            endDiv.className = 'message system';
            endDiv.textContent = "Conversation ended";
            chatContainer.appendChild(endDiv);
            return;
        }

        if (item.role) {
            const messageDiv = document.createElement('div');
            const roleLowerCase = item.role.toLowerCase();
            messageDiv.className = `message ${roleLowerCase}`;

            const roleLabel = document.createElement('div');
            roleLabel.className = 'role-label';
            roleLabel.textContent = item.role;
            messageDiv.appendChild(roleLabel);

            const content = document.createElement('div');
            content.textContent = item.message || "No content";
            messageDiv.appendChild(content);

            chatContainer.appendChild(messageDiv);
        }
    });

    // Re-add thinking indicators if we're still waiting
    if (waitingForUserTranscription) {
        showUserThinkingIndicator();
    }
    if (waitingForAssistantResponse) {
        showAssistantThinkingIndicator();
    }

    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showUserThinkingIndicator() {
    if (userThinkingIndicator) return;
    
    userThinkingIndicator = document.createElement('div');
    userThinkingIndicator.className = 'thinking-indicator user-thinking';
    userThinkingIndicator.innerHTML = `
        <div class="thinking-dots">
            <span></span>
            <span></span>
            <span></span>
        </div>
        <div class="thinking-text">Listening...</div>
    `;
    
    chatContainer.appendChild(userThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showAssistantThinkingIndicator() {
    if (assistantThinkingIndicator) return;
    
    assistantThinkingIndicator = document.createElement('div');
    assistantThinkingIndicator.className = 'thinking-indicator assistant-thinking';
    assistantThinkingIndicator.innerHTML = `
        <div class="thinking-dots">
            <span></span>
            <span></span>
            <span></span>
        </div>
        <div class="thinking-text">Assistant is thinking...</div>
    `;
    
    chatContainer.appendChild(assistantThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function hideUserThinkingIndicator() {
    if (userThinkingIndicator) {
        userThinkingIndicator.remove();
        userThinkingIndicator = null;
    }
}

function hideAssistantThinkingIndicator() {
    if (assistantThinkingIndicator) {
        assistantThinkingIndicator.remove();
        assistantThinkingIndicator = null;
    }
}

// Socket event handlers
socket.on('connect', () => {
    console.log('Connected to server');
    statusElement.textContent = 'Connected to server';
    statusElement.className = 'connected';
    initAudio();
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    statusElement.textContent = 'Disconnected from server';
    statusElement.className = 'disconnected';
    startButton.disabled = true;
    stopButton.disabled = true;
});

socket.on('contentStart', (data) => {
    console.log('Content start:', data);
    if (data.role === 'ASSISTANT') {
        showAssistantThinkingIndicator();
    }
});

socket.on('textOutput', (data) => {
    console.log('Text output received:', data);
    hideAssistantThinkingIndicator();
    handleTextOutput(data);
});

socket.on('audioOutput', (data) => {
    console.log('Audio output received');
    audioPlayer.playAudio(data.content);
});

socket.on('error', (data) => {
    console.error('Server error:', data);
    statusElement.textContent = 'Error: ' + data.message;
    statusElement.className = 'error';
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

socket.on('toolUse', (data) => {
    console.log('Tool use:', data);
});

socket.on('toolResult', (data) => {
    console.log('Tool result:', data);
});

socket.on('contentEnd', (data) => {
    console.log('Content end:', data);
    if (data.role === 'ASSISTANT') {
        hideAssistantThinkingIndicator();
    }
});

socket.on('streamComplete', () => {
    console.log('Stream completed');
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

// Button event handlers
startButton.addEventListener('click', startStreaming);
stopButton.addEventListener('click', stopStreaming);

// Initialize audio when page loads
initAudio(); 
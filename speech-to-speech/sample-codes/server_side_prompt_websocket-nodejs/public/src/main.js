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
const currentPromptInfo = document.getElementById('current-prompt-info');

// Chat history management
let chat = { history: [] };
const chatRef = { current: chat };
// ChatHistoryManager 콜백 수정
const chatHistoryManager = ChatHistoryManager.getInstance(
    chatRef,
    (newChat) => {
        chat = { ...newChat };
        chatRef.current = chat;
        // updateChatUI() 호출 제거
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

// Debug function to check audio context state
window.debugAudioContext = function() {
    if (audioContext) {
        console.log('AudioContext state:', audioContext.state);
        console.log('AudioContext sample rate:', audioContext.sampleRate);
        console.log('Is streaming:', isStreaming);
        console.log('Audio stream active:', audioStream && audioStream.active);
        return {
            state: audioContext.state,
            sampleRate: audioContext.sampleRate,
            isStreaming: isStreaming,
            streamActive: audioStream && audioStream.active
        };
    } else {
        console.log('AudioContext not initialized yet');
        return null;
    }
};

let samplingRatio = 1;
const TARGET_SAMPLE_RATE = 16000; 
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

// 프롬프트 데이터를 서버에서 로드
let PROMPTS = {};  // 여기에 PROMPTS 변수 선언 추가
let currentPrompt = localStorage.getItem('selectedPrompt') || 'friend';
let SYSTEM_PROMPT = '';

// 서버에서 프롬프트 목록과 데이터를 로드하는 함수
async function loadPromptsFromServer() {
    try {
        // 1. 프롬프트 목록 가져오기
        const response = await fetch('/api/prompts');
        const promptList = await response.json();
        console.log('Prompt list from server:', promptList);
        
        // 2. 각 프롬프트의 상세 정보 가져오기
        const promptsData = {};
        for (const promptName of promptList) {
            const promptResponse = await fetch(`/api/prompts/${promptName}`);
            const promptData = await promptResponse.json();
            promptsData[promptName] = promptData;
        }
        
        PROMPTS = promptsData;
        
        // 3. 드롭다운 옵션 업데이트
        updatePromptDropdown(promptList);
        
        // 4. 현재 프롬프트 설정
        if (PROMPTS[currentPrompt]) {
            SYSTEM_PROMPT = PROMPTS[currentPrompt].prompt;
        } else {
            // 기본값으로 첫 번째 프롬프트 사용
            const firstPrompt = Object.keys(PROMPTS)[0];
            currentPrompt = firstPrompt;
            SYSTEM_PROMPT = PROMPTS[firstPrompt].prompt;
            localStorage.setItem('selectedPrompt', currentPrompt);
        }
        
        // 5. UI 업데이트
        updateCurrentPromptInfo();
        promptSelect.value = currentPrompt;
        
        console.log('Loaded prompts:', Object.keys(PROMPTS));
        
    } catch (error) {
        console.error('Error loading prompts from server:', error);
        // 폴백: 기본 프롬프트 사용
        PROMPTS = {
            friend: {
                title: "Friend",
                description: "일반적인 친구와 같은 대화를 하는 프롬프트",
                prompt: "You are a friendly friend. The user and you will engage in a natural, casual conversation like close friends. Be warm, supportive, and genuinely interested in the user's thoughts and feelings. Share your own thoughts and experiences naturally. Keep responses conversational and engaging, as if you're talking to a good friend.",
                promptName: "friend"
            }
        };
        SYSTEM_PROMPT = PROMPTS.friend.prompt;
        updateCurrentPromptInfo();
    }
}

// 드롭다운 옵션 업데이트 함수
function updatePromptDropdown(promptList) {
    // 기존 옵션 제거
    promptSelect.innerHTML = '';
    
    // 새 옵션 추가
    promptList.forEach(promptName => {
        const option = document.createElement('option');
        option.value = promptName;
        
        // 더 나은 표시 이름 생성
        let displayName = promptName;
        
        if (PROMPTS[promptName]) {
            // title이 있고 의미있는 값이면 사용
            if (PROMPTS[promptName].title && PROMPTS[promptName].title !== 'Identity') {
                displayName = PROMPTS[promptName].title;
            } else {
                // title이 없거나 의미없으면 프롬프트 이름을 기반으로 표시 이름 생성
                displayName = promptName.split('_').map(word => 
                    word.charAt(0).toUpperCase() + word.slice(1)
                ).join(' ');
            }
        }
        
        option.textContent = displayName;
        promptSelect.appendChild(option);
    });
    
    console.log('Dropdown updated with', promptList.length, 'prompts');
}

// 현재 프롬프트 정보 업데이트 함수
function updateCurrentPromptInfo() {
    if (!PROMPTS[currentPrompt]) return;
    
    const promptData = PROMPTS[currentPrompt];
    const titleElement = currentPromptInfo.querySelector('.prompt-title');
    const descriptionElement = currentPromptInfo.querySelector('.prompt-description');
    
    titleElement.textContent = promptData.title;
    descriptionElement.textContent = promptData.prompt; // description 대신 prompt 표시
    
    // 애니메이션 효과
    currentPromptInfo.classList.add('changing');
    setTimeout(() => {
        currentPromptInfo.classList.remove('changing');
    }, 500);
}

// 프롬프트 변경 이벤트 리스너 (리프레시 방식)
promptSelect.addEventListener('change', async (event) => {
    const newPrompt = event.target.value;
    
    if (newPrompt !== currentPrompt) {
        // 프롬프트 변경
        currentPrompt = newPrompt;
        SYSTEM_PROMPT = PROMPTS[currentPrompt].prompt;
        
        // localStorage에 저장
        localStorage.setItem('selectedPrompt', currentPrompt);
        
        // UI 업데이트
        updateCurrentPromptInfo();
        
        // 스트리밍 중이면 먼저 중지
        if (isStreaming) {
            stopStreaming();
        }
        
        // 상태 메시지 표시
        statusElement.textContent = `Switched to ${PROMPTS[currentPrompt].title}. Refreshing...`;
        statusElement.className = "connecting";
        
        // 1초 후 페이지 리프레시
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        
        console.log(`Changed prompt to: ${PROMPTS[currentPrompt].title}, refreshing page...`);
    }
});

// 페이지 로드 시 프롬프트 로드
loadPromptsFromServer();

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

// Initialize the session with Bedrock (프롬프트 이름과 함께 전달)
async function initializeSession() {
    if (sessionInitialized) return;

    statusElement.textContent = "Initializing session...";

    try {
        // 1. 세션 시작
        socket.emit('startSession');
        
        // 2. 프롬프트 설정
        socket.emit('promptStart', {
            promptName: currentPrompt
        });
        socket.emit('systemPrompt', {
            prompt: SYSTEM_PROMPT,
            promptName: currentPrompt
        });
        socket.emit('audioStart');

        // Mark session as initialized
        sessionInitialized = true;
        statusElement.textContent = "Session initialized successfully";
        console.log('Session initialized with prompt:', currentPrompt);
    } catch (error) {
        console.error("Failed to initialize session:", error);
        statusElement.textContent = "Error initializing session";
        statusElement.className = "error";
    }
}

async function startStreaming() {
    if (isStreaming) return;

    try {
        // 같은 프롬프트로 재시작하는 경우 세션만 재설정
        if (sessionInitialized) {
            console.log("Resetting session for same prompt...");
            
            // 스트리밍 중이면 먼저 중지
            if (isStreaming) {
                stopStreaming();
            }
            
            // 세션 재설정
            sessionInitialized = false;
            await initializeSession();
        }

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

    // Stop the stream
    socket.emit('stopAudio');

    // Stop any currently playing audio
    if (audioPlayer) {
        audioPlayer.stopAudio();
    }

    // Reset UI
    startButton.disabled = false;
    stopButton.disabled = true;
    statusElement.textContent = "Ready";
    statusElement.className = "ready";

    // Hide thinking indicators
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
}

// Convert base64 string to Float32Array for audio playback
function base64ToFloat32Array(base64String) {
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 0x7FFF;
    }
    
    return float32Array;
}

// 새로운 메시지만 추가하는 함수
function addMessageToUI(role, content) {
    const messageElement = document.createElement('div');
    messageElement.className = `message ${role.toLowerCase()}`;
    
    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = role;
    messageElement.appendChild(roleLabel);
    
    const contentElement = document.createElement('div');
    contentElement.className = 'content';
    contentElement.textContent = content;
    messageElement.appendChild(contentElement);
    
    chatContainer.appendChild(messageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// handleTextOutput 함수 수정
function handleTextOutput(data) {
    // ChatHistoryManager 호출 제거
    // chatHistoryManager.addTextMessage({
    //     role: data.role,
    //     message: data.content
    // });
    
    // 직접 UI에만 추가
    addMessageToUI(data.role, data.content);
}

// updateChatUI 함수를 다시 활성화
function updateChatUI() {
    chatContainer.innerHTML = '';
    
    chat.history.forEach(message => {
        const messageElement = document.createElement('div');
        messageElement.className = `message ${message.role.toLowerCase()}`;
        
        const roleLabel = document.createElement('div');
        roleLabel.className = 'role-label';
        roleLabel.textContent = message.role;
        messageElement.appendChild(roleLabel);
        
        const contentElement = document.createElement('div');
        contentElement.className = 'content';
        contentElement.textContent = message.message; // message 속성 사용
        messageElement.appendChild(contentElement);
        
        chatContainer.appendChild(messageElement);
    });
    
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Show user thinking indicator
function showUserThinkingIndicator() {
    if (waitingForUserTranscription) return;
    
    waitingForUserTranscription = true;
    userThinkingIndicator = document.createElement('div');
    userThinkingIndicator.className = 'message user thinking';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = 'USER';
    userThinkingIndicator.appendChild(roleLabel);

    const thinkingText = document.createElement('div');
    thinkingText.className = 'thinking-text';
    thinkingText.textContent = 'Listening...';
    userThinkingIndicator.appendChild(thinkingText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }

    userThinkingIndicator.appendChild(dotContainer);
    chatContainer.appendChild(userThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Show assistant thinking indicator
function showAssistantThinkingIndicator() {
    if (waitingForAssistantResponse) return;
    
    waitingForAssistantResponse = true;
    assistantThinkingIndicator = document.createElement('div');
    assistantThinkingIndicator.className = 'message assistant thinking';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = 'ASSISTANT';
    assistantThinkingIndicator.appendChild(roleLabel);

    const thinkingText = document.createElement('div');
    thinkingText.className = 'thinking-text';
    thinkingText.textContent = 'Thinking';
    assistantThinkingIndicator.appendChild(thinkingText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }

    assistantThinkingIndicator.appendChild(dotContainer);
    chatContainer.appendChild(assistantThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Hide the user thinking indicator
function hideUserThinkingIndicator() {
    waitingForUserTranscription = false;
    if (userThinkingIndicator && userThinkingIndicator.parentNode) {
        userThinkingIndicator.parentNode.removeChild(userThinkingIndicator);
    }
    userThinkingIndicator = null;
}

// Hide the assistant thinking indicator
function hideAssistantThinkingIndicator() {
    waitingForAssistantResponse = false;
    if (assistantThinkingIndicator && assistantThinkingIndicator.parentNode) {
        assistantThinkingIndicator.parentNode.removeChild(assistantThinkingIndicator);
    }
    assistantThinkingIndicator = null;
}

// EVENT HANDLERS
// --------------

// Handle content start from the server
socket.on('contentStart', (data) => {
    console.log('Content start received:', data);

    if (data.type === 'TEXT') {
        role = data.role;
        if (data.role === 'USER') {
            hideUserThinkingIndicator();
        }
        else if (data.role === 'ASSISTANT') {
            hideAssistantThinkingIndicator();
            
            // generationStage 확인 - SPECULATIVE만 표시
            let isSpeculative = false;
            try {
                if (data.additionalModelFields) {
                    const additionalFields = JSON.parse(data.additionalModelFields);
                    isSpeculative = additionalFields.generationStage === "SPECULATIVE";
                    if (isSpeculative) {
                        console.log("Received SPECULATIVE content - will display");
                        displayAssistantText = true;
                    }
                    else {
                        console.log("Received FINAL content - will NOT display");
                        displayAssistantText = false;
                    }
                }
            } catch (e) {
                console.error("Error parsing additionalModelFields:", e);
                displayAssistantText = false; // 파싱 오류 시 표시하지 않음
            }
        }
    }
    else if (data.type === 'AUDIO') {
        if (isStreaming) {
            showUserThinkingIndicator();
        }
    }
});

// Handle text output from the server
socket.on('textOutput', (data) => {
    console.log('Received text output:', data);

    if (role === 'USER') {
        transcriptionReceived = true;
        handleTextOutput({
            role: data.role,
            content: data.content
        });
        showAssistantThinkingIndicator();
    }
    else if (role === 'ASSISTANT') {
        // SPECULATIVE 단계의 텍스트만 표시
        if (displayAssistantText) {
            handleTextOutput({
                role: data.role,
                content: data.content
            });
        }
    }
});

// Handle audio output
socket.on('audioOutput', (data) => {
    if (data.content) {
        try {
            const audioData = base64ToFloat32Array(data.content);
            audioPlayer.playAudio(audioData);
        } catch (error) {
            console.error('Error processing audio data:', error);
        }
    }
});

// Handle content end events
socket.on('contentEnd', (data) => {
    console.log('Content end received:', data);

    if (data.type === 'TEXT') {
        if (role === 'USER') {
            // When user's text content ends, make sure assistant thinking is shown
            hideUserThinkingIndicator();
            showAssistantThinkingIndicator();
        }
        else if (role === 'ASSISTANT') {
            // When assistant's text content ends, prepare for user input in next turn
            hideAssistantThinkingIndicator();
        }

        // Handle stop reasons
        if (data.stopReason && data.stopReason.toUpperCase() === 'END_TURN') {
            chatHistoryManager.endTurn();
        } else if (data.stopReason && data.stopReason.toUpperCase() === 'INTERRUPTED') {
            console.log("Interrupted by user");
            audioPlayer.bargeIn();
        }
    }
    else if (data.type === 'AUDIO') {
        // When audio content ends, we may need to show user thinking indicator
        if (isStreaming) {
            showUserThinkingIndicator();
        }
    }
});

// Stream completion event
socket.on('streamComplete', () => {
    if (isStreaming) {
        stopStreaming();
    }
    statusElement.textContent = "Ready";
    statusElement.className = "ready";
});

// Handle connection status updates
socket.on('connect', () => {
    console.log('Connected to server');
    statusElement.textContent = "Connected";
    statusElement.className = "ready";
});

// 소켓 재연결 로직 추가
socket.on('disconnect', () => {
    console.log('Disconnected from server');
    statusElement.textContent = "Disconnected. Reconnecting...";
    statusElement.className = "error";
    
    // 자동 재연결
    setTimeout(() => {
        socket.connect();
    }, 1000);
});

// Handle errors
socket.on('error', (error) => {
    console.error("Server error:", error);
    statusElement.textContent = "Error: " + (error.message || JSON.stringify(error).substring(0, 100));
    statusElement.className = "error";
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

// Button event listeners
startButton.addEventListener('click', startStreaming);
stopButton.addEventListener('click', stopStreaming);

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', initAudio);
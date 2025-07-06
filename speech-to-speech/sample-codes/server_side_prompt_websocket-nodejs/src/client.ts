import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  NodeHttp2Handler,
  NodeHttp2HandlerOptions,
} from "@smithy/node-http-handler";
import { Provider } from "@smithy/types";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { InferenceConfig } from "./types";
import { Subject } from 'rxjs';
import { take } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  DefaultTextConfiguration,
  DefaultToolSchema,
  ReservationToolSchema
} from "./consts";

export interface NovaSonicBidirectionalStreamClientConfig {
  requestHandlerConfig?:
  | NodeHttp2HandlerOptions
  | Provider<NodeHttp2HandlerOptions | void>;
  clientConfig: Partial<BedrockRuntimeClientConfig>;
  inferenceConfig?: InferenceConfig;
}

export class StreamSession {
  private audioBufferQueue: Buffer[] = [];
  private maxQueueSize = 200; // Maximum number of audio chunks to queue
  private isProcessingAudio = false;
  private isActive = true;

  constructor(
    private sessionId: string,
    private client: NovaSonicBidirectionalStreamClient
  ) { }

  // Register event handlers for this specific session
  public onEvent(eventType: string, handler: (data: any) => void): StreamSession {
    this.client.registerEventHandler(this.sessionId, eventType, handler);
    return this; // For chaining
  }

  public async setupPromptStart(): Promise<void> {
    this.client.setupPromptStartEvent(this.sessionId);
  }

  public async setupSystemPrompt(
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt): Promise<void> {
    this.client.setupSystemPromptEvent(this.sessionId, textConfig, systemPromptContent);
  }

  public async setupStartAudio(
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    this.client.setupStartAudioEvent(this.sessionId, audioConfig);
  }

  // 새로운 메서드: 오디오 큐 완전 초기화
  public resetAudioQueue(): void {
    this.audioBufferQueue = [];
    this.isProcessingAudio = false;
    console.log(`Audio queue reset for session ${this.sessionId}`);
  }

  // Stream audio for this session
  public async streamAudio(audioData: Buffer): Promise<void> {
    // 세션이 비활성화된 경우 오디오 처리 중단
    if (!this.isActive) {
      console.log("Session inactive, dropping audio chunk");
      return;
    }

    // Check queue size to avoid memory issues
    if (this.audioBufferQueue.length >= this.maxQueueSize) {
      // Queue is full, drop oldest chunk
      this.audioBufferQueue.shift();
      console.log("Audio queue full, dropping oldest chunk");
    }

    // Queue the audio chunk for streaming
    this.audioBufferQueue.push(audioData);
    this.processAudioQueue();
  }

  // Process audio queue for continuous streaming
  private async processAudioQueue() {
    if (this.isProcessingAudio || this.audioBufferQueue.length === 0 || !this.isActive) return;

    this.isProcessingAudio = true;
    try {
      // Process all chunks in the queue, up to a reasonable limit
      let processedChunks = 0;
      const maxChunksPerBatch = 5; // Process max 5 chunks at a time to avoid overload

      while (this.audioBufferQueue.length > 0 && processedChunks < maxChunksPerBatch && this.isActive) {
        const audioChunk = this.audioBufferQueue.shift();
        if (audioChunk) {
          await this.client.streamAudioChunk(this.sessionId, audioChunk);
          processedChunks++;
        }
      }
    } finally {
      this.isProcessingAudio = false;

      // If there are still items in the queue, schedule the next processing using setTimeout
      if (this.audioBufferQueue.length > 0 && this.isActive) {
        setTimeout(() => this.processAudioQueue(), 0);
      }
    }
  }
  // Get session ID
  public getSessionId(): string {
    return this.sessionId;
  }

  public async endAudioContent(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    if (!this.isActive) return;

    this.isActive = false;
    this.audioBufferQueue = []; // Clear any pending audio

    await this.client.sendSessionEnd(this.sessionId);
    console.log(`Session ${this.sessionId} close completed`);
  }
}

// Session data type
interface SessionData {
  queue: Array<any>;
  queueSignal: Subject<void>;
  closeSignal: Subject<void>;
  responseSubject: Subject<any>;
  toolUseContent: any;
  toolUseId: string;
  toolName: string;
  responseHandlers: Map<string, (data: any) => void>;
  promptName: string;
  inferenceConfig: InferenceConfig;
  isActive: boolean;
  isPromptStartSent: boolean;
  isAudioContentStartSent: boolean;
  audioContentId: string;
  hasAudioDataSent: boolean; // 실제 오디오 데이터가 전송되었는지 추적
}

export class NovaSonicBidirectionalStreamClient {
  private bedrockRuntimeClient: BedrockRuntimeClient;
  private inferenceConfig: InferenceConfig;
  private activeSessions: Map<string, SessionData> = new Map();
  private sessionLastActivity: Map<string, number> = new Map();
  private sessionCleanupInProgress = new Set<string>();

  // 오디오 큐 크기를 늘리고 드롭 로직 개선
  private audioQueue: Array<{ sessionId: string; audioData: Buffer; timestamp: number }> = [];
  private readonly MAX_QUEUE_SIZE = 100; // 50에서 100으로 증가


  constructor(config: NovaSonicBidirectionalStreamClientConfig) {
    const nodeHttp2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
      ...config.requestHandlerConfig,
    });

    if (!config.clientConfig.credentials) {
      throw new Error("No credentials provided");
    }

    this.bedrockRuntimeClient = new BedrockRuntimeClient({
      ...config.clientConfig,
      credentials: config.clientConfig.credentials,
      region: config.clientConfig.region || "us-east-1",
      requestHandler: nodeHttp2Handler
    });

    this.inferenceConfig = config.inferenceConfig ?? {
      maxTokens: 1024,
      topP: 0.9,
      temperature: 0.7,
    };
  }

  public isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  public getLastActivityTime(sessionId: string): number {
    return this.sessionLastActivity.get(sessionId) || 0;
  }

  private updateSessionActivity(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  public isCleanupInProgress(sessionId: string): boolean {
    return this.sessionCleanupInProgress.has(sessionId);
  }

  // 새로운 메서드: 세션 완전 재설정
  public async resetSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.log(`Session ${sessionId} not found for reset`);
      return;
    }

    try {
      // 기존 세션 정리
      session.isActive = false;
      session.isPromptStartSent = false;
      session.isAudioContentStartSent = false;
      session.hasAudioDataSent = false;
      
      // 세션 데이터 초기화
      session.queue = [];
      session.toolUseContent = null;
      session.toolUseId = "";
      session.toolName = "";
      session.audioContentId = randomUUID();
      
      // 기존 세션을 activeSessions에서 제거
      this.activeSessions.delete(sessionId);
      
      // 새로운 세션 생성
      const newSession = this.createStreamSession(sessionId);
      await this.initiateSession(sessionId);
      
      console.log(`Session ${sessionId} reset successfully`);
    } catch (error) {
      console.error(`Error resetting session ${sessionId}:`, error);
      throw error;
    }
  }

  // Set prompt name for a session
  public setPromptName(sessionId: string, promptName: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.promptName = promptName;
    }
  }

  // Create a new streaming session
  public createStreamSession(sessionId: string = randomUUID(), config?: NovaSonicBidirectionalStreamClientConfig): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Stream session with ID ${sessionId} already exists`);
    }

    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      responseSubject: new Subject<any>(),
      toolUseContent: null,
      toolUseId: "",
      toolName: "",
      responseHandlers: new Map(),
      promptName: randomUUID(),
      inferenceConfig: config?.inferenceConfig ?? this.inferenceConfig,
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: randomUUID(),
      hasAudioDataSent: false
    };

    this.activeSessions.set(sessionId, session);

    return new StreamSession(sessionId, this);
  }

  private async processToolUse(toolName: string, toolUseContent: object): Promise<Object> {
    console.log(`Processing tool use: ${toolName}`);
    console.log(`Tool use content:`, toolUseContent);
    
    try {
      switch (toolName) {
        case "getReservation":
          const reservationData = await this.parseToolUseContentForReservation(toolUseContent);
          console.log(`Parsed reservation data:`, reservationData);
          if (reservationData) {
            const result = await this.fetchReservationData(reservationData.name);
            console.log(`Fetch reservation result:`, result);
            return result;
          }
          break;
        case "getDateAndTimeTool":
          return {
            current_date: new Date().toISOString(),
            message: "Current date and time retrieved successfully"
          };
        default:
          console.log(`Unknown tool: ${toolName}`);
          return {
            error: `Unknown tool: ${toolName}`,
            message: "This tool is not supported"
          };
      }
    } catch (error) {
      console.error(`Error processing tool ${toolName}:`, error);
      return {
        error: error instanceof Error ? error.message : String(error),
        message: "An error occurred while processing the tool request"
      };
    }
    
    return {
      error: "Invalid tool parameters",
      message: "The tool parameters could not be parsed"
    };
  }

  private async parseToolUseContentForReservation(toolUseContent: any): Promise<{ name: string } | null> {
    try {
      console.log('parseToolUseContentForReservation input:', toolUseContent);
      console.log('parseToolUseContentForReservation type:', typeof toolUseContent);
      
      // toolUseContent가 객체이고 content 속성이 있는 경우
      if (toolUseContent && typeof toolUseContent === 'object' && toolUseContent.content) {
        console.log('Found content property:', toolUseContent.content);
        if (typeof toolUseContent.content === 'string') {
          const parsed = JSON.parse(toolUseContent.content);
          if (parsed.name && typeof parsed.name === 'string') {
            console.log('Successfully parsed name:', parsed.name);
            return { name: parsed.name };
          }
        }
      }
      
      // 기존 로직 (문자열이나 직접 객체인 경우)
      if (typeof toolUseContent === 'string') {
        const parsed = JSON.parse(toolUseContent);
        if (parsed.name && typeof parsed.name === 'string') {
          return { name: parsed.name };
        }
      } else if (toolUseContent && typeof toolUseContent.name === 'string') {
        return { name: toolUseContent.name };
      }
    } catch (error) {
      console.error('Error parsing reservation tool content:', error);
    }
    return null;
  }

  // 새로 추가: 호텔 예약 데이터 가져오기 (모의 데이터)
  private async fetchReservationData(name: string): Promise<Record<string, any>> {
    // 모의 호텔 예약 데이터
    const mockReservations = {
      "Angela Park": {
        hotel: "Seaview Hotel",
        checkInDate: "2025-04-12",
        checkOutDate: "2025-04-15",
        roomType: "Deluxe Ocean View",
        reservationId: "RES-2025-001"
      },
      "John Smith": {
        hotel: "Grand Plaza Hotel",
        checkInDate: "2025-01-15",
        checkOutDate: "2025-01-18",
        roomType: "Standard Room",
        reservationId: "RES-2025-002"
      },
      "Sarah Johnson": {
        hotel: "Mountain Lodge Resort",
        checkInDate: "2025-03-20",
        checkOutDate: "2025-03-23",
        roomType: "Suite",
        reservationId: "RES-2025-003"
      },
      "Gonsoo Moon": {
        hotel: "Seoul Grand Hotel",
        checkInDate: "2025-02-10",
        checkOutDate: "2025-02-13",
        roomType: "Executive Suite",
        reservationId: "RES-2025-004"
      },
      "YooSung Jeon": {
        hotel: "Busan Marina Resort",
        checkInDate: "2025-05-08",
        checkOutDate: "2025-05-12",
        roomType: "Ocean View Deluxe",
        reservationId: "RES-2025-005"
      },
      "Kyoung Mi Park": {
        hotel: "Jeju Island Resort",
        checkInDate: "2025-06-15",
        checkOutDate: "2025-06-20",
        roomType: "Premium Villa",
        reservationId: "RES-2025-006"
      },
      "Tom Lee": {
        hotel: "Downtown Business Hotel",
        checkInDate: "2025-03-05",
        checkOutDate: "2025-03-08",
        roomType: "Business Suite",
        reservationId: "RES-2025-007"
      }
    };

    // 대소문자 구분 없이 검색
    const normalizedName = name.toLowerCase().trim();
    const reservation = Object.entries(mockReservations).find(([key]) => 
      key.toLowerCase() === normalizedName
    );
    
    if (reservation) {
      console.log("Reservation found:", reservation[1]);
      // Nova Sonic이 기대하는 형식으로 반환
      return {
        success: true,
        reservation: reservation[1],
        message: `Reservation found for ${reservation[0]}`
      };
    } else {
      console.log("No reservation found for:", name);
      return {
        success: false,
        reservation: null,
        message: `No reservation found for ${name}`
      };
    }
  }

  // Stream audio for a specific session
  public async initiateSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session ${sessionId} not found`);
    }

    try {
      // Set up initial events for this session
      this.setupSessionStartEvent(sessionId);

      // Create the bidirectional stream with session-specific async iterator
      const asyncIterable = this.createSessionAsyncIterable(sessionId);

      console.log(`Starting bidirectional stream for session ${sessionId}...`);

      const response = await this.bedrockRuntimeClient.send(
        new InvokeModelWithBidirectionalStreamCommand({
          modelId: "amazon.nova-sonic-v1:0",
          body: asyncIterable,
        })
      );

      console.log(`Stream established for session ${sessionId}, processing responses...`);

      // Process responses for this session
      await this.processResponseStream(sessionId, response);

    } catch (error) {
      console.error(`Error in session ${sessionId}: `, error);
      this.dispatchEventForSession(sessionId, 'error', {
        source: 'bidirectionalStream',
        error
      });

      // Make sure to clean up if there's an error
      if (session.isActive) {
        this.closeSession(sessionId);
      }
    }
  }

  // Dispatch events to handlers for a specific session
  private dispatchEventForSession(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(`Error in ${eventType} handler for session ${sessionId}: `, e);
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get('any');
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}: `, e);
      }
    }
  }

  private createSessionAsyncIterable(sessionId: string): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {

    if (!this.isSessionActive(sessionId)) {
      console.log(`Cannot create async iterable: Session ${sessionId} not active`);
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true })
        })
      };
    }

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Cannot create async iterable: Session ${sessionId} not found`);
    }

    let eventCount = 0;

    return {
      [Symbol.asyncIterator]: () => {
        console.log(`AsyncIterable iterator requested for session ${sessionId}`);

        return {
          next: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            try {
              // Check if session is still active
              if (!session.isActive || !this.activeSessions.has(sessionId)) {
                console.log(`Iterator closing for session ${sessionId}, done = true`);
                return { value: undefined, done: true };
              }
              // Wait for items in the queue or close signal
              if (session.queue.length === 0) {
                try {
                  await Promise.race([
                    firstValueFrom(session.queueSignal.pipe(take(1))),
                    firstValueFrom(session.closeSignal.pipe(take(1))).then(() => {
                      throw new Error("Stream closed");
                    })
                  ]);
                } catch (error) {
                  if (error instanceof Error) {
                    if (error.message === "Stream closed" || !session.isActive) {
                      // This is an expected condition when closing the session
                      if (this.activeSessions.has(sessionId)) {
                        console.log(`Session \${ sessionId } closed during wait`);
                      }
                      return { value: undefined, done: true };
                    }
                  }
                  else {
                    console.error(`Error on event close`, error)
                  }
                }
              }

              // If queue is still empty or session is inactive, we're done
              if (session.queue.length === 0 || !session.isActive) {
                console.log(`Queue empty or session inactive: ${sessionId} `);
                return { value: undefined, done: true };
              }

              // Get next item from the session's queue
              const nextEvent = session.queue.shift();
              eventCount++;

              //console.log(`Sending event #${ eventCount } for session ${ sessionId }: ${ JSON.stringify(nextEvent).substring(0, 100) }...`);

              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(nextEvent))
                  }
                },
                done: false
              };
            } catch (error) {
              console.error(`Error in session ${sessionId} iterator: `, error);
              session.isActive = false;
              return { value: undefined, done: true };
            }
          },

          return: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            console.log(`Iterator return () called for session ${sessionId}`);
            session.isActive = false;
            return { value: undefined, done: true };
          },

          throw: async (error: any): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            console.log(`Iterator throw () called for session ${sessionId} with error: `, error);
            session.isActive = false;
            throw error;
          }
        };
      }
    };
  }

  // Process the response stream from AWS Bedrock
  private async processResponseStream(sessionId: string, response: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.log(`Session ${sessionId} not found, skipping response processing`);
      return;
    }

    try {
      for await (const event of response.body) {
        // 세션이 더 이상 존재하지 않으면 즉시 중단
        if (!this.activeSessions.has(sessionId) || !session.isActive) {
          console.log(`Session ${sessionId} is no longer active or removed, stopping response processing`);
          break;
        }
        
        if (event.chunk?.bytes) {
          try {
            this.updateSessionActivity(sessionId);
            const textResponse = new TextDecoder().decode(event.chunk.bytes);

            try {
              const jsonResponse = JSON.parse(textResponse);
              if (jsonResponse.event?.contentStart) {
                this.dispatchEvent(sessionId, 'contentStart', jsonResponse.event.contentStart);
              } else if (jsonResponse.event?.textOutput) {
                this.dispatchEvent(sessionId, 'textOutput', jsonResponse.event.textOutput);
              } else if (jsonResponse.event?.audioOutput) {
                this.dispatchEvent(sessionId, 'audioOutput', jsonResponse.event.audioOutput);
              } else if (jsonResponse.event?.toolUse) {
                this.dispatchEvent(sessionId, 'toolUse', jsonResponse.event.toolUse);

                // Store tool use information for later
                session.toolUseContent = jsonResponse.event.toolUse;
                session.toolUseId = jsonResponse.event.toolUse.toolUseId;
                session.toolName = jsonResponse.event.toolUse.toolName;
              } else if (jsonResponse.event?.contentEnd &&
                jsonResponse.event?.contentEnd?.type === 'TOOL') {

                // Process tool use
                console.log(`Processing tool use for session ${sessionId}`);
                this.dispatchEvent(sessionId, 'toolEnd', {
                  toolUseContent: session.toolUseContent,
                  toolUseId: session.toolUseId,
                  toolName: session.toolName
                });

                console.log("calling tooluse");
                console.log("tool use content : ", session.toolUseContent)
                // function calling
                const toolResult = await this.processToolUse(session.toolName, session.toolUseContent);

                // Send tool result
                this.sendToolResult(sessionId, session.toolUseId, toolResult);

                // Also dispatch event about tool result
                this.dispatchEvent(sessionId, 'toolResult', {
                  toolUseId: session.toolUseId,
                  result: toolResult
                });
              } else if (jsonResponse.event?.contentEnd) {
                this.dispatchEvent(sessionId, 'contentEnd', jsonResponse.event.contentEnd);
              }
              else {
                // Handle other events
                const eventKeys = Object.keys(jsonResponse.event || {});
                console.log(`Event keys for session ${sessionId}: `, eventKeys)
                console.log(`Handling other events`)
                if (eventKeys.length > 0) {
                  this.dispatchEvent(sessionId, eventKeys[0], jsonResponse.event);
                } else if (Object.keys(jsonResponse).length > 0) {
                  this.dispatchEvent(sessionId, 'unknown', jsonResponse);
                }
              }
            } catch (e) {
              console.log(`Raw text response for session ${sessionId}(parse error): `, textResponse);
            }
          } catch (e) {
            console.error(`Error processing response chunk for session ${sessionId}: `, e);
          }
        } else if (event.modelStreamErrorException) {
          console.error(`Model stream error for session ${sessionId}: `, event.modelStreamErrorException);
          this.dispatchEvent(sessionId, 'error', {
            type: 'modelStreamErrorException',
            details: event.modelStreamErrorException
          });
        } else if (event.internalServerException) {
          console.error(`Internal server error for session ${sessionId}: `, event.internalServerException);
          this.dispatchEvent(sessionId, 'error', {
            type: 'internalServerException',
            details: event.internalServerException
          });
        }
      }

      console.log(`Response stream processing complete for session ${sessionId}`);
      this.dispatchEvent(sessionId, 'streamComplete', {
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      // 세션이 이미 제거된 경우 에러 로그를 출력하지 않음
      if (this.activeSessions.has(sessionId)) {
        console.error(`Error processing response stream for session ${sessionId}: `, error);
        this.dispatchEvent(sessionId, 'error', {
          source: 'responseStream',
          message: 'Error processing response stream',
          details: error instanceof Error ? error.message : String(error)
        });
      } else {
        console.log(`Session ${sessionId} was removed, ignoring response stream error`);
      }
    }
  }

  // Add an event to a session's queue
  private addEventToSessionQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    this.updateSessionActivity(sessionId);
    session.queue.push(event);
    session.queueSignal.next();
  }


  // Set up initial events for a session
  private setupSessionStartEvent(sessionId: string): void {
    console.log(`Setting up initial events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Session start event
    this.addEventToSessionQueue(sessionId, {
      event: {
        sessionStart: {
          inferenceConfiguration: session.inferenceConfig
        }
      }
    });
  }
  public setupPromptStartEvent(sessionId: string): void {
    console.log(`Setting up promptStart events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          inferenceConfiguration: session.inferenceConfig,
          audioOutputConfiguration: DefaultAudioOutputConfiguration, // 추가된 부분
          toolConfiguration: {
            tools: [{
              toolSpec: {
                name: "getDateAndTimeTool",
                description: "Get information about the current date and time.",
                inputSchema: {
                  json: DefaultToolSchema
                }
              }
            },
            {
              toolSpec: {
                name: "getReservation",
                description: "Get hotel reservation information for a guest by their name.",
                inputSchema: {
                  json: ReservationToolSchema
                }
              }
            }
            ]
          },
        },
      }
    });
    session.isPromptStartSent = true;
  }

  public setupSystemPromptEvent(sessionId: string,
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): void {
    console.log(`Setting up systemPrompt events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    // Text content start
    const textPromptID = randomUUID();
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: textPromptID,
          type: "TEXT",
          interactive: true,
          role: "SYSTEM",
          textInputConfiguration: textConfig,
        },
      }
    });

    // Text input content
    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: textPromptID,
          content: systemPromptContent,
        },
      }
    });

    // Text content end
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: textPromptID,
        },
      }
    });
  }

  public setupStartAudioEvent(
    sessionId: string,
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): void {
    console.log(`Setting up startAudioContent event for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.log(`[DEBUG] No session found for ${sessionId} in setupStartAudioEvent`);
      return;
    }

    console.log(`[DEBUG] Before setupStartAudioEvent - isAudioContentStartSent: ${session.isAudioContentStartSent}`);
    console.log(`Using audio content ID: ${session.audioContentId}`);
    
    // Audio content start with both input and output configurations
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: audioConfig,
          audioOutputConfiguration: DefaultAudioOutputConfiguration, // 추가된 부분
        },
      }
    });
    
    // 실제로 Bedrock에 전송되었는지 확인하기 위해 약간의 지연 후 설정
    setTimeout(() => {
      const currentSession = this.activeSessions.get(sessionId);
      if (currentSession) {
        currentSession.isAudioContentStartSent = true;
        console.log(`[DEBUG] Delayed: isAudioContentStartSent set to true for session ${sessionId}`);
      }
    }, 100);
    
    console.log(`[DEBUG] After setupStartAudioEvent - isAudioContentStartSent: ${session.isAudioContentStartSent}`);
    console.log(`Initial events setup complete for session ${sessionId}`);
  }

  // Stream an audio chunk for a session
  public async streamAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive || !session.audioContentId) {
      throw new Error(`Invalid session ${sessionId} for audio streaming`);
    }
    
    // 오디오 데이터가 실제로 전송되면 플래그들을 true로 설정
    if (!session.isAudioContentStartSent) {
      session.isAudioContentStartSent = true;
    }
    
    // 실제 오디오 데이터가 전송되었음을 표시
    session.hasAudioDataSent = true;
    
    // Convert audio to base64
    const base64Data = audioData.toString('base64');

    this.addEventToSessionQueue(sessionId, {
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          content: base64Data,
        },
      }
    });
  }


  // Send tool result back to the model
  private async sendToolResult(sessionId: string, toolUseId: string, result: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    console.log("inside tool result")
    if (!session || !session.isActive) return;

    console.log(`Sending tool result for session ${sessionId}, tool use ID: ${toolUseId}`);
    const contentId = randomUUID();

    // Tool content start
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          interactive: false,
          type: "TOOL",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId: toolUseId,
            type: "TEXT",
            textInputConfiguration: {
              mediaType: "text/plain"
            }
          }
        }
      }
    });

    // Tool content input
    const resultContent = typeof result === 'string' ? result : JSON.stringify(result);
    this.addEventToSessionQueue(sessionId, {
      event: {
        toolResult: {
          promptName: session.promptName,
          contentName: contentId,
          content: resultContent
        }
      }
    });

    // Tool content end
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId
        }
      }
    });

    console.log(`Tool result sent for session ${sessionId}`);
  }

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    console.log(`[DEBUG] sendContentEnd for session ${sessionId}:`, {
      sessionExists: !!session,
      isAudioContentStartSent: session?.isAudioContentStartSent,
      hasAudioDataSent: session?.hasAudioDataSent,
      audioContentId: session?.audioContentId
    });
    
    if (!session || !session.isAudioContentStartSent) {
      console.log(`[DEBUG] Skipping contentEnd for session ${sessionId} - no session or audio not started`);
      return;
    }

    // 실제 오디오 데이터가 전송된 경우에만 contentEnd를 보냄
    if (!session.hasAudioDataSent) {
      console.log(`[DEBUG] Skipping contentEnd for session ${sessionId} - no actual audio data sent`);
      return;
    }

    console.log(`[DEBUG] Sending contentEnd for session ${sessionId} with contentName: ${session.audioContentId}`);
    
    try {
      await this.addEventToSessionQueue(sessionId, {
        event: {
          contentEnd: {
            promptName: session.promptName,
            contentName: session.audioContentId,
          }
        }
      });

      // Wait to ensure it's processed
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.log(`[DEBUG] Error in sendContentEnd for session ${sessionId}:`, error);
      // 에러가 발생해도 계속 진행
    }
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isPromptStartSent) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        promptEnd: {
          promptName: session.promptName
        }
      }
    });

    // Wait to ensure it's processed
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  public async sendSessionEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        sessionEnd: {}
      }
    });

    // Wait to ensure it's processed
    await new Promise(resolve => setTimeout(resolve, 300));

    // Now it's safe to clean up
    session.isActive = false;
    session.closeSignal.next();
    session.closeSignal.complete();
    this.activeSessions.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
    console.log(`Session ${sessionId} closed and removed from active sessions`);
  }

  // Register an event handler for a session
  public registerEventHandler(sessionId: string, eventType: string, handler: (data: any) => void): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.responseHandlers.set(eventType, handler);
  }

  // Dispatch an event to registered handlers
  private dispatchEvent(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(`Error in ${eventType} handler for session ${sessionId}:`, e);
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get('any');
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}:`, e);
      }
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (this.sessionCleanupInProgress.has(sessionId)) {
      console.log(`Cleanup already in progress for session ${sessionId}, skipping`);
      return;
    }
    this.sessionCleanupInProgress.add(sessionId);
    try {
      console.log(`Starting close process for session ${sessionId}`);
      await this.sendContentEnd(sessionId);
      await this.sendPromptEnd(sessionId);
      await this.sendSessionEnd(sessionId);
      console.log(`Session ${sessionId} cleanup complete`);
    } catch (error) {
      console.error(`Error during closing sequence for session ${sessionId}:`, error);

      // Ensure cleanup happens even if there's an error
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.isActive = false;
        this.activeSessions.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
      }
    } finally {
      // Always clean up the tracking set
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

  // Same for forceCloseSession:
  public forceCloseSession(sessionId: string): void {
    if (this.sessionCleanupInProgress.has(sessionId) || !this.activeSessions.has(sessionId)) {
      console.log(`Session ${sessionId} already being cleaned up or not active`);
      return;
    }

    this.sessionCleanupInProgress.add(sessionId);
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) return;

      console.log(`Force closing session ${sessionId}`);

      // Immediately mark as inactive and clean up resources
      session.isActive = false;
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);

      console.log(`Session ${sessionId} force closed`);
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

}
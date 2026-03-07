/**
 * Chat API v2 - Mastra Agent Implementation
 *
 * Uses the new Mastra-native Head Gardener agent with:
 * - Mastra Memory for conversation persistence
 * - Thread-based conversation management
 * - Semantic recall for context
 * - Learning system integration
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  threadId: z.string().uuid().optional(),
  resourceId: z.string().optional().default('default-user'),
  streamResponse: z.boolean().optional().default(true),
  memoryOptions: z.object({
    lastMessages: z.number().optional(),
    semanticRecall: z.object({
      topK: z.number().optional(),
      messageRange: z.number().optional(),
    }).optional(),
  }).optional(),
});

/**
 * POST /api/chat/v2 - Send a message to the Head Gardener (Mastra version)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      message,
      threadId: providedThreadId,
      resourceId,
      streamResponse,
      memoryOptions,
    } = ChatRequestSchema.parse(body);

    // Generate or use provided thread ID
    const threadId = providedThreadId ?? randomUUID();

    // Dynamic import to avoid build-time initialization
    const { getHeadGardenerAgentV2 } = await import('@/mastra/agents/head-gardener-v2');
    const agent = getHeadGardenerAgentV2();

    if (streamResponse) {
      // Streaming response using Mastra's native streaming
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Send initial acknowledgment with thread ID
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                type: 'start',
                threadId,
                timestamp: new Date().toISOString(),
              })}\n\n`)
            );

            // Stream the response using legacy method (AI SDK v4 compatibility)
            // Note: Use streamLegacy() until @mastra/core upgrades to AI SDK v5
            const agentStream = await agent.streamLegacy(message, {
              threadId,
              resourceId,
            });

            // Stream text chunks
            for await (const chunk of agentStream.textStream) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({
                  type: 'chunk',
                  content: chunk,
                })}\n\n`)
              );
            }

            // Get final text
            const fullText = await agentStream.text;

            // Send completion with full response
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                type: 'done',
                threadId,
                fullText,
                timestamp: new Date().toISOString(),
              })}\n\n`)
            );

            controller.close();
          } catch (error) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
              })}\n\n`)
            );
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } else {
      // Non-streaming response
      const response = await agent.generate(message, {
        threadId,
        resourceId,
      });

      return NextResponse.json({
        message: response.text,
        threadId,
        toolCalls: response.toolResults?.map(tr => ({
          toolName: tr.payload.toolName,
          args: tr.payload.args,
          result: tr.payload.result,
        })),
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: { issues: error.issues },
        },
        { status: 400 }
      );
    }

    console.error('Chat v2 error:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to process chat message',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/chat/v2 - Get thread information
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const threadId = searchParams.get('threadId');

  if (!threadId) {
    return NextResponse.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'threadId query parameter is required',
      },
      { status: 400 }
    );
  }

  try {
    // For now, return basic thread info
    // Full thread history retrieval can be implemented via Mastra Memory API
    return NextResponse.json({
      threadId,
      message: 'Thread history available via Mastra Memory API',
    });
  } catch (error) {
    console.error('Error fetching thread:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch thread',
      },
      { status: 500 }
    );
  }
}

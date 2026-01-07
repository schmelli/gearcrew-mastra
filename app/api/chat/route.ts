/**
 * T050: Streaming Chat Endpoint
 * Implements FR-010, FR-027: Interactive chat interface with Head Gardener
 * Uses SSE (Server-Sent Events) for streaming responses
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { z } from 'zod';
import { getHeadGardenerAgent } from '@/mastra/agents/head-gardener';

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  streamResponse: z.boolean().optional().default(true),
});

/**
 * POST /api/chat - Send a message to the Head Gardener
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, streamResponse } = ChatRequestSchema.parse(body);

    const headGardener = getHeadGardenerAgent();

    if (streamResponse) {
      // SSE streaming response
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Send initial acknowledgment
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'start', timestamp: new Date().toISOString() })}\n\n`)
            );

            // Process the message
            const response = await headGardener.chat(message);

            // Stream the response in chunks
            const chunks = splitIntoChunks(response.message, 100);

            for (const chunk of chunks) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`)
              );
              // Small delay for streaming effect
              await new Promise((resolve) => setTimeout(resolve, 10));
            }

            // Send tool calls if any
            if (response.toolCalls && response.toolCalls.length > 0) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'tools', toolCalls: response.toolCalls })}\n\n`)
              );
            }

            // Send suggestions
            if (response.suggestions && response.suggestions.length > 0) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'suggestions', suggestions: response.suggestions })}\n\n`)
              );
            }

            // Send completion
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'done', timestamp: new Date().toISOString() })}\n\n`)
            );

            controller.close();
          } catch (error) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'error',
                  error: error instanceof Error ? error.message : 'Unknown error',
                })}\n\n`
              )
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
      const response = await headGardener.chat(message);

      return NextResponse.json({
        message: response.message,
        toolCalls: response.toolCalls,
        suggestions: response.suggestions,
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

    console.error('Chat error:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to process chat message',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/chat - Get conversation history
 */
export async function GET() {
  try {
    const headGardener = getHeadGardenerAgent();
    const history = headGardener.getConversationHistory();

    return NextResponse.json({
      history,
      messageCount: history.length,
    });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch chat history',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/chat - Clear conversation history
 */
export async function DELETE() {
  try {
    const headGardener = getHeadGardenerAgent();
    headGardener.clearHistory();

    return NextResponse.json({
      success: true,
      message: 'Conversation history cleared',
    });
  } catch (error) {
    console.error('Error clearing chat history:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to clear chat history',
      },
      { status: 500 }
    );
  }
}

/**
 * Split text into chunks for streaming
 */
function splitIntoChunks(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  const words = text.split(' ');
  let currentChunk = '';

  for (const word of words) {
    if (currentChunk.length + word.length + 1 <= maxChunkSize) {
      currentChunk += (currentChunk ? ' ' : '') + word;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      currentChunk = word;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

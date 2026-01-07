'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  suggestions?: string[];
}

interface SSEData {
  type: 'start' | 'chunk' | 'tools' | 'suggestions' | 'done' | 'error';
  content?: string;
  suggestions?: string[];
  toolCalls?: Array<{ tool: string; result: unknown }>;
  error?: string;
  timestamp?: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: "Hello! I'm the Head Gardener. I help maintain the GearGraph database. You can ask me about:\n\n• System status and health\n• Pending approval decisions\n• Recent maintenance actions\n• Manual workflow triggers\n\nHow can I help you today?",
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setSuggestions([]);
    setMessages((prev) => [...prev, { role: 'user', content: userMessage, timestamp: new Date().toISOString() }]);
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage,
          streamResponse: true,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      // Handle SSE streaming response
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';
      let currentSuggestions: string[] = [];

      setMessages((prev) => [...prev, { role: 'assistant', content: '', timestamp: new Date().toISOString() }]);

      if (reader) {
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data: SSEData = JSON.parse(line.slice(6));

                switch (data.type) {
                  case 'start':
                    // Connection established
                    break;

                  case 'chunk':
                    if (data.content) {
                      assistantMessage += data.content + ' ';
                      setMessages((prev) => {
                        const newMessages = [...prev];
                        newMessages[newMessages.length - 1] = {
                          role: 'assistant',
                          content: assistantMessage.trim(),
                        };
                        return newMessages;
                      });
                    }
                    break;

                  case 'suggestions':
                    if (data.suggestions) {
                      currentSuggestions = data.suggestions;
                      setSuggestions(data.suggestions);
                    }
                    break;

                  case 'done':
                    // Update final message with suggestions
                    setMessages((prev) => {
                      const newMessages = [...prev];
                      newMessages[newMessages.length - 1] = {
                        role: 'assistant',
                        content: assistantMessage.trim(),
                        suggestions: currentSuggestions,
                        timestamp: data.timestamp,
                      };
                      return newMessages;
                    });
                    break;

                  case 'error':
                    throw new Error(data.error ?? 'Unknown error');
                }
              } catch (parseError) {
                // Ignore parse errors for incomplete JSON
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
  };

  const suggestedQueries = [
    "What's the system status?",
    'Show me pending approvals',
    'How many orphans today?',
    'Analyze graph health',
  ];

  return (
    <div className="max-w-4xl mx-auto p-4">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Graph Gardener</h1>
        <p className="text-sm text-gray-500">Autonomous Graph Maintenance System</p>
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Chat Messages */}
      <div className="bg-white rounded-lg shadow-lg mb-4 p-4 h-[55vh] overflow-y-auto">
        {messages.map((message, index) => (
          <div key={index} className={`chat-message ${message.role}`}>
            <div className="flex items-start space-x-3">
              <span className="text-xl flex-shrink-0">
                {message.role === 'assistant' ? '🌱' : '👤'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 mb-1">
                  {message.role === 'assistant' ? 'Head Gardener' : 'You'}
                  {message.timestamp && (
                    <span className="text-xs text-gray-400 ml-2">
                      {new Date(message.timestamp).toLocaleTimeString()}
                    </span>
                  )}
                </p>
                <div className="text-gray-700 whitespace-pre-wrap break-words">
                  {formatMessage(message.content)}
                </div>
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="chat-message assistant">
            <div className="flex items-center space-x-2">
              <span className="text-xl">🌱</span>
              <div className="animate-pulse flex space-x-1">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggestions */}
      {(suggestions.length > 0 || messages.length <= 2) && (
        <div className="mb-4">
          <p className="text-sm text-gray-500 mb-2">
            {suggestions.length > 0 ? 'Suggestions:' : 'Try asking:'}
          </p>
          <div className="flex flex-wrap gap-2">
            {(suggestions.length > 0 ? suggestions : suggestedQueries).map((query, index) => (
              <button
                key={index}
                onClick={() => handleSuggestionClick(query)}
                className="px-3 py-1 bg-green-50 hover:bg-green-100 border border-green-200 rounded-full text-sm text-green-700 transition-colors"
              >
                {query}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="flex space-x-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the Head Gardener..."
          className="chat-input flex-1"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isLoading ? 'Thinking...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

/**
 * Status Bar Component
 */
function StatusBar() {
  const [status, setStatus] = useState<{
    status: string;
    pendingApprovals: number;
    memgraphConnected: boolean;
  } | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/system/status');
        if (response.ok) {
          const data = await response.json();
          setStatus(data);
        }
      } catch (error) {
        console.error('Failed to fetch status:', error);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Refresh every 30s

    return () => clearInterval(interval);
  }, []);

  if (!status) return null;

  return (
    <div className="mb-4 flex items-center justify-between px-4 py-2 bg-gray-50 rounded-lg text-sm">
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-1">
          <span
            className={`w-2 h-2 rounded-full ${
              status.status === 'healthy'
                ? 'bg-green-500'
                : status.status === 'degraded'
                ? 'bg-yellow-500'
                : 'bg-red-500'
            }`}
          ></span>
          <span className="text-gray-600 capitalize">{status.status}</span>
        </div>
        <div className="text-gray-400">|</div>
        <div className="text-gray-600">
          DB: {status.memgraphConnected ? 'Connected' : 'Disconnected'}
        </div>
      </div>
      {status.pendingApprovals > 0 && (
        <div className="flex items-center space-x-1 text-orange-600">
          <span className="font-medium">{status.pendingApprovals}</span>
          <span>pending approval{status.pendingApprovals !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Format message with markdown-like styling
 */
function formatMessage(content: string): JSX.Element {
  // Split by newlines and process each line
  const lines = content.split('\n');

  return (
    <>
      {lines.map((line, i) => {
        // Bold headers
        if (line.startsWith('**') && line.endsWith('**')) {
          return (
            <p key={i} className="font-bold text-gray-900 mt-2 mb-1">
              {line.slice(2, -2)}
            </p>
          );
        }

        // Bullet points
        if (line.startsWith('- ') || line.startsWith('• ')) {
          return (
            <p key={i} className="ml-4">
              • {line.slice(2)}
            </p>
          );
        }

        // Code blocks
        if (line.startsWith('```')) {
          return null; // Skip code fence markers
        }

        // Regular lines
        return (
          <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
            {line}
          </p>
        );
      })}
    </>
  );
}

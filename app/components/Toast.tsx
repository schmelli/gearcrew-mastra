'use client';

import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  details?: string[];
  duration?: number;
}

interface ToastProps {
  message: ToastMessage;
  onDismiss: (id: string) => void;
}

function Toast({ message, onDismiss }: ToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const duration = message.duration ?? 5000;
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(() => onDismiss(message.id), 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => onDismiss(message.id), 300);
  };

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
  };

  const bgColors = {
    success: 'bg-green-50 border-green-200',
    error: 'bg-red-50 border-red-200',
    info: 'bg-blue-50 border-blue-200',
    warning: 'bg-yellow-50 border-yellow-200',
  };

  const titleColors = {
    success: 'text-green-800',
    error: 'text-red-800',
    info: 'text-blue-800',
    warning: 'text-yellow-800',
  };

  const detailColors = {
    success: 'text-green-700',
    error: 'text-red-700',
    info: 'text-blue-700',
    warning: 'text-yellow-700',
  };

  return (
    <div
      className={`
        ${bgColors[message.type]} border rounded-lg shadow-lg p-4 mb-3
        transform transition-all duration-300 ease-out
        ${isExiting ? 'translate-x-full opacity-0' : 'translate-x-0 opacity-100'}
      `}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="text-xl flex-shrink-0">{icons[message.type]}</span>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold ${titleColors[message.type]}`}>
            {message.title}
          </p>
          {message.details && message.details.length > 0 && (
            <ul className={`mt-1 text-sm ${detailColors[message.type]} space-y-0.5`}>
              {message.details.map((detail, i) => (
                <li key={i} className="flex items-start gap-1">
                  <span className="opacity-60">•</span>
                  <span>{detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          onClick={handleDismiss}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

interface ToastContainerProps {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ messages, onDismiss }: ToastContainerProps) {
  return (
    <div className="fixed top-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)]">
      {messages.map((message) => (
        <Toast key={message.id} message={message} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export function useToast() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const addToast = (toast: Omit<ToastMessage, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMessages((prev) => [...prev, { ...toast, id }]);
    return id;
  };

  const dismissToast = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const success = (title: string, details?: string[]) =>
    addToast({ type: 'success', title, details, duration: 6000 });

  const error = (title: string, details?: string[]) =>
    addToast({ type: 'error', title, details, duration: 8000 });

  const info = (title: string, details?: string[]) =>
    addToast({ type: 'info', title, details, duration: 5000 });

  const warning = (title: string, details?: string[]) =>
    addToast({ type: 'warning', title, details, duration: 6000 });

  return {
    messages,
    addToast,
    dismissToast,
    success,
    error,
    info,
    warning,
  };
}

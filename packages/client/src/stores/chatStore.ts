import { create } from 'zustand';
import type { Message } from '../api/client';

interface ChatState {
  messages: Record<string, Message[]>;
  streaming: boolean;
  streamingText: string;
  streamingConvId: string | null;

  setMessages: (convId: string, msgs: Message[]) => void;
  addMessage: (convId: string, msg: Message) => void;
  setStreaming: (v: boolean, convId?: string) => void;
  appendStreamingText: (t: string) => void;
  clearStreaming: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: {},
  streaming: false,
  streamingText: '',
  streamingConvId: null,

  setMessages: (convId, msgs) => set((s) => ({ messages: { ...s.messages, [convId]: msgs } })),
  addMessage: (convId, msg) => set((s) => ({
    messages: { ...s.messages, [convId]: [...(s.messages[convId] || []), msg] }
  })),
  setStreaming: (streaming, convId) => set({ streaming, streamingConvId: convId ?? null }),
  appendStreamingText: (t) => set((s) => ({ streamingText: s.streamingText + t })),
  clearStreaming: () => set({ streaming: false, streamingText: '', streamingConvId: null }),
}));

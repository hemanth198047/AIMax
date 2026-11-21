import { create } from 'zustand';
import type { Message } from '../api/client';

export interface ActivityStep { step: string; detail: string }
export interface ContextItem { id: string; title: string; type: string; scope: string; provenance: string; chars: number }

interface ChatState {
  activity: ActivityStep[];
  retrieved: ContextItem[];
  addActivity: (a: ActivityStep) => void;
  setRetrieved: (items: ContextItem[]) => void;
  resetTurn: () => void;
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
  activity: [],
  retrieved: [],
  addActivity: (a) => set((s) => ({ activity: [...s.activity, a] })),
  setRetrieved: (retrieved) => set({ retrieved }),
  resetTurn: () => set({ activity: [], retrieved: [] }),
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

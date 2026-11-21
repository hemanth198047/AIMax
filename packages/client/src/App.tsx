import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ContextPanel from './components/ContextPanel';
import { useAppStore } from './stores/appStore';
import { apiFetch } from './api/client';
import type { Project, Person, Conversation } from './api/client';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

function MainLayout() {
  const { setProjects, setPeople, setConversations } = useAppStore();

  useEffect(() => {
    apiFetch<Project[]>('/api/projects').then(setProjects).catch(console.error);
    apiFetch<Person[]>('/api/people').then(setPeople).catch(console.error);
    apiFetch<Conversation[]>('/api/conversations').then(setConversations).catch(console.error);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-900 text-slate-100">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ChatView />
      </main>
      <ContextPanel />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/*" element={<MainLayout />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

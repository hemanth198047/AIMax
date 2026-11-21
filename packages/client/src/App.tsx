import { loadConversations } from './api/conversations';
import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ContextPanel from './components/ContextPanel';
import SandboxPanel from './components/SandboxPanel';
import KnowledgePanel from './components/KnowledgePanel';
import LinkVaultPanel from './components/LinkVaultPanel';
import { useAppStore } from './stores/appStore';
import { apiFetch } from './api/client';
import type { Project, Person, Conversation } from './api/client';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

function MainLayout() {
  const { setProjects, setPeople, reconcile } = useAppStore();
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showLinkVault, setShowLinkVault] = useState(false);

  useEffect(() => {
    Promise.all([
      apiFetch<Project[]>('/api/projects').then(setProjects),
      apiFetch<Person[]>('/api/people').then(setPeople),
    ]).then(reconcile).then(loadConversations).catch(console.error);
  }, []);

  const { activeProjectId, activePersonId } = useAppStore();
  useEffect(() => { loadConversations().catch(console.error); }, [activeProjectId, activePersonId]);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-900 text-slate-100">
      <Sidebar onShowKnowledge={() => setShowKnowledge(true)} onShowLinkVault={() => setShowLinkVault(true)} />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ChatView />
        <SandboxPanel />
      </main>
      <ContextPanel />
      {showKnowledge && <KnowledgePanel onClose={() => setShowKnowledge(false)} />}
      {showLinkVault && <LinkVaultPanel onClose={() => setShowLinkVault(false)} />}
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

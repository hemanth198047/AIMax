import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Project, Person, Conversation } from '../api/client';

type SidebarSection = 'conversations' | 'projects' | 'people' | 'memory' | 'tasks';
type Scope = 'global' | 'project' | 'person' | 'project_person';
export type EnhanceMode = 'off' | 'minimal' | 'balanced' | 'maximum';

interface AppState {
  activeProjectId: string | null;
  activePersonId: string | null;
  activeConversationId: string | null;
  scope: Scope;
  provider: string;
  enhance: EnhanceMode;
  activeSandboxId: string | null;
  sidebarSection: SidebarSection;
  projects: Project[];
  people: Person[];
  conversations: Conversation[];

  setActiveProject: (id: string | null) => void;
  setActivePerson: (id: string | null) => void;
  setActiveConversation: (id: string | null) => void;
  setScope: (s: Scope) => void;
  setProvider: (p: string) => void;
  setEnhance: (m: EnhanceMode) => void;
  setActiveSandbox: (id: string | null) => void;
  setSidebarSection: (s: SidebarSection) => void;
  setProjects: (p: Project[]) => void;
  setPeople: (p: Person[]) => void;
  setConversations: (c: Conversation[]) => void;
  /** Drop persisted selections that no longer exist on the server (deleted project/person/conversation). */
  reconcile: () => void;
}

function computeScope(projectId: string | null, personId: string | null): Scope {
  if (projectId && personId) return 'project_person';
  if (projectId) return 'project';
  if (personId) return 'person';
  return 'global';
}

export const useAppStore = create<AppState>()(persist((set) => ({
  activeProjectId: null,
  activePersonId: null,
  activeConversationId: null,
  scope: 'global',
  provider: 'auto',
  enhance: 'balanced',
  activeSandboxId: null,
  sidebarSection: 'conversations',
  projects: [],
  people: [],
  conversations: [],

  setActiveProject: (id) => set((s) => ({ activeProjectId: id, scope: computeScope(id, s.activePersonId) })),
  setActivePerson: (id) => set((s) => ({ activePersonId: id, scope: computeScope(s.activeProjectId, id) })),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setScope: (scope) => set({ scope }),
  setProvider: (provider) => set({ provider }),
  setEnhance: (enhance) => set({ enhance }),
  setActiveSandbox: (activeSandboxId) => set({ activeSandboxId }),
  setSidebarSection: (sidebarSection) => set({ sidebarSection }),
  setProjects: (projects) => set({ projects }),
  setPeople: (people) => set({ people }),
  setConversations: (conversations) => set({ conversations }),
  reconcile: () => set((s) => {
    const projectOk = !s.activeProjectId || s.projects.some(p => p.id === s.activeProjectId);
    const personOk = !s.activePersonId || s.people.some(p => p.id === s.activePersonId);
    const activeProjectId = projectOk ? s.activeProjectId : null;
    const activePersonId = personOk ? s.activePersonId : null;
    return { activeProjectId, activePersonId, activeConversationId: s.activeConversationId, // validated by loadConversations() against the context-visible list
     
      scope: computeScope(activeProjectId, activePersonId) };
  }),
}), {
  name: 'aimax-ui-state',
  // Only the user's selections survive a reload/restart; data lists are re-fetched from the server.
  partialize: (s) => ({
    activeProjectId: s.activeProjectId, activePersonId: s.activePersonId, activeConversationId: s.activeConversationId,
    scope: s.scope, provider: s.provider, enhance: s.enhance, activeSandboxId: s.activeSandboxId, sidebarSection: s.sidebarSection,
  }),
}));

import { create } from 'zustand';
import type { Project, Person, Conversation } from '../api/client';

type SidebarSection = 'conversations' | 'projects' | 'people' | 'memory' | 'tasks';
type Scope = 'global' | 'project' | 'person' | 'project_person';

interface AppState {
  activeProjectId: string | null;
  activePersonId: string | null;
  activeConversationId: string | null;
  scope: Scope;
  provider: string;
  sidebarSection: SidebarSection;
  projects: Project[];
  people: Person[];
  conversations: Conversation[];

  setActiveProject: (id: string | null) => void;
  setActivePerson: (id: string | null) => void;
  setActiveConversation: (id: string | null) => void;
  setScope: (s: Scope) => void;
  setProvider: (p: string) => void;
  setSidebarSection: (s: SidebarSection) => void;
  setProjects: (p: Project[]) => void;
  setPeople: (p: Person[]) => void;
  setConversations: (c: Conversation[]) => void;
}

function computeScope(projectId: string | null, personId: string | null): Scope {
  if (projectId && personId) return 'project_person';
  if (projectId) return 'project';
  if (personId) return 'person';
  return 'global';
}

export const useAppStore = create<AppState>((set) => ({
  activeProjectId: null,
  activePersonId: null,
  activeConversationId: null,
  scope: 'global',
  provider: 'auto',
  sidebarSection: 'conversations',
  projects: [],
  people: [],
  conversations: [],

  setActiveProject: (id) => set((s) => ({ activeProjectId: id, scope: computeScope(id, s.activePersonId) })),
  setActivePerson: (id) => set((s) => ({ activePersonId: id, scope: computeScope(s.activeProjectId, id) })),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setScope: (scope) => set({ scope }),
  setProvider: (provider) => set({ provider }),
  setSidebarSection: (sidebarSection) => set({ sidebarSection }),
  setProjects: (projects) => set({ projects }),
  setPeople: (people) => set({ people }),
  setConversations: (conversations) => set({ conversations }),
}));

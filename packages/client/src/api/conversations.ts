import { apiFetch, type Conversation } from './client';
import { useAppStore } from '../stores/appStore';

/** Load the conversations visible in the CURRENT project/person context (the server enforces the scope rules). */
export async function loadConversations(): Promise<void> {
  const { activeProjectId, activePersonId } = useAppStore.getState();
  const q = new URLSearchParams();
  if (activeProjectId) q.set('project_id', activeProjectId);
  if (activePersonId) q.set('person_id', activePersonId);
  const list = await apiFetch<Conversation[]>(`/api/conversations?${q}`);
  const st = useAppStore.getState();
  st.setConversations(list);
  if (st.activeConversationId && !list.some(c => c.id === st.activeConversationId)) st.setActiveConversation(null);
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface Project {
  id: string; name: string; description: string; category: string;
  status: string; priority: string; tags: string; repo_path: string;
  tech_stack: string; instructions: string; provider: string;
  privacy: string; created_at: string; updated_at: string;
}

export interface Person {
  id: string; display_name: string; preferred_name: string; role: string;
  organization: string; relationship: string; notes: string; tags: string;
  privacy: string; created_at: string; updated_at: string;
}

export interface Conversation {
  id: string; title: string; scope: string; project_id: string | null;
  person_id: string | null; provider: string; model: string;
  pinned: number; archived: number; created_at: string; updated_at: string;
}

export interface Message {
  id: string; conversation_id: string; role: string; content: string;
  attachments: string; provider: string; model: string;
  tokens_used: number; created_at: string;
}

export interface Task {
  id: string; title: string; description: string;
  project_id: string | null; person_id: string | null;
  status: string; priority: string; created_at: string; updated_at: string;
}

export interface MemoryEntry {
  id: string; scope: string; project_id: string | null; person_id: string | null;
  type: string; title: string; content: string; provenance: string;
  confidence: number; tags: string; created_at: string; updated_at: string;
}

export interface Sandbox {
  id: string; name: string; project_id: string | null; mode: string;
  working_dir: string; status: string; created_at: string; last_used: string;
}

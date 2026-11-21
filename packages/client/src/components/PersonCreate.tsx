import React, { useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '../api/client';
import type { Person } from '../api/client';
import { useAppStore } from '../stores/appStore';

export default function PersonCreate({ onClose }: { onClose: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('');
  const [organization, setOrganization] = useState('');
  const [relationship, setRelationship] = useState('colleague');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { people, setPeople } = useAppStore();

  const submit = async () => {
    if (!displayName.trim()) return;
    setLoading(true); setError('');
    try {
      const person = await apiFetch<Person>('/api/people', {
        method: 'POST',
        body: JSON.stringify({ display_name: displayName.trim(), role, organization, relationship, notes })
      });
      setPeople([...people, person]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create person');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-5 w-full max-w-md shadow-2xl">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-slate-100">New Person</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={15} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Name *</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} autoFocus
              onKeyDown={e => e.key === 'Enter' && submit()}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              placeholder="Full Name" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Role</label>
              <input value={role} onChange={e => setRole(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                placeholder="Engineer" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Relationship</label>
              <select value={relationship} onChange={e => setRelationship(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
                {['colleague', 'client', 'manager', 'mentor', 'student', 'stakeholder', 'contact', 'family', 'other'].map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Organization</label>
            <input value={organization} onChange={e => setOrganization(e.target.value)}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              placeholder="Company Name" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
              placeholder="Any notes..." />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-xs text-slate-400 border border-slate-600 rounded-lg hover:text-slate-200 transition-colors">Cancel</button>
          <button onClick={submit} disabled={!displayName.trim() || loading}
            className="flex-1 px-3 py-2 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg transition-colors font-medium">
            {loading ? 'Creating…' : 'Create Person'}
          </button>
        </div>
      </div>
    </div>
  );
}

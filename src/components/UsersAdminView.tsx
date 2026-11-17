import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Shield, UserPlus } from 'lucide-react';
import { api } from '../api';
import type { AuthUser, UserRecord, UserRole } from '../types';

interface UsersAdminViewProps {
  currentUser: AuthUser;
}

export function UsersAdminView({ currentUser }: UsersAdminViewProps) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('operator');
  const [creating, setCreating] = useState(false);

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getUsers();
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (currentUser.role === 'admin') {
      void loadUsers();
    }
  }, [currentUser.role]);

  if (currentUser.role !== 'admin') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <Shield className="w-8 h-8 text-slate-400 mx-auto" />
        <h2 className="mt-3 text-lg font-semibold text-slate-900">Admin Role Required</h2>
        <p className="mt-1 text-sm text-slate-600">
          Your current role (<span className="font-mono">{currentUser.role}</span>) does not permit user administration.
        </p>
      </div>
    );
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setCreating(true);
    try {
      const created = await api.createUser({
        username,
        full_name: fullName,
        password,
        role,
      });
      setFeedback({
        kind: 'success',
        text: `Created user "${created.username}" (${created.role}). They can now sign in with their username and password.`,
      });
      setUsername('');
      setFullName('');
      setPassword('');
      setRole('operator');
      await loadUsers();
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to create user.',
      });
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate(userId: string | number, patch: { role?: UserRole; active?: number }) {
    setFeedback(null);
    try {
      await api.updateUser(userId, patch);
      setFeedback({ kind: 'success', text: 'Updated user permissions in Firestore.' });
      await loadUsers();
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Update failed.',
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">User Administration &amp; Roles</h1>
        <p className="mt-1 text-sm text-slate-600">
          Create warehouse username/password accounts and manage roles enforced by Firestore security rules.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${
            feedback.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {feedback.kind === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-base font-semibold text-slate-900">Registered Warehouse Accounts</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                  <th className="px-5 py-2.5">Username</th>
                  <th className="px-4 py-2.5">Full Name</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-5 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-500">
                      Loading users...
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-500">
                      No registered users found yet.
                    </td>
                  </tr>
                ) : (
                  users.map((u) => {
                    const isSelf = u.id === currentUser.uid || u.username === currentUser.username;
                    return (
                      <tr key={u.id} className="hover:bg-slate-50/80">
                        <td className="px-5 py-3 font-mono font-semibold text-slate-900">{u.username}</td>
                        <td className="px-4 py-3 text-slate-700">{u.full_name}</td>
                        <td className="px-4 py-3">
                          <select
                            aria-label={`Role for ${u.username}`}
                            value={u.role}
                            disabled={isSelf}
                            onChange={(e) => void handleUpdate(u.id, { role: e.target.value as UserRole })}
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-mono text-slate-800 disabled:opacity-60"
                          >
                            <option value="admin">admin</option>
                            <option value="supervisor">supervisor</option>
                            <option value="operator">operator</option>
                          </select>
                        </td>
                        <td className="px-4 py-3 text-xs font-medium">
                          <span className={u.active ? 'text-emerald-700' : 'text-red-700'}>
                            {u.active ? 'Active' : 'Disabled'}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            disabled={isSelf}
                            onClick={() => void handleUpdate(u.id, { active: u.active ? 0 : 1 })}
                            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
                          >
                            {u.active ? 'Deactivate' : 'Activate'}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <form
          onSubmit={(e) => void handleCreateUser(e)}
          className="lg:col-span-4 rounded-xl border border-slate-200 bg-white p-6 space-y-4"
        >
          <div className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-blue-700" />
            <h2 className="text-base font-semibold text-slate-900">Create Warehouse User</h2>
          </div>

          <div>
            <label htmlFor="new-username" className="block text-xs font-medium text-slate-700 mb-1.5">
              Username
            </label>
            <input
              id="new-username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. operator1"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="new-fullname" className="block text-xs font-medium text-slate-700 mb-1.5">
              Full Name
            </label>
            <input
              id="new-fullname"
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Marcus Chen"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="new-password" className="block text-xs font-medium text-slate-700 mb-1.5">
              Password (min 6 characters)
            </label>
            <input
              id="new-password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Assign login password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="new-role" className="block text-xs font-medium text-slate-700 mb-1.5">
              Role
            </label>
            <select
              id="new-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-blue-600 focus:outline-none"
            >
              <option value="operator">operator</option>
              <option value="supervisor">supervisor</option>
              <option value="admin">admin</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={creating}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            <span>{creating ? 'Creating User...' : 'Create User'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}

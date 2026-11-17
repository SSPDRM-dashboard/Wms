import React, { useState } from 'react';
import { Lock, ShieldCheck, Database, LogIn, UserPlus } from 'lucide-react';
import { api } from '../api';

interface LoginViewProps {
  initialError?: string | null;
}

export function LoginView({ initialError = null }: LoginViewProps) {
  const [mode, setMode] = useState<'signin' | 'setup'>('signin');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignInSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
      setLoading(false);
    }
  }

  async function handleSetupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await api.initializeSystemAdmin({
        username,
        fullName,
        password,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to initialize system administrator.');
      setLoading(false);
    }
  }

  const displayError = error || initialError;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        <div className="lg:col-span-7 bg-slate-900 text-slate-100 rounded-xl p-8 lg:p-10 flex flex-col justify-between border border-slate-800">
          <div>
            <div className="flex items-center gap-3 text-slate-300 text-sm font-medium">
              <ShieldCheck className="w-4 h-4 text-blue-400" />
              <span>Multi-Company Warehouse Management · Cloud Firestore</span>
            </div>
            <h1 className="mt-4 text-3xl lg:text-4xl font-bold tracking-tight text-white [text-wrap:balance]">
              NexusWMS Operations Console
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-slate-300 max-w-xl">
              Company-isolated inventory control engineered for Bluetooth HID 2D QR scanning,
              Excel/CSV pallet lookup, atomic container receiving, strict FIFO outbound issuing,
              location transfers, and assembly BOM coverage tracking.
            </p>

            <div className="mt-8 pt-6 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-6 text-sm">
              <div>
                <h2 className="font-semibold text-white">COMP-B-SAIC QR Profile</h2>
                <p className="mt-1 text-slate-400 leading-relaxed">
                  Underscore-delimited box labels mapping segment 2 part, segment 4 quantity,
                  segment 5 box ID, and segment 6 batch reference.
                </p>
              </div>
              <div>
                <h2 className="font-semibold text-white">COMP-A-GWM QR Profile</h2>
                <p className="mt-1 text-slate-400 leading-relaxed">
                  Slash-delimited box content labels (<span className="font-mono text-slate-200">part&amp;qty</span>)
                  with non-inventory pallet reference recognition and master sheet lookup.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-10 pt-6 border-t border-slate-800 flex items-start gap-3 text-xs text-slate-300 leading-relaxed">
            <Database className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              Backed by persistent <span className="font-semibold text-white">Firebase Firestore</span>.
              Inventory lots, receiving manifests, uploaded packing lists, and movement history are
              stored permanently in the cloud and preserved across all system updates and deployments.
            </span>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white rounded-xl border border-slate-200 p-8 flex flex-col justify-center">
          <div className="flex items-center gap-2.5 text-slate-900">
            {mode === 'signin' ? (
              <Lock className="w-5 h-5 text-blue-700" />
            ) : (
              <UserPlus className="w-5 h-5 text-blue-700" />
            )}
            <h2 className="text-xl font-bold tracking-tight">
              {mode === 'signin' ? 'Operator Sign In' : 'First-Time Admin Setup'}
            </h2>
          </div>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            {mode === 'signin'
              ? 'Sign in with your system username and password to access NexusWMS warehouse operations.'
              : 'Create the initial system administrator username and password. After setup, additional accounts are managed inside User Admin.'}
          </p>

          {displayError && (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800"
            >
              {displayError}
            </div>
          )}

          {mode === 'signin' ? (
            <form onSubmit={(e) => void handleSignInSubmit(e)} className="mt-6 space-y-4">
              <div>
                <label htmlFor="login-username" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Username
                </label>
                <input
                  id="login-username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. admin or operator"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="w-4 h-4" />
                <span>{loading ? 'Signing In...' : 'Sign In'}</span>
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleSetupSubmit(e)} className="mt-6 space-y-4">
              <div>
                <label htmlFor="setup-username" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Admin Username
                </label>
                <input
                  id="setup-username"
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. admin"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="setup-fullname" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Full Name
                </label>
                <input
                  id="setup-fullname"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="System Administrator"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="setup-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Password (min 6 characters)
                </label>
                <input
                  id="setup-password"
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create admin password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="setup-confirm" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Confirm Password
                </label>
                <input
                  id="setup-confirm"
                  type="password"
                  required
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                <UserPlus className="w-4 h-4" />
                <span>{loading ? 'Creating Admin...' : 'Initialize System Admin'}</span>
              </button>
            </form>
          )}

          <div className="mt-6 pt-5 border-t border-slate-100 flex items-center justify-between gap-4 text-xs text-slate-500">
            <span>
              {mode === 'signin'
                ? 'Setting up this system for the first time?'
                : 'Already have a system account?'}
            </span>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === 'signin' ? 'setup' : 'signin');
              }}
              className="font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap"
            >
              {mode === 'signin' ? 'First-Time Admin Setup' : 'Back to Sign In'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

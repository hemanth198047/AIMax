import { create } from 'zustand';

/** Links in the last message that need a sign-in, plus the message to re-send after the page was captured. */
interface SignInState {
  pending: { urls: string[]; message: string } | null;
  resend: string | null;
  setPending: (p: { urls: string[]; message: string } | null) => void;
  setResend: (m: string | null) => void;
}
export const useSignIn = create<SignInState>((set) => ({ pending: null, resend: null, setPending: (pending) => set({ pending }), setResend: (resend) => set({ resend }) }));

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookmarkCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Eye,
  EyeOff,
  FileText,
  History,
  Home,
  LockKeyhole,
  Lightbulb,
  LoaderCircle,
  Mail,
  MessageCircle,
  Mic2,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Target,

  X,
} from "lucide-react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

type Page = "home" | "setup" | "interview" | "report" | "history" | "progress" | "profile";
type Dimension = {
  key: string;
  label: string;
  weight: number;
  score: number;
  explanation?: string;
  evidence?: string | null;
  percent?: number;
};
type Evaluation = {
  rubric_version: string;
  overall_score: number;
  scores: Dimension[];
  strengths: string[];
  priority: string;
  evaluator: string;
  is_relevant?: boolean;
  relevance_feedback?: string;
  review_verdict?: "correct_and_relevant" | "partially_correct" | "incorrect_or_off_topic";
  model_answer?: string;
  recommendations?: string[];
  example?: string;
};
type InterviewQuestion = {
  id: string;
  text: string;
  kind: "primary" | "follow_up";
  competency: string;
  parent_id: string | null;
  answer: { text: string; submitted_at: string; type: string } | null;
  evaluation: Evaluation | null;
  skipped: boolean;
  revisions: { text: string; type: string; submitted_at: string; evaluation: Evaluation }[];
};
type ChatMessageItem = {
  id: string;
  role: "assistant" | "user";
  content: string;
  timestamp: string;
};

type InterviewSession = {
  id: string;
  status: "draft" | "active" | "completed";
  created_at: string;
  completed_at: string | null;
  config: {
    role: string;
    interview_type: string;
    difficulty: string;
    duration_minutes: number;
    focus_competency: string;
    ai_consent?: boolean;
    mode?: "structured" | "conversational";
  };
  question_limit: number;
  primary_question_count: number;
  continuation_pending?: boolean;
  questions: InterviewQuestion[];
  messages?: ChatMessageItem[];
  report: Report | null;
};
type Report = {
  overall_score: number;
  summary: string;
  scores: Dimension[];
  strengths: string[];
  improvements: string[];
  priority: string;
  recommendations: string[];
  example: string;
  questions: {
    question: string;
    answer: InterviewQuestion["answer"];
    evaluation: Evaluation;
    revisions: InterviewQuestion["revisions"];
  }[];
  rubric_version: string;
  generated_at: string;
};
type Profile = {
  name: string;
  target_role: string;
  experience_level: string;
  skills: string[];
};
type ProgressData = {
  completed_count: number;
  average_score: number | null;
  interview_types: string[];
  trends: (Dimension & { values: { session_id: string; date: string; score: number }[] })[];
  sessions: InterviewSession[];
  comparison_note: string;
};
type Notice = { kind: "error" | "success" | "info"; text: string };
type CoachStatus = { coach: "openrouter" | "groq" | "local"; model: string };

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL?.trim() || "https://eeqogkmkeuwjwmrcddad.supabase.co";
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || "sb_publishable_M_IHffoaILZ3rh5X1zmgLg_qLu9aHnv";
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() ?? "").replace(/\/+$/, "");
let apiAccessToken: string | null = null;

const SESSIONS_CACHE_KEY = "interviewiq_cached_sessions";

function getCachedSessions(): InterviewSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function cacheSession(session: InterviewSession) {
  try {
    const existing = getCachedSessions().filter((s) => s.id !== session.id);
    localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([session, ...existing].slice(0, 50)));
  } catch {}
}

function removeCachedSession(id: string) {
  try {
    const remaining = getCachedSessions().filter((s) => s.id !== id);
    localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify(remaining));
  } catch {}
}

async function restoreSessionIfNeeded(session: InterviewSession): Promise<boolean> {
  try {
    await request<InterviewSession>("/api/interviews/restore", {
      method: "POST",
      body: JSON.stringify(session),
    });
    return true;
  } catch {
    return false;
  }
}

const defaultProfile: Profile = {
  name: "Candidate",
  target_role: "",
  experience_level: "Intermediate",
  skills: [],
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (apiAccessToken) headers.set("Authorization", `Bearer ${apiAccessToken}`);
  const targetUrl = path.startsWith("http://") || path.startsWith("https://")
    ? path
    : `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(targetUrl, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      message = typeof body.detail === "string" ? body.detail : message;
    } catch {
      // Keep the HTTP status message when the server does not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

const formatDate = (date: string | null | undefined) =>
  date
    ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(date))
    : "In progress";

export default function App() {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authSetupError, setAuthSetupError] = useState<string | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [postAuthNotice, setPostAuthNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseUrl || !supabaseAnonKey) {
      setAuthSetupError("Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your local .env file, then restart the app.");
      setAuthReady(true);
      return;
    }

    let active = true;
    let unsubscribe: (() => void) | null = null;
    const initializeAuth = async () => {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        if (!active) return;
        const client = createClient(supabaseUrl, supabaseAnonKey, {
          auth: {
            autoRefreshToken: true,
            detectSessionInUrl: true,
            persistSession: true,
          },
        });
        setSupabase(client);
        const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
          apiAccessToken = session?.access_token ?? null;
          setAuthSession(session);
          if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
          if (event === "SIGNED_OUT") setPasswordRecovery(false);
        });
        unsubscribe = () => subscription.unsubscribe();
        const { data } = await client.auth.getSession();
        if (!active) return;
        apiAccessToken = data.session?.access_token ?? null;
        setAuthSession(data.session);
        setAuthReady(true);
      } catch {
        if (!active) return;
        setAuthSetupError("Supabase could not be initialized. Check your project URL and public key.");
        setAuthReady(true);
      }
    };
    void initializeAuth();
    return () => {
      active = false;
      unsubscribe?.();
      apiAccessToken = null;
    };
  }, []);

  if (!authReady) {
    return <div className="loading-screen"><LoaderCircle className="spin" size={26} /><span>Preparing secure sign in…</span></div>;
  }
  if (authSession && supabase && passwordRecovery) {
    return (
      <PasswordRecoveryPage
        supabase={supabase}
        onComplete={() => {
          setPasswordRecovery(false);
          setPostAuthNotice("Your password has been updated.");
        }}
      />
    );
  }
  if (!authSession || !supabase) {
    return (
      <LoginPage
        supabase={supabase}
        setupError={authSetupError}
        onAuthenticated={(session) => {
          apiAccessToken = session.access_token;
          setAuthSession(session);
        }}
      />
    );
  }
  return (
    <AuthenticatedApp
      initialNotice={postAuthNotice}
      onSignOut={async () => {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        apiAccessToken = null;
        setAuthSession(null);
        setPostAuthNotice(null);
      }}
    />
  );
}

function LoginPage({
  supabase,
  setupError,
  onAuthenticated,
}: {
  supabase: SupabaseClient | null;
  setupError: string | null;
  onAuthenticated: (session: Session) => void;
}) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const isSignup = mode === "signup";

  const switchMode = (next: "signup" | "signin") => {
    setMode(next);
    setMessage(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (!supabase) {
      setMessage({ kind: "error", text: "Connect Supabase to enable sign in and account creation." });
      return;
    }
    if (!email.trim() || !password) {
      setMessage({ kind: "error", text: "Enter your email and password to continue." });
      return;
    }
    if (isSignup && password.length < 8) {
      setMessage({ kind: "error", text: "Choose a password with at least 8 characters." });
      return;
    }

    setPending(true);
    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        setPassword("");
        if (data.session) {
          onAuthenticated(data.session);
        } else {
          setMessage({
            kind: "success",
            text: "This Supabase project currently requires email confirmation. To create accounts without it, turn off Confirm email in Authentication → Sign In / Providers → Email, save the change, then sign up again.",
          });
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        setPassword("");
        if (data.session) onAuthenticated(data.session);
      }
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      const safeMessage = message.includes("invalid login credentials")
        ? "That email and password don’t match. Check them and try again."
        : message.includes("email not confirmed")
          ? "Please confirm your email using the link in your inbox before signing in."
          : isSignup && message.includes("already registered")
            ? "An account with this email may already exist. Try signing in instead."
            : isSignup
              ? "We couldn’t create your account. Check your details and try again."
              : "We couldn’t sign you in. Check your details and try again.";
      setMessage({ kind: "error", text: safeMessage });
    } finally {
      setPending(false);
    }
  };

  const sendPasswordReset = async () => {
    setMessage(null);
    if (!supabase) {
      setMessage({ kind: "error", text: "Connect Supabase to enable password reset." });
      return;
    }
    if (!email.trim()) {
      setMessage({ kind: "error", text: "Enter your email first, then choose Forgot password." });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setMessage({ kind: "error", text: "Enter a valid email address before requesting a reset." });
      return;
    }
    setPending(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      if (error) throw error;
      setMessage({
        kind: "success",
        text: "If an account exists for that email, a password-reset link is on its way.",
      });
    } catch {
      setMessage({ kind: "error", text: "We couldn’t send a reset email. Please check the address and try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-glow auth-glow-one" />
      <div className="auth-glow auth-glow-two" />
      <a className="auth-brand" href="#" onClick={(event) => event.preventDefault()}>
        <span className="brand-mark"><MessageCircle size={20} strokeWidth={2.5} /></span>
        <span>interview<span className="brand-light">IQ</span></span>
      </a>
      <section className={`auth-card mode-${mode}`} aria-label="InterviewIQ account access">
        <form className="auth-form signup-form" aria-label="Create your account" aria-hidden={!isSignup} inert={!isSignup} onSubmit={submit}>
          <div className="auth-form-inner">
            <span className="auth-eyebrow"><span /> YOUR NEXT CHAPTER STARTS HERE</span>
            <h1>Create your account</h1>
            <p className="auth-description">A comfortable place to practice, grow, and show up with confidence.</p>
            <div className="auth-field">
              <label htmlFor="signup-email">Email address</label>
              <div className="auth-input-wrap"><Mail size={17} /><input id="signup-email" type="email" name="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
            </div>
            <div className="auth-field">
              <div className="auth-label-row"><label htmlFor="signup-password">Password</label><span>8+ characters</span></div>
              <div className="auth-input-wrap"><LockKeyhole size={17} /><input id="signup-password" type={showPassword ? "text" : "password"} name="new-password" autoComplete="new-password" placeholder="Create a password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /><button className="password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
            </div>
            {message && <AuthMessage message={message} />}
            {setupError && <div className="auth-setup-notice" role="status"><CircleHelp size={17} /><span><strong>One-time setup needed</strong>{setupError} See the README for Supabase setup.</span></div>}
            <button className="auth-submit" type="submit" disabled={pending || !supabase}>{pending ? <LoaderCircle className="spin" size={17} /> : null}{pending ? "Creating account…" : "Create account"}<ArrowRight size={17} /></button>
            <p className="auth-terms">By continuing, you agree to use InterviewIQ as a practice and coaching tool.</p>
          </div>
        </form>

        <form className="auth-form signin-form" aria-label="Sign in to your account" aria-hidden={isSignup} inert={isSignup} onSubmit={submit}>
          <div className="auth-form-inner">
            <span className="auth-eyebrow"><span /> GOOD TO HAVE YOU BACK</span>
            <h1>Welcome back</h1>
            <p className="auth-description">Pick up your practice right where you left off.</p>
            <div className="auth-field">
              <label htmlFor="signin-email">Email address</label>
              <div className="auth-input-wrap"><Mail size={17} /><input id="signin-email" type="email" name="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
            </div>
            <div className="auth-field">
              <div className="auth-label-row"><label htmlFor="signin-password">Password</label><button className="forgot-link" type="button" onClick={sendPasswordReset} disabled={pending}>Forgot password?</button></div>
              <div className="auth-input-wrap"><LockKeyhole size={17} /><input id="signin-password" type={showPassword ? "text" : "password"} name="current-password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button className="password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
            </div>
            {message && <AuthMessage message={message} />}
            {setupError && <div className="auth-setup-notice" role="status"><CircleHelp size={17} /><span><strong>One-time setup needed</strong>{setupError} See the README for Supabase setup.</span></div>}
            <button className="auth-submit" type="submit" disabled={pending || !supabase}>{pending ? <LoaderCircle className="spin" size={17} /> : null}{pending ? "Signing in…" : "Sign in"}<ArrowRight size={17} /></button>
            <p className="auth-terms">Your sessions belong to your account; external AI coaching is opt-in.</p>
          </div>
        </form>

        <div className={`auth-overlay ${isSignup ? "overlay-right" : "overlay-left"}`}>
          <div className="overlay-orbit orbit-a" /><div className="overlay-orbit orbit-b" />
          <div className="overlay-content">
            <span className="overlay-mark"><Sparkles size={21} /></span>
            {isSignup ? (
              <>
                <span className="overlay-kicker">ALREADY PRACTICING?</span>
                <h2>Welcome<br />back.</h2>
                <p>Your next great answer starts with one small step. Let’s keep going.</p>
                <button type="button" className="overlay-switch" onClick={() => switchMode("signin")}>SIGN IN <ArrowRight size={15} /></button>
              </>
            ) : (
              <>
                <span className="overlay-kicker">NEW TO INTERVIEWIQ?</span>
                <h2>Make room<br />to grow.</h2>
                <p>Start a thoughtful practice habit and feel a little more ready each time.</p>
                <button type="button" className="overlay-switch" onClick={() => switchMode("signup")}>SIGN UP <ArrowRight size={15} /></button>
              </>
            )}
          </div>
          <span className="overlay-caption"><LockKeyhole size={12} /> YOUR PRACTICE, YOUR PACE</span>
        </div>
      </section>
      <p className="auth-footer"><LockKeyhole size={13} /> Secure email sign-in · No social accounts connected</p>
    </main>
  );
}

function AuthMessage({ message }: { message: { kind: "success" | "error"; text: string } }) {
  return <div className={`auth-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</div>;
}

function PasswordRecoveryPage({ supabase, onComplete }: {
  supabase: SupabaseClient;
  onComplete: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const updatePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (password.length < 8) {
      setMessage({ kind: "error", text: "Choose a password with at least 8 characters." });
      return;
    }
    if (password !== confirmPassword) {
      setMessage({ kind: "error", text: "Those passwords don’t match. Please try again." });
      return;
    }
    setPending(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      onComplete();
    } catch {
      setMessage({ kind: "error", text: "We couldn’t update your password. Please request a new reset link and try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-page recovery-page">
      <a className="auth-brand" href="#" onClick={(event) => event.preventDefault()}>
        <span className="brand-mark"><MessageCircle size={20} strokeWidth={2.5} /></span>
        <span>interview<span className="brand-light">IQ</span></span>
      </a>
      <form className="recovery-card" onSubmit={updatePassword}>
        <span className="recovery-icon"><LockKeyhole size={21} /></span>
        <span className="auth-eyebrow"><span /> ACCOUNT SECURITY</span>
        <h1>Choose a new password</h1>
        <p>Use at least 8 characters. You’ll be signed in after your password is updated.</p>
        <div className="auth-field"><label htmlFor="recovery-password">New password</label><div className="auth-input-wrap"><LockKeyhole size={17} /><input id="recovery-password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></div></div>
        <div className="auth-field"><label htmlFor="recovery-confirm">Confirm new password</label><div className="auth-input-wrap"><LockKeyhole size={17} /><input id="recovery-confirm" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div></div>
        {message && <AuthMessage message={message} />}
        <button className="auth-submit" type="submit" disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : null}{pending ? "Updating password…" : "Update password"}<ArrowRight size={17} /></button>
      </form>
      <p className="auth-footer"><LockKeyhole size={13} /> Secure email sign-in · No social accounts connected</p>
    </main>
  );
}

function AuthenticatedApp({ onSignOut, initialNotice }: { onSignOut: () => Promise<void>; initialNotice: string | null }) {
  const [page, setPage] = useState<Page>("home");
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [activeSession, setActiveSession] = useState<InterviewSession | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [coachStatus, setCoachStatus] = useState<CoachStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(() =>
    initialNotice ? { kind: "success", text: initialNotice } : null,
  );
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = async () => {
    const [nextProfile, nextSessions, nextProgress, nextCoachStatus] = await Promise.all([
      request<Profile>("/api/profile").catch(() => null),
      request<InterviewSession[]>("/api/interviews").catch(() => []),
      request<ProgressData>("/api/progress").catch(() => null),
      request<CoachStatus>("/api/health").catch(() => null),
    ]);
    if (nextProfile) setProfile(nextProfile);

    // Merge server sessions with client-cached sessions
    const cached = getCachedSessions();
    const map = new Map<string, InterviewSession>();
    for (const s of cached) map.set(s.id, s);
    if (Array.isArray(nextSessions)) {
      for (const s of nextSessions) {
        map.set(s.id, s);
        cacheSession(s);
      }
    }
    const merged = Array.from(map.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
    setSessions(merged);

    if (nextProgress) setProgress(nextProgress);
    if (nextCoachStatus) setCoachStatus(nextCoachStatus);
  };

  useEffect(() => {
    refresh()
      .catch((error: Error) => setNotice({ kind: "error", text: error.message }))
      .finally(() => setReady(true));
  }, []);

  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status === "active"),
    [sessions],
  );

  const navigate = (next: Page) => {
    setNotice(null);
    setPage(next);
  };

  const openSession = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      let session: InterviewSession;
      try {
        session = await request<InterviewSession>(`/api/interviews/${id}`);
      } catch (err) {
        // If container recycled, attempt auto-restore from cache
        const local = getCachedSessions().find((s) => s.id === id);
        if (local) {
          await restoreSessionIfNeeded(local);
          session = local;
        } else {
          throw err;
        }
      }
      if (session.status === "draft") {
        session = await request<InterviewSession>(`/api/interviews/${id}/start`, { method: "POST" });
      }
      cacheSession(session);
      setActiveSession(session);
      setPage("interview");
    } catch (error) {
      removeCachedSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setNotice({
        kind: "info",
        text: "That previous practice session expired from server memory. Click 'New practice' to start a fresh interview!",
      });
    } finally {
      setBusy(false);
    }
  };

  const openReport = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      let nextSession: InterviewSession;
      let nextReport: Report;
      try {
        [nextSession, nextReport] = await Promise.all([
          request<InterviewSession>(`/api/interviews/${id}`),
          request<Report>(`/api/interviews/${id}/report`),
        ]);
      } catch (err) {
        const local = getCachedSessions().find((s) => s.id === id);
        if (local && local.report) {
          await restoreSessionIfNeeded(local);
          nextSession = local;
          nextReport = local.report;
        } else {
          throw err;
        }
      }
      cacheSession(nextSession);
      setActiveSession(nextSession);
      setReport(nextReport);
      setPage("report");
    } catch (error) {
      removeCachedSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setNotice({
        kind: "info",
        text: "That session report expired from server memory. Click 'New practice' to start a fresh interview!",
      });
    } finally {
      setBusy(false);
    }
  };

  const sendChatMessage = async (text: string) => {
    if (!activeSession) return;
    setBusy(true);
    setNotice(null);
    try {
      let updated: InterviewSession;
      try {
        updated = await request<InterviewSession>(`/api/interviews/${activeSession.id}/chat`, {
          method: "POST",
          body: JSON.stringify({ message: text }),
        });
      } catch (err) {
        if ((err as Error).message.includes("not found")) {
          await restoreSessionIfNeeded(activeSession);
          updated = await request<InterviewSession>(`/api/interviews/${activeSession.id}/chat`, {
            method: "POST",
            body: JSON.stringify({ message: text }),
          });
        } else {
          throw err;
        }
      }
      cacheSession(updated);
      setActiveSession(updated);
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const completeSession = async () => {
    if (!activeSession) return;
    setBusy(true);
    setNotice(null);
    try {
      let completed: InterviewSession;
      try {
        completed = await request<InterviewSession>(`/api/interviews/${activeSession.id}/complete`, {
          method: "POST",
        });
      } catch (err) {
        if ((err as Error).message.includes("not found")) {
          await restoreSessionIfNeeded(activeSession);
          completed = await request<InterviewSession>(`/api/interviews/${activeSession.id}/complete`, {
            method: "POST",
          });
        } else {
          throw err;
        }
      }
      cacheSession(completed);
      setActiveSession(completed);
      setReport(completed.report);
      await refresh();
      setPage("report");
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const submitRevision = async (questionId: string, text: string) => {
    const revision = await request<InterviewQuestion["revisions"][number]>(
      `/api/answers/${questionId}/revision`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    if (!activeSession) return;
    const updated = await request<InterviewSession>(`/api/interviews/${activeSession.id}`);
    const updatedReport = await request<Report>(`/api/interviews/${activeSession.id}/report`);
    setActiveSession(updated);
    setReport(updatedReport);
    await refresh();
    return revision;
  };

  if (!ready) {
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" size={26} />
        <span>Getting your practice space ready…</span>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); navigate("home"); }}>
          <span className="brand-mark"><MessageCircle size={20} strokeWidth={2.5} /></span>
          <span>interview<span className="brand-light">IQ</span></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <NavItem icon={<Home size={18} />} label="Overview" active={page === "home"} onClick={() => navigate("home")} />
          <NavItem icon={<Sparkles size={18} />} label="Practice" active={page === "setup" || page === "interview"} onClick={() => navigate("setup")} />
          <NavItem icon={<History size={18} />} label="My sessions" active={page === "history"} onClick={() => navigate("history")} />
          <NavItem icon={<BarChart3 size={18} />} label="Progress" active={page === "progress"} onClick={() => navigate("progress")} />
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <div className="tip-icon"><Lightbulb size={17} /></div>
            <strong>A little practice goes a long way</strong>
            <p>Your practice is stored on this computer. Sharing answers with AI is optional.</p>
            <button className="text-button" onClick={() => navigate("setup")}>Start a session <ArrowRight size={14} /></button>
          </div>
          <button className={`profile-shortcut ${page === "profile" ? "selected" : ""}`} onClick={() => navigate("profile")}>
            <span className="avatar">{(profile.name || "C").slice(0, 1).toUpperCase()}</span>
            <span className="profile-shortcut-copy"><strong>{profile.name || "Candidate"}</strong><small>{profile.target_role || "Your profile"}</small></span>
            <Settings2 size={16} className="shortcut-settings" />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>InterviewIQ</span><span className="crumb-slash">/</span><strong>{pageTitle(page)}</strong></div>
          <div className="topbar-right">
            <span className="demo-pill"><span />{coachStatus?.coach === "groq" ? "Groq AI configured" : coachStatus?.coach === "openrouter" ? "OpenRouter configured" : "Local coach"}</span>
            <button className="icon-button help-button" aria-label="About this prototype" onClick={() => setNotice({ kind: "info", text: coachStatus?.coach === "groq" ? `Groq AI (${coachStatus.model}) is available by opt-in. Opting in sends your role, questions, and answers to Groq; otherwise, coaching runs locally. Sessions are stored on this computer.` : coachStatus?.coach === "openrouter" ? `OpenRouter AI (${coachStatus.model}) is available by opt-in. Opting in sends your role, questions, and answers to OpenRouter; otherwise, coaching runs locally. Sessions are stored on this computer.` : "InterviewIQ uses local question templates and rule-based coaching. Your session data is stored on this computer." })}>
              <CircleHelp size={18} />
            </button>
          </div>
        </header>

        {notice && <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />}

        {page === "home" && (
          <Dashboard
            profile={profile}
            sessions={sessions}
            progress={progress}
            activeSessions={activeSessions}
            busy={busy}
            onStart={() => navigate("setup")}
            onResume={openSession}
            onOpenReport={openReport}
            onViewHistory={() => navigate("history")}
          />
        )}
        {page === "setup" && (
          <SetupPage
            profile={profile}
            busy={busy}
            coachStatus={coachStatus}
            onBack={() => navigate("home")}
            onStart={async (config) => {
              setBusy(true);
              setNotice(null);
              try {
                const session = await request<InterviewSession>("/api/interviews", {
                  method: "POST",
                  body: JSON.stringify({ ...config, auto_start: true }),
                });
                cacheSession(session);
                setActiveSession(session);
                setPage("interview");
                await refresh();
              } catch (error) {
                setNotice({ kind: "error", text: (error as Error).message });
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {page === "interview" && activeSession && (
          <InterviewPage
            session={activeSession}
            profile={profile}
            busy={busy}
            onAnswer={async (questionId, text) => {
              setBusy(true);
              setNotice(null);
              try {
                let result: { session: InterviewSession; next_action: string };
                try {
                  result = await request<{ session: InterviewSession; next_action: string }>(
                    `/api/interviews/${activeSession.id}/answers`,
                    { method: "POST", body: JSON.stringify({ question_id: questionId, text }) },
                  );
                } catch (err) {
                  if ((err as Error).message.includes("not found")) {
                    await restoreSessionIfNeeded(activeSession);
                    result = await request<{ session: InterviewSession; next_action: string }>(
                      `/api/interviews/${activeSession.id}/answers`,
                      { method: "POST", body: JSON.stringify({ question_id: questionId, text }) },
                    );
                  } else {
                    throw err;
                  }
                }
                cacheSession(result.session);
                setActiveSession(result.session);
                setNotice({
                  kind: "success",
                  text: result.next_action === "follow_up"
                    ? "Answer saved. Your coach has one follow-up to help you add detail."
                    : result.next_action === "complete"
                      ? "Answer saved. You're ready to finish and see your feedback."
                      : "Answer saved. Here's the next question.",
                });
                await refresh();
              } catch (error) {
                const message = (error as Error).message;
                setNotice({ kind: "error", text: `${message} Your answer remains available here; retry when ready.` });
              } finally {
                setBusy(false);
              }
            }}
            onSkip={async () => {
              setBusy(true);
              try {
                let updated: InterviewSession;
                try {
                  updated = await request<InterviewSession>(`/api/interviews/${activeSession.id}/skip`, { method: "POST" });
                } catch (err) {
                  if ((err as Error).message.includes("not found")) {
                    await restoreSessionIfNeeded(activeSession);
                    updated = await request<InterviewSession>(`/api/interviews/${activeSession.id}/skip`, { method: "POST" });
                  } else {
                    throw err;
                  }
                }
                cacheSession(updated);
                setActiveSession(updated);
              } catch (error) {
                const message = (error as Error).message;
                setNotice({ kind: "error", text: `${message} Retry to continue this session.` });
              } finally {
                setBusy(false);
              }
            }}
            onSendMessage={sendChatMessage}
            onFinish={completeSession}
            onLeave={() => { setActiveSession(null); navigate("home"); }}
          />
        )}
        {page === "report" && activeSession && report && (
          <ReportPage
            session={activeSession}
            report={report}
            onBack={() => navigate("history")}
            onPracticeAgain={() => navigate("setup")}
            onRevision={submitRevision}
            onNotice={(next) => setNotice(next)}
          />
        )}
        {page === "history" && (
          <HistoryPage sessions={sessions} onOpenReport={openReport} onResume={openSession} onStart={() => navigate("setup")} />
        )}
        {page === "progress" && <ProgressPage data={progress} onStart={() => navigate("setup")} />}
        {page === "profile" && (
          <ProfilePage
            profile={profile}
            busy={busy}
            onSignOut={onSignOut}
            onSave={async (next) => {
              setBusy(true);
              try {
                const saved = await request<Profile>("/api/profile", { method: "PUT", body: JSON.stringify(next) });
                setProfile(saved);
                setNotice({ kind: "success", text: "Profile updated." });
              } catch (error) {
                setNotice({ kind: "error", text: (error as Error).message });
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
      </main>
      {busy && <div className="busy-indicator"><LoaderCircle className="spin" size={17} /> Saving</div>}
    </div>
  );
}

function pageTitle(page: Page) {
  const titles: Record<Page, string> = {
    home: "Overview",
    setup: "New practice",
    interview: "Interview room",
    report: "Session feedback",
    history: "My sessions",
    progress: "Progress",
    profile: "Your profile",
  };
  return titles[page];
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{active && <span className="nav-active-dot" />}</button>;
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  useEffect(() => {
    if (notice.kind === "success" || notice.kind === "info") {
      const timer = setTimeout(onDismiss, 6000);
      return () => clearTimeout(timer);
    }
  }, [notice, onDismiss]);

  return (
    <div className={`notice-banner ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.kind === "success" ? <CheckCircle2 size={18} /> : notice.kind === "error" ? <X size={18} /> : <CircleHelp size={18} />}
      <span>{notice.text}</span>
      <button onClick={onDismiss} aria-label="Dismiss message"><X size={16} /></button>
    </div>
  );
}

function Dashboard({
  profile, sessions, progress, activeSessions, busy, onStart, onResume, onOpenReport, onViewHistory,
}: {
  profile: Profile;
  sessions: InterviewSession[];
  progress: ProgressData | null;
  activeSessions: InterviewSession[];
  busy: boolean;
  onStart: () => void;
  onResume: (id: string) => void;
  onOpenReport: (id: string) => void;
  onViewHistory: () => void;
}) {
  const recent = [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3);
  return (
    <div className="page-content dashboard-page">
      <section className="welcome-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR PRACTICE SPACE</div>
          <h1>Good to see you, {profile.name?.split(" ")[0] || "there"}.</h1>
          <p className="page-subtitle">A little preparation can make a big difference. Ready when you are.</p>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-ring ring-one" /><div className="art-ring ring-two" />
          <div className="art-card"><MessageCircle size={25} /><span>You've got this.</span><i /></div>
        </div>
      </section>

      {activeSessions.length > 0 && (
        <section className="resume-card">
          <div className="resume-icon"><BookmarkCheck size={19} /></div>
          <div className="resume-copy">
            <strong>Pick up where you left off</strong>
            <span>{activeSessions[0].config.role} · {activeSessions[0].primary_question_count} of {activeSessions[0].question_limit} questions</span>
          </div>
          <button className="button button-outline" disabled={busy} onClick={() => onResume(activeSessions[0].id)}>Resume session <ArrowRight size={16} /></button>
        </section>
      )}

      <section className="section-heading">
        <div><h2>Your practice at a glance</h2><p>Every session is a step forward.</p></div>
        <button className="button button-primary" onClick={onStart}><Plus size={17} /> New practice</button>
      </section>
      <div className="stats-grid">
        <StatCard icon={<MessageCircle size={18} />} label="Sessions completed" value={String(progress?.completed_count ?? 0)} foot="Keep showing up" tone="sage" />
        <StatCard icon={<Target size={18} />} label="Average score" value={progress?.average_score == null ? "—" : `${progress.average_score}%`} foot={progress && progress.interview_types.length > 1 ? "Different rubrics are not averaged" : "Within one interview type"} tone="lavender" />
        <StatCard icon={<Clock3 size={18} />} label="Planned minutes" value={`${completedSessionsMinutes(sessions)} min`} foot="Across completed sessions" tone="sand" />
      </div>

      <div className="dashboard-columns">
        <section className="panel recent-panel">
          <div className="panel-heading"><div><h2>Recent sessions</h2><p>Your latest practice, all in one place.</p></div><button className="link-button" onClick={onViewHistory}>View all <ArrowRight size={14} /></button></div>
          {recent.length === 0 ? (
            <EmptyState icon={<FileText size={22} />} title="Your story starts here" text="Start a practice session and your history will show up here." action="Start practicing" onClick={onStart} />
          ) : (
            <div className="session-list">
              {recent.map((session) => (
                <button className="session-row" key={session.id} onClick={() => session.status === "completed" ? onOpenReport(session.id) : onResume(session.id)}>
                  <span className={`session-symbol ${session.status}`}><MessageCircle size={17} /></span>
                  <span className="session-row-main"><strong>{session.config.role}</strong><small>{session.config.interview_type} <span>·</span> {formatDate(session.completed_at || session.created_at)} <span>·</span> {session.config.difficulty}</small></span>
                  {session.status === "completed" && session.report ? <span className="session-score">{session.report.overall_score}<small>/100</small></span> : <span className="status-tag">{session.status === "active" ? "In progress" : "Draft"}</span>}
                  <ArrowRight size={15} className="row-arrow" />
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="practice-card">
          <div className="practice-card-icon"><Sparkles size={20} /></div>
          <span className="mini-label">A GENTLE REMINDER</span>
          <h2>Tell the story,<br />not just the headline.</h2>
          <p>For behavioral questions, try STAR: describe the situation, your task, the actions you took, and the result.</p>
          <button className="text-button" onClick={onStart}>Try a practice question <ArrowRight size={14} /></button>
          <div className="practice-decoration" aria-hidden="true">✳</div>
        </section>
      </div>
      <div className="demo-disclaimer"><CircleHelp size={15} /> Coaching is local unless you opt in to AI coaching for a session. Scores are practice guidance, not a validated assessment.</div>
    </div>
  );
}

function completedSessionsMinutes(sessions: InterviewSession[]) {
  return sessions.filter((session) => session.status === "completed").reduce((total, session) => total + session.config.duration_minutes, 0);
}

function StatCard({ icon, label, value, foot, tone }: { icon: React.ReactNode; label: string; value: string; foot: string; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong><small>{foot}</small></div>;
}

function EmptyState({ icon, title, text, action, onClick }: { icon: React.ReactNode; title: string; text: string; action: string; onClick: () => void }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{text}</p><button className="text-button" onClick={onClick}>{action} <ArrowRight size={14} /></button></div>;
}

function SetupPage({ profile, busy, coachStatus, onBack, onStart }: {
  profile: Profile;
  busy: boolean;
  coachStatus: CoachStatus | null;
  onBack: () => void;
  onStart: (config: InterviewSession["config"]) => void;
}) {
  const [role, setRole] = useState(profile.target_role || "Product Manager");
  const [difficulty, setDifficulty] = useState("Intermediate");
  const [duration, setDuration] = useState(15);
  const [interviewType, setInterviewType] = useState<"Behavioral" | "Technical">("Behavioral");
  const [focus, setFocus] = useState("Mixed");
  const [aiConsent, setAiConsent] = useState(true);
  const [mode, setMode] = useState<"structured" | "conversational">("conversational");
  const [roleError, setRoleError] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!role.trim()) {
      setRoleError("Add a role so the questions can be relevant to you.");
      return;
    }
    setRoleError("");
    onStart({
      role: role.trim(),
      interview_type: interviewType,
      difficulty,
      duration_minutes: duration,
      focus_competency: focus,
      ai_consent: aiConsent,
      mode,
    });
  };
  const focusOptions = interviewType === "Technical"
    ? ["Mixed", "Algorithms & data structures", "System design", "Debugging & testing", "APIs & backend", "Frontend", "Databases"]
    : ["Mixed", "Problem-solving", "Collaboration", "Ownership", "Adaptability", "Communication", "Leadership"];

  return (
    <div className="page-content narrow-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to overview</button>
      <div className="page-intro"><div className="eyebrow"><span className="eyebrow-line" /> MAKE IT YOURS</div><h1>Set up your practice</h1><p>Choose a few details so your questions feel relevant to the role you’re preparing for.</p></div>
      <form className="setup-form panel" onSubmit={submit}>
        <div className="form-section-title"><span className="form-step">01</span><div><h2>Interview details</h2><p>What are you getting ready for?</p></div></div>
        <label className="field-label" htmlFor="role">Target role <span className="required">*</span></label>
        <input id="role" className={`text-input ${roleError ? "input-error" : ""}`} value={role} onChange={(event) => { setRole(event.target.value); setRoleError(""); }} placeholder="e.g. Product Manager" maxLength={120} />
        {roleError && <span className="field-error">{roleError}</span>}
        <div className="form-grid two-col">
          <div><label className="field-label" htmlFor="interview-type">Interview type</label><div className="select-wrap"><select id="interview-type" value={interviewType} onChange={(event) => { const selected = event.target.value; if (selected === "Behavioral" || selected === "Technical") setInterviewType(selected); setFocus("Mixed"); }}><option>Behavioral</option><option>Technical</option></select><ChevronDown size={16} /></div><small className="field-hint">Choose behavioral storytelling or technical problem solving.</small></div>
          <div><label className="field-label" htmlFor="difficulty">Difficulty</label><div className="select-wrap"><select id="difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select><ChevronDown size={16} /></div></div>
        </div>
        <div className="form-divider" />
        <div className="form-section-title"><span className="form-step">02</span><div><h2>Make it personal</h2><p>Set the pace and pick a focus.</p></div></div>
        <label className="field-label">How much time do you have?</label>
        <div className="choice-row">
          {[15, 30, 45].map((minutes) => (
            <button type="button" className={`choice-card ${duration === minutes ? "chosen" : ""}`} key={minutes} onClick={() => setDuration(minutes)}>
              <Clock3 size={17} /><strong>{minutes} min</strong><small>{minutes === 15 ? "Quick practice" : minutes === 30 ? "A deeper run" : "Full practice"}</small>{duration === minutes && <Check size={15} className="choice-check" />}
            </button>
          ))}
        </div>
        <label className="field-label focus-label" htmlFor="focus">{interviewType === "Technical" ? "Technical focus" : "Focus competency"} <span className="optional">(optional)</span></label>
        <div className="select-wrap"><select id="focus" value={focus} onChange={(event) => setFocus(event.target.value)}>{focusOptions.map((option) => <option key={option}>{option}</option>)}</select><ChevronDown size={16} /></div>
        <div className="form-divider" />
        <div className="form-section-title"><span className="form-step">03</span><div><h2>Practice format</h2><p>How would you like your interview to feel?</p></div></div>
        <div className="mode-toggle-group">
          <button
            type="button"
            className={`mode-card ${mode === "conversational" ? "selected" : ""}`}
            onClick={() => setMode("conversational")}
          >
            <div className="mode-header"><MessageCircle size={18} className="mode-icon-accent" /> <span>Conversational Mode</span> <span className="recommended-badge">RECOMMENDED</span></div>
            <div className="mode-desc">Natural human dialogue. Banter, ask clarifying questions, and discuss trade-offs in real time. Comprehensive scorecard at the end.</div>
          </button>
          <button
            type="button"
            className={`mode-card ${mode === "structured" ? "selected" : ""}`}
            onClick={() => setMode("structured")}
          >
            <div className="mode-header"><Target size={18} /> <span>Structured Practice</span></div>
            <div className="mode-desc">Step-by-step interview questions. Get immediate rubric scores and follow-ups after each individual answer.</div>
          </button>
        </div>
        <div className="coach-consent active-consent">
          <label>
            <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />
            <span>
              <strong>⚡ Interactive Groq AI Interviewer Active ({coachStatus?.coach === "groq" ? (coachStatus.model || "qwen/qwen3.8-27b") : "Groq AI"})</strong>
              <small>Real-time conversational intelligence powered by Groq LPU. Dynamic scenario generation, natural greetings, interactive trade-off probing, and comprehensive end-of-interview scorecard.</small>
            </span>
          </label>
        </div>
        <button className="button button-primary button-wide" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} Start my interview <ArrowRight size={16} /></button>
      </form>
    </div>
  );
}

function InterviewPage({ session, profile, busy, onAnswer, onSkip, onSendMessage, onFinish, onLeave }: {
  session: InterviewSession;
  profile: Profile;
  busy: boolean;
  onAnswer: (questionId: string, text: string) => void;
  onSkip: () => void;
  onSendMessage?: (text: string) => void;
  onFinish: () => void;
  onLeave: () => void;
}) {
  const isConversational = session.config.mode === "conversational";
  const [chatInput, setChatInput] = useState("");
  const chatStreamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (chatStreamRef.current) {
      chatStreamRef.current.scrollTop = chatStreamRef.current.scrollHeight;
    }
  }, [session.messages?.length, busy]);

  const handleSendChat = (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (!chatInput.trim() || busy || !onSendMessage) return;
    onSendMessage(chatInput.trim());
    setChatInput("");
  };

  const insertPromptChip = (chipText: string) => {
    setChatInput((prev) => (prev ? `${prev} ${chipText}` : chipText));
  };

  if (isConversational) {
    const messages = session.messages || [];
    const userMessageCount = messages.filter((m) => m.role === "user").length;
    return (
      <div className="interview-page convo-room">
        <div className="interview-topline">
          <button className="back-link" onClick={onLeave}><ArrowLeft size={15} /> Leave interview</button>
          <span className="live-status"><span /> LIVE INTERVIEW · CONVERSATIONAL MODE</span>
          <button className="button convo-finish-btn" onClick={onFinish} disabled={busy}>
            <Sparkles size={15} /> Conclude & Get Scorecard
          </button>
        </div>

        <div className="interview-heading">
          <div>
            <span className="eyebrow">{session.config.interview_type.toUpperCase()} · {session.config.role.toUpperCase()}</span>
            <h1>{session.config.interview_type === "Technical" ? "Interactive Technical Discussion" : "Conversational Behavioral Interview"}</h1>
            <p>Converse naturally with your interviewer. Clarify constraints, debate architecture, and explore trade-offs. Your comprehensive evaluation will be generated upon concluding.</p>
          </div>
          <div className="question-count">
            <strong>{userMessageCount.toString().padStart(2, "0")}</strong>
            <span> exchanges</span>
          </div>
        </div>

        <div className="convo-stream-box" ref={chatStreamRef}>
          {messages.map((msg) => (
            <div className={`convo-bubble-row ${msg.role}`} key={msg.id}>
              <div className="convo-avatar">
                {msg.role === "assistant" ? <Sparkles size={16} /> : (profile.name?.slice(0, 1).toUpperCase() || "Y")}
              </div>
              <div className="convo-bubble-content">
                <span className="convo-bubble-sender">
                  {msg.role === "assistant" ? "AI STAFF INTERVIEWER" : "YOU"}
                </span>
                <div className="convo-bubble-text">{msg.content}</div>
              </div>
            </div>
          ))}

          {busy && (
            <div className="convo-typing-indicator">
              <LoaderCircle className="spin" size={15} />
              <span>Interviewer is thinking and formulating response…</span>
            </div>
          )}
        </div>

        <form className="convo-composer-card" onSubmit={handleSendChat}>
          <div className="convo-chip-row">
            <span className="convo-chip" onClick={() => insertPromptChip("Could you clarify the scale, latency budget, and constraints?")}>
              💡 Clarify constraints & scale
            </span>
            <span className="convo-chip" onClick={() => insertPromptChip("Let me outline my high-level architecture approach:")}>
              💡 High-level architecture
            </span>
            <span className="convo-chip" onClick={() => insertPromptChip("What are the key trade-offs and failure modes to prioritize?")}>
              💡 Trade-offs & failure modes
            </span>
          </div>

          <textarea
            className="convo-textarea"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSendChat();
              }
            }}
            placeholder="Ask a clarifying question, discuss constraints, or explain your approach (Press Ctrl+Enter or click Send)…"
            maxLength={5000}
            disabled={busy}
          />

          <div className="convo-composer-actions">
            <span className="composer-help">
              <Lightbulb size={13} /> Discuss freely. When you are satisfied with your answer, click <strong>Conclude & Get Scorecard</strong>.
            </span>
            <button type="submit" className="button button-primary send-button" disabled={busy || !chatInput.trim()}>
              <Send size={15} /> Send message
            </button>
          </div>
        </form>
      </div>
    );
  }
  const [answer, setAnswer] = useState("");
  const currentQuestion = session.questions[session.questions.length - 1];
  const isWaiting = currentQuestion && !currentQuestion.answer && !currentQuestion.skipped;
  const canRetryAnswer = Boolean(
    currentQuestion?.answer &&
    (!currentQuestion.evaluation || session.continuation_pending),
  );
  const canRetrySkip = Boolean(currentQuestion?.skipped && session.continuation_pending);
  const canFinish = session.primary_question_count >= session.question_limit &&
    !isWaiting && !canRetryAnswer && !canRetrySkip;
  const answered = session.questions.filter((question) => question.answer);
  const progressPercent = Math.min(100, Math.round((session.primary_question_count / session.question_limit) * 100));

  useEffect(() => setAnswer(currentQuestion?.answer?.text ?? ""), [currentQuestion?.id, currentQuestion?.answer?.text]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentQuestion || !answer.trim()) return;
    onAnswer(currentQuestion.id, answer.trim());
  };

  return (
    <div className="interview-page">
      <div className="interview-topline">
        <button className="back-link" onClick={onLeave}><ArrowLeft size={15} /> Leave session</button>
        <span className="live-status"><span /> SESSION IN PROGRESS</span>
        <button className="button button-soft" onClick={onFinish} disabled={busy || canRetryAnswer || canRetrySkip}>Finish interview <X size={15} /></button>
      </div>
      <div className="interview-heading">
        <div><span className="eyebrow">{session.config.interview_type.toUpperCase()} PRACTICE · {session.config.role.toUpperCase()}</span><h1>{session.config.interview_type === "Technical" ? "Think it through, step by step." : "Take a breath. You’ve got this."}</h1><p>{session.config.interview_type === "Technical" ? "Explain your assumptions, reasoning, and how you would verify the solution." : "Think of a real example, then tell the story in your own words."}</p></div>
        <div className="question-count"><strong>{Math.min(session.primary_question_count, session.question_limit).toString().padStart(2, "0")}</strong><span> / {session.question_limit.toString().padStart(2, "0")} questions</span></div>
      </div>
      <div className="session-progress"><div style={{ width: `${progressPercent}%` }} /></div>
      <div className="interview-layout">
        <section className="conversation-panel">
          <div className="conversation-meta"><span><MessageCircle size={15} /> Conversation</span><span>{session.config.ai_consent ? "AI coach" : "Local coach"} · {session.config.difficulty} · {session.config.duration_minutes} min</span></div>
          <div className="conversation-scroll">
            {answered.map((question, index) => (
              <div className="past-turn" key={question.id}>
                <div className="message ai-message"><span className="coach-avatar"><Sparkles size={14} /></span><div><small>{question.kind === "follow_up" ? "FOLLOW-UP" : `QUESTION ${String(index + 1).padStart(2, "0")}`}</small><p>{question.text}</p></div></div>
                <div className="message candidate-message">
                  <span className="candidate-avatar">{profile.name.trim().slice(0, 1).toUpperCase() || "Y"}</span>
                  <div>
                    <small>YOU</small>
                    <p>{question.answer?.text}</p>
                    {question.evaluation && (
                      <div className="evaluation-card">
                        <div className="evaluation-top">
                          <span className={`verdict-pill ${question.evaluation.review_verdict || (question.evaluation.is_relevant === false ? "incorrect_or_off_topic" : "correct_and_relevant")}`}>
                            {question.evaluation.review_verdict === "incorrect_or_off_topic" || question.evaluation.is_relevant === false
                              ? "✕ Off-topic / Needs Revision"
                              : question.evaluation.review_verdict === "partially_correct"
                              ? "⚠ Partially Relevant"
                              : "✓ On-topic & Sound"}
                          </span>
                          <span className="inline-score"><CheckCircle2 size={13} /> Saved · {question.evaluation.overall_score}/100 practice score</span>
                        </div>
                        {question.evaluation.relevance_feedback && (
                          <p className="evaluation-feedback">{question.evaluation.relevance_feedback}</p>
                        )}
                        {question.evaluation.model_answer && (
                          <details className="model-answer-details">
                            <summary><Lightbulb size={13} /> {question.evaluation.review_verdict === "incorrect_or_off_topic" ? "View correct model answer" : "View exemplary benchmark answer"}</summary>
                            <div className="model-answer-body">{question.evaluation.model_answer}</div>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {isWaiting && (
              <div className="message ai-message current-message"><span className="coach-avatar"><Sparkles size={14} /></span><div><small>{currentQuestion.kind === "follow_up" ? "A QUICK FOLLOW-UP" : `QUESTION ${String(session.primary_question_count).padStart(2, "0")}`}</small><p>{currentQuestion.text}</p><span className="competency-chip"><Target size={12} /> {currentQuestion.competency}</span></div></div>
            )}
            {canFinish && <div className="end-of-questions"><CheckCircle2 size={19} /><div><strong>You’ve answered all your questions.</strong><span>Take a moment, then finish to see your feedback.</span></div></div>}
          </div>
          {isWaiting || canRetryAnswer ? (
            <form className="answer-composer" onSubmit={submit}>
              <label htmlFor="candidate-answer">{canRetryAnswer ? "Saved answer — retry to continue" : "Your answer"}</label>
              {canRetryAnswer && <p className="retry-note">Your answer is saved on this computer. Retry sends the same answer for feedback and continues the interview.</p>}
              <textarea id="candidate-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={session.config.interview_type === "Technical" ? "Explain your approach, assumptions, trade-offs, and how you would test it…" : "Start wherever feels natural. You can include the situation, what you did, and how it turned out…"} maxLength={5000} autoComplete="off" disabled={canRetryAnswer} />
              <div className="composer-footer"><span>{answer.length} / 5,000</span><span className="composer-help"><Lightbulb size={13} />{session.config.interview_type === "Technical" ? "Explain your reasoning; scores are practice guidance" : "Specific examples help you get more useful feedback"}</span><div>{!canRetryAnswer && <button type="button" className="skip-button" disabled={busy} onClick={onSkip}>Skip</button>}<button type="submit" className="button button-primary send-button" disabled={busy || !answer.trim()}><Send size={15} /> {canRetryAnswer ? "Retry / Continue" : "Send answer"}</button></div></div>
            </form>
          ) : canRetrySkip ? (
            <div className="finish-footer"><span>Your question was skipped. Retry to load the next question.</span><button className="button button-primary" disabled={busy} onClick={onSkip}>Retry next question <ArrowRight size={16} /></button></div>
          ) : (
            <div className="finish-footer"><span><CheckCircle2 size={16} /> Your answers are saved on this device.</span><button className="button button-primary" disabled={busy || canRetryAnswer || canRetrySkip} onClick={onFinish}>Finish & see feedback <ArrowRight size={16} /></button></div>
          )}
        </section>
        <aside className="interview-aside">
          <div className="aside-card"><div className="aside-card-heading"><Target size={16} /><strong>Your focus</strong></div><span className="focus-tag">{session.config.focus_competency}</span><p>{session.config.interview_type === "Technical" ? "Follow-ups can probe your reasoning, complexity, trade-offs, and testing approach." : "Your coach will ask a few follow-ups when more detail could strengthen your example."}</p></div>
          {session.config.interview_type === "Technical" ? (
            <div className="aside-card star-card"><div className="aside-card-heading"><Lightbulb size={16} /><strong>A useful approach</strong></div><div className="star-list"><span><b>1</b><span><strong>Clarify</strong><small>State assumptions</small></span></span><span><b>2</b><span><strong>Reason</strong><small>Explain the approach</small></span></span><span><b>3</b><span><strong>Analyze</strong><small>Complexity & trade-offs</small></span></span><span><b>4</b><span><strong>Verify</strong><small>Test edge cases</small></span></span></div></div>
          ) : (
            <div className="aside-card star-card"><div className="aside-card-heading"><Lightbulb size={16} /><strong>STAR, if it helps</strong></div><div className="star-list"><span><b>S</b><span><strong>Situation</strong><small>Set the scene</small></span></span><span><b>T</b><span><strong>Task</strong><small>What was needed?</small></span></span><span><b>A</b><span><strong>Action</strong><small>What did you do?</small></span></span><span><b>R</b><span><strong>Result</strong><small>What changed?</small></span></span></div></div>
          )}
          <div className="aside-reassurance"><Mic2 size={18} /><p>No pressure to be perfect. You can choose whether this session uses external AI coaching.</p></div>
        </aside>
      </div>
    </div>
  );
}

function ReportPage({ session, report, onBack, onPracticeAgain, onRevision, onNotice }: {
  session: InterviewSession;
  report: Report;
  onBack: () => void;
  onPracticeAgain: () => void;
  onRevision: (questionId: string, text: string) => Promise<unknown>;
  onNotice: (notice: Notice) => void;
}) {
  const [revisionQuestion, setRevisionQuestion] = useState<string | null>(null);
  const [revisionText, setRevisionText] = useState("");
  const [savingRevision, setSavingRevision] = useState(false);

  const saveRevision = async (questionId: string) => {
    if (!revisionText.trim()) return;
    setSavingRevision(true);
    try {
      await onRevision(questionId, revisionText.trim());
      setRevisionText("");
      setRevisionQuestion(null);
      onNotice({ kind: "success", text: "Your revised answer is saved with its own practice feedback." });
    } catch (error) {
      onNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setSavingRevision(false);
    }
  };

  return (
    <div className="page-content report-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to sessions</button>
      <div className="report-hero">
        <div><div className="eyebrow"><span className="eyebrow-line" /> {session.config.interview_type.toUpperCase()} PRACTICE REPORT</div><h1>Look how far you’ve come.</h1><p>{session.config.role} · {session.config.difficulty} · Completed {formatDate(session.completed_at)}</p></div>
        <div className="report-score"><span>OVERALL PRACTICE SCORE</span><div><strong>{report.overall_score}</strong><small>/100</small></div><ScoreLabel score={report.overall_score} /></div>
      </div>
      <p className="report-summary">{report.summary}</p>
      <div className="report-main-grid">
        <section className="panel rubric-panel">
          <div className="panel-heading"><div><h2>Your rubric breakdown</h2><p>Scores are guidance for practice, not a measure of your potential.</p></div><span className="version-pill">Rubric {report.rubric_version}</span></div>
          <div className="rubric-list">
            {report.scores.map((dimension) => <ScoreRow key={dimension.key} dimension={dimension} />)}
          </div>
        </section>
        <section className="insights-column">
          <div className="insight-card strengths-card"><div className="insight-title"><span className="insight-icon green"><ArrowUpRight size={17} /></span><div><small>WHAT’S WORKING</small><h3>Your strengths</h3></div></div><div className="tag-cloud">{report.strengths.map((strength) => <span className="strength-tag" key={strength}>{strength}</span>)}</div></div>
          <div className="insight-card improvements-card"><div className="insight-title"><span className="insight-icon amber"><ArrowDownRight size={17} /></span><div><small>ROOM TO GROW</small><h3>One step to try</h3></div></div><strong className="priority-label">{report.priority}</strong>{report.recommendations.slice(0, 1).map((recommendation) => <p key={recommendation}>{recommendation}</p>)}</div>
          <div className="example-card"><div className="example-title"><Lightbulb size={17} /> A structure you can borrow</div><p>{report.example}</p><small>Use only details that are true to your experience.</small></div>
        </section>
      </div>
      {session.messages && session.messages.length > 0 && (
        <details className="transcript-details" open>
          <summary><MessageCircle size={16} /> Full Interview Dialogue Transcript ({session.messages.length} messages)</summary>
          <div className="transcript-body">
            {session.messages.map((m) => (
              <div className={`convo-bubble-row ${m.role}`} key={m.id}>
                <div className="convo-avatar">
                  {m.role === "assistant" ? <Sparkles size={15} /> : "Y"}
                </div>
                <div className="convo-bubble-content">
                  <span className="convo-bubble-sender">{m.role === "assistant" ? "INTERVIEWER" : "YOU"}</span>
                  <div className="convo-bubble-text">{m.content}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <section className="panel answer-review">
        <div className="panel-heading"><div><h2>Your answers & evidence</h2><p>See what you said and the specific text that supported your feedback.</p></div></div>
        {report.questions.length === 0 && <p className="no-evaluations">No answers were evaluated in this session, so no scores or coaching suggestions were generated.</p>}
        {report.questions.map((item, index) => {
          const question = session.questions.find((candidate) => candidate.kind === "primary" && candidate.text === item.question);
          const weakest = [...item.evaluation.scores].sort((a, b) => a.score - b.score)[0];
          return (
            <article className="answer-review-item" key={`${item.question}-${index}`}>
              <div className="review-question"><span>QUESTION {String(index + 1).padStart(2, "0")}</span><strong>{item.question}</strong></div>
              <div className="review-answer"><span className="answer-label">YOUR ANSWER</span><p>{item.answer?.text || "No answer recorded."}</p></div>
              {item.evaluation && (item.evaluation.review_verdict || item.evaluation.relevance_feedback) && (
                <div className="report-verdict-box">
                  <div className="verdict-header">
                    <span className={`verdict-pill ${item.evaluation.review_verdict || (item.evaluation.is_relevant === false ? "incorrect_or_off_topic" : "correct_and_relevant")}`}>
                      {item.evaluation.review_verdict === "incorrect_or_off_topic" || item.evaluation.is_relevant === false
                        ? "✕ Off-topic / Needs Revision"
                        : item.evaluation.review_verdict === "partially_correct"
                        ? "⚠ Partially Relevant"
                        : "✓ On-topic & Sound"}
                    </span>
                  </div>
                  {item.evaluation.relevance_feedback && <p className="verdict-feedback">{item.evaluation.relevance_feedback}</p>}
                  {item.evaluation.model_answer && (
                    <div className="report-model-answer">
                      <div className="model-answer-label"><Lightbulb size={14} /> <strong>{item.evaluation.review_verdict === "incorrect_or_off_topic" ? "Correct Model Solution:" : "Exemplary Benchmark Solution:"}</strong></div>
                      <p>{item.evaluation.model_answer}</p>
                    </div>
                  )}
                </div>
              )}
              {weakest?.evidence && <div className="evidence-quote"><span><FileText size={14} /> EVIDENCE FROM YOUR ANSWER</span><blockquote>“{weakest.evidence}”</blockquote><small>Linked to {weakest.label}</small></div>}
              <div className="answer-feedback-line"><span><Sparkles size={14} /> Practice score: <strong>{item.evaluation.overall_score}/100</strong></span>{question && <button className="text-button" onClick={() => setRevisionQuestion(revisionQuestion === question.id ? null : question.id)}>{revisionQuestion === question.id ? "Close rewrite" : "Practice a rewrite"} <ArrowRight size={14} /></button>}</div>
              {item.revisions.length > 0 && <div className="revision-history"><strong><CheckCircle2 size={15} /> Your revisions</strong>{item.revisions.map((revision, revisionIndex) => <div className="revision-row" key={`${revision.submitted_at}-${revisionIndex}`}><p>{revision.text}</p><span>Revision score <b>{revision.evaluation.overall_score}/100</b></span></div>)}</div>}
              {question && revisionQuestion === question.id && <div className="revision-editor"><label htmlFor={`revision-${question.id}`}>Try a new version. Keep it honest and add details you can stand behind.</label><textarea id={`revision-${question.id}`} value={revisionText} onChange={(event) => setRevisionText(event.target.value)} maxLength={5000} placeholder="Write your revised answer…" /><div><span>{revisionText.length} / 5,000</span><button className="button button-primary" disabled={savingRevision || !revisionText.trim()} onClick={() => saveRevision(question.id)}>{savingRevision ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save revision</button></div></div>}
            </article>
          );
        })}
      </section>
      <div className="report-actions"><span><CircleHelp size={15} />{session.config.interview_type === "Technical" && report.questions.every((item) => item.evaluation.evaluator.startsWith("Local technical-structure")) ? " Local technical feedback is a structure heuristic; it does not verify answer correctness." : " Feedback is practice guidance, not a validated assessment."}</span><button className="button button-primary" onClick={onPracticeAgain}>Practice again <ArrowRight size={16} /></button></div>
    </div>
  );
}

function ScoreLabel({ score }: { score: number }) {
  const label = score >= 80 ? "Strong practice" : score >= 60 ? "Building confidence" : "Room to grow";
  return <span className="score-label">{label}</span>;
}

function ScoreRow({ dimension }: { dimension: Dimension }) {
  const percent = dimension.percent ?? Math.round((dimension.score / 5) * 100);
  return <div className="score-row"><div className="score-row-top"><strong>{dimension.label}</strong><span><b>{dimension.score}</b><small> / 5</small></span></div><div className="score-track"><div style={{ width: `${percent}%` }} /></div><p>{dimension.explanation || `Weighted ${dimension.weight}% of your rubric score.`}</p>{dimension.evidence && <div className="score-evidence"><FileText size={12} /> “{dimension.evidence}”</div>}</div>;
}

function HistoryPage({ sessions, onOpenReport, onResume, onStart }: { sessions: InterviewSession[]; onOpenReport: (id: string) => void; onResume: (id: string) => void; onStart: () => void }) {
  const sorted = [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return <div className="page-content">
    <div className="page-intro"><div className="eyebrow"><span className="eyebrow-line" /> YOUR JOURNEY</div><h1>My sessions</h1><p>Every practice round is progress worth keeping.</p></div>
    <section className="panel history-panel">
      <div className="panel-heading"><div><h2>Practice history</h2><p>{sorted.length} {sorted.length === 1 ? "session" : "sessions"} saved on this device.</p></div><button className="button button-primary" onClick={onStart}><Plus size={16} /> New practice</button></div>
      {sorted.length === 0 ? <EmptyState icon={<History size={22} />} title="Nothing here just yet" text="Your completed and in-progress sessions will appear here." action="Start practicing" onClick={onStart} /> : (
        <div className="history-table">
          <div className="history-table-head"><span>ROLE & DATE</span><span>FOCUS</span><span>STATUS</span><span>SCORE</span><span /></div>
          {sorted.map((session) => <button className="history-table-row" key={session.id} onClick={() => session.status === "completed" ? onOpenReport(session.id) : onResume(session.id)}>
            <span className="history-role"><strong>{session.config.role}</strong><small>{session.config.interview_type} · {formatDate(session.completed_at || session.created_at)} · {session.config.duration_minutes} min</small></span>
            <span>{session.config.focus_competency}</span>
            <span><i className={`history-status ${session.status}`} />{session.status === "completed" ? "Completed" : session.status === "active" ? "In progress" : "Draft"}</span>
            <span className="history-score">{session.report ? `${session.report.overall_score}/100` : "—"}</span>
            <ArrowRight size={15} />
          </button>)}
        </div>
      )}
    </section>
  </div>;
}

function ProgressPage({ data, onStart }: { data: ProgressData | null; onStart: () => void }) {
  const maxScore = 5;
  return <div className="page-content">
    <div className="page-intro"><div className="eyebrow"><span className="eyebrow-line" /> THE LONG VIEW</div><h1>Your progress</h1><p>Notice what’s getting stronger, one session at a time.</p></div>
    {!data || data.completed_count === 0 ? (
      <section className="panel progress-empty"><EmptyState icon={<BarChart3 size={22} />} title="Your progress will grow with you" text="Complete a practice session to start seeing your score trends." action="Start your first session" onClick={onStart} /></section>
    ) : <>
      <div className="stats-grid progress-stats">
        <StatCard icon={<CheckCircle2 size={18} />} label="Sessions completed" value={String(data.completed_count)} foot="Each one is a win" tone="sage" />
        <StatCard icon={<Target size={18} />} label="Average overall score" value={data.average_score == null ? "—" : `${data.average_score}%`} foot={data.interview_types.length > 1 ? "Separate rubrics are not averaged" : `Across ${data.completed_count} completed ${data.completed_count === 1 ? "session" : "sessions"}`} tone="lavender" />
        <StatCard icon={<Sparkles size={18} />} label="Rubric consistency" value={data.interview_types.length > 1 ? "Separate" : "Matched"} foot={data.interview_types.join(" + ") || "Same interview type"} tone="sand" />
      </div>
      <section className="panel trends-panel"><div className="panel-heading"><div><h2>Dimension trends</h2><p>Each line reflects one interview type’s rubric, scored from 0 to 5.</p></div><span className="version-pill">{data.interview_types.join(" + ") || "Practice rubrics"}</span></div>
        <div className="trend-list">{data.trends.map((dimension) => {
          const latest = dimension.values[dimension.values.length - 1];
          return <div className="trend-row" key={dimension.key}><div className="trend-title"><strong>{dimension.label}</strong><span>{latest ? `${latest.score.toFixed(1)} / 5` : "Not scored"}</span></div><div className="trend-bars">{dimension.values.map((point, index) => <div className="trend-bar-wrap" key={`${point.session_id}-${index}`} title={`${formatDate(point.date)}: ${point.score}/5`}><span className="trend-bar" style={{ height: `${(point.score / maxScore) * 100}%` }} /><small>{index + 1}</small></div>)}</div></div>;
        })}</div>
        <p className="comparison-note"><CircleHelp size={15} /> {data.comparison_note}</p>
      </section>
      <div className="report-actions"><span>Scores are coaching guidance, not a prediction of interview or hiring outcomes.</span><button className="button button-primary" onClick={onStart}>Practice again <ArrowRight size={16} /></button></div>
    </>}
  </div>;
}

function ProfilePage({ profile, busy, onSave, onSignOut }: {
  profile: Profile;
  busy: boolean;
  onSave: (profile: Profile) => void;
  onSignOut: () => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [role, setRole] = useState(profile.target_role);
  const [experience, setExperience] = useState(profile.experience_level);
  const [skills, setSkills] = useState(profile.skills.join(", "));
  const [signOutError, setSignOutError] = useState("");
  useEffect(() => {
    setName(profile.name);
    setRole(profile.target_role);
    setExperience(profile.experience_level);
    setSkills(profile.skills.join(", "));
  }, [profile]);
  return <div className="page-content narrow-page">
    <div className="page-intro"><div className="eyebrow"><span className="eyebrow-line" /> A LITTLE ABOUT YOU</div><h1>Your profile</h1><p>These details help tailor practice questions to what you’re working toward.</p></div>
    <form className="panel profile-form" onSubmit={(event) => { event.preventDefault(); onSave({ name: name.trim() || "Candidate", target_role: role.trim(), experience_level: experience, skills: skills.split(",").map((skill) => skill.trim()).filter(Boolean) }); }}>
      <div className="profile-form-avatar"><span className="avatar avatar-large">{(name || "C").slice(0, 1).toUpperCase()}</span><div><strong>{name || "Candidate"}</strong><small>Local practice profile</small></div></div>
      <label className="field-label" htmlFor="profile-name">Name</label><input id="profile-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      <label className="field-label" htmlFor="profile-role">Target role</label><input id="profile-role" className="text-input" value={role} onChange={(event) => setRole(event.target.value)} placeholder="e.g. Product Manager" maxLength={120} />
      <label className="field-label" htmlFor="experience">Experience level</label><div className="select-wrap"><select id="experience" value={experience} onChange={(event) => setExperience(event.target.value)}><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select><ChevronDown size={16} /></div>
      <label className="field-label" htmlFor="skills">Skills <span className="optional">(separate with commas)</span></label><input id="skills" className="text-input" value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="e.g. facilitation, planning, analysis" maxLength={500} />
      <div className="privacy-note"><CheckCircle2 size={17} /><span>Your profile and sessions are stored in this prototype’s local database and scoped to your account.</span></div>
      <button className="button button-primary button-wide" disabled={busy}><Check size={16} /> Save profile</button>
    </form>
    {signOutError && <p className="signout-error" role="alert">{signOutError}</p>}
    <button className="button button-outline signout-button" onClick={() => {
      setSignOutError("");
      void onSignOut().catch(() => setSignOutError("We couldn’t sign you out. Please try again."));
    }}>Sign out</button>
  </div>;
}

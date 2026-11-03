/**
 * 로그인 전 전체 화면 (서버 모드 전용, 셸 밖) — 로그인 · 비밀번호 재설정 메일 받기 · 초대 수락(?invite=) · 비밀번호 재설정(?reset=).
 * 토큰 쿼리는 쓰고 나면 주소에서 지운다(history.replaceState) — 새로고침 · 공유 시 토큰이 남지 않게.
 * 최종 판정(비밀번호 정책 · 토큰 유효성 · 속도 제한)은 서버가 한다. 화면은 같은 규칙으로 먼저 안내만 한다.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ROLE_LABEL } from '@/core/permissions';
import { Icon } from '@/ui/Icon';
import { api, ApiError } from './api';
import { useSaas, WORKSPACE_STORAGE_KEY } from './context';
import { AuthFrame } from './Splash';
import {
  apiErrorMessage, normalizeInvite, normalizeResetCheck, passwordProblem, readAuthTokens, resetLinkProblem, serverKoreanMessage, stripAuthTokens,
  type AuthTokens, type InviteInfo, type ResetCheck,
} from './sync';
import { hardReload, isShellLoaded } from './runtime';

/* ---------- 토큰 쿼리 ---------- */

export function currentAuthTokens(): AuthTokens {
  try {
    return readAuthTokens(typeof location !== 'undefined' ? location.search : '');
  } catch {
    return { invite: null, reset: null };
  }
}

export function clearAuthTokensFromUrl(): void {
  try {
    if (typeof history !== 'undefined' && typeof location !== 'undefined') history.replaceState(history.state, '', stripAuthTokens(location.href));
  } catch {
    /* 주소를 바꿀 수 없는 환경 */
  }
}

/**
 * 로그인 · 토큰 오류 문구. 서버가 한국어 사유를 보내는 오류(로그인 잠금 · 속도 제한 · 비활성 계정 · 워크스페이스 잠김 · 보안 토큰 ·
 * 비밀번호 정책 · 재설정 링크 사용됨/만료)는 서버 문구를 그대로 쓴다 — 대기 시간 · 잠금 기준이 서버 설정에 따라 달라서.
 */
export function authErrorMessage(e: unknown, kind: 'login' | 'invite' | 'reset' | 'forgot'): string {
  if (e instanceof ApiError) {
    const ko = serverKoreanMessage(e);
    if (e.status === 0) return '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.';
    if (e.status === 429) return ko ?? (kind === 'login' ? '로그인 시도가 너무 많습니다. 1분쯤 뒤에 다시 시도해 주세요.' : '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    if (e.status === 403 && e.code === 'csrf') return ko ?? '보안 토큰이 맞지 않습니다. 새로고침 후 다시 시도해 주세요.';
    if (kind === 'login' && e.status === 401) return ko ?? '이메일 또는 비밀번호가 맞지 않습니다';
    if (kind === 'invite') {
      if (e.status === 409 && (e.code === 'invite_used' || e.code === 'invite_accepted')) return '이미 수락한 초대입니다. 로그인해 주세요.';
      if (e.status === 404) return '초대 링크가 만료되었거나 취소 · 사용된 링크입니다. 초대한 관리자에게 새 링크를 요청해 주세요.';
      if (e.status === 410) return ko ?? '초대 링크가 만료되었습니다. 초대한 관리자에게 새 링크를 요청해 주세요.';
      // 401 password_required · invalid_credentials, 403 account_disabled, 423 workspace_locked, 400 weak_password
      if (ko && (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 409 || e.status === 423)) return ko;
    }
    if (kind === 'reset') {
      const link = resetLinkProblem(e.code);
      if (link) return ko ?? link;
      if (e.status === 404 || e.status === 410) return '재설정 링크가 만료되었거나 이미 사용되었습니다. 재설정 메일을 다시 받아 주세요.';
      if (ko && e.status === 400) return ko; // weak_password 등
    }
  }
  return apiErrorMessage(e);
}

/* ---------- 공용 부품 ---------- */

function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="callout critical" role="alert">
      <Icon name="alert" size={16} />
      <div>{children}</div>
    </div>
  );
}
function FormNotice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'good' | 'warning' }) {
  if (!children) return null;
  return (
    <div className={`callout ${tone}`} role="status">
      <Icon name={tone === 'good' ? 'check' : tone === 'warning' ? 'alert' : 'sparkle'} size={16} />
      <div>{children}</div>
    </div>
  );
}
function TextField({ id, label, type = 'text', value, onChange, autoComplete, hint, autoFocus, disabled }: {
  id: string; label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete?: string; hint?: ReactNode; autoFocus?: boolean; disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} autoFocus={autoFocus} disabled={disabled} required />
      {hint ? <div className="xs muted">{hint}</div> : null}
    </div>
  );
}
function Submit({ busy, children, disabled }: { busy: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="submit" className="btn primary lg auth-submit" disabled={busy || disabled}>
      {busy ? <span className="auth-spinner sm" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* ---------- 로그인 ---------- */

export function LoginScreen({ initialView = 'login' }: { initialView?: 'login' | 'forgot' } = {}) {
  const saas = useSaas();
  const [view, setView] = useState<'login' | 'forgot'>(initialView);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim() || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      await saas.login(email.trim(), password);
    } catch (err) {
      setError(authErrorMessage(err, 'login'));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const forgot = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('가입한 이메일 주소를 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/password-reset', { method: 'POST', body: { email: email.trim() }, silent: true });
      setSent(true);
    } catch (err) {
      setError(authErrorMessage(err, 'forgot'));
    } finally {
      setBusy(false);
    }
  };

  if (view === 'forgot') {
    return (
      <AuthFrame>
        <form className="auth-form" onSubmit={forgot} noValidate aria-labelledby="forgot-title">
          <h1 id="forgot-title" className="auth-title">비밀번호 재설정 메일 받기</h1>
          <p className="small ink2">가입한 이메일로 재설정 링크를 보냅니다. 링크를 열어 새 비밀번호를 정하면 됩니다.</p>
          <FormError>{error}</FormError>
          {sent ? (
            <FormNotice tone="good">가입된 계정이면 재설정 링크를 메일로 보냈습니다. 메일이 오지 않으면 스팸함을 확인하거나 워크스페이스 관리자에게 문의해 주세요.</FormNotice>
          ) : null}
          <TextField id="forgot-email" label="이메일" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus />
          <Submit busy={busy} disabled={sent}>{sent ? '메일을 보냈습니다' : '재설정 링크 받기'}</Submit>
          <button type="button" className="auth-link" onClick={() => { setView('login'); setError(null); setSent(false); }}>로그인 화면으로</button>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form className="auth-form" onSubmit={submit} noValidate aria-labelledby="login-title">
        <h1 id="login-title" className="auth-title">로그인</h1>
        <p className="small ink2">워크스페이스 계정으로 로그인합니다. 계정은 워크스페이스 관리자가 초대로 만듭니다.</p>
        <FormNotice tone="warning">{saas.notice}</FormNotice>
        <FormError>{error}</FormError>
        <TextField id="login-email" label="이메일" type="email" value={email} onChange={setEmail} autoComplete="username" autoFocus />
        <TextField id="login-password" label="비밀번호" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        <Submit busy={busy}>로그인</Submit>
        <button type="button" className="auth-link" onClick={() => { setView('forgot'); setError(null); }}>비밀번호 재설정 메일 받기</button>
      </form>
    </AuthFrame>
  );
}

/* ---------- 초대 수락 ---------- */

export function InviteScreen({ token, onDone, initialInfo = null }: {
  token: string; onDone: () => void;
  /** 미리보기 · 테스트용 초대 정보 (기본: 열자마자 GET /api/invites/:token) */
  initialInfo?: InviteInfo | null;
}) {
  const saas = useSaas();
  const [info, setInfo] = useState<InviteInfo | null>(initialInfo);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialInfo) return undefined;
    let alive = true;
    api(`/api/invites/${encodeURIComponent(token)}`, { silent: true })
      .then((j) => { if (alive) setInfo(normalizeInvite(j)); })
      .catch((e) => { if (alive) setLoadError(authErrorMessage(e, 'invite')); });
    return () => { alive = false; };
  }, [token, initialInfo]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const n = name.trim();
    let body: { name?: string; password?: string } = {};
    if (info?.signedInAsInvitee) {
      body = {};
    } else if (info?.existingUser) {
      if (!pw) return setError('이미 가입된 이메일입니다. 이 계정의 비밀번호를 입력해 주세요.');
      body = { password: pw };
    } else {
      if (!n || n.length > 60) return setError('이름을 60자 이하로 입력해 주세요 (승인 · 반영 이력에 남습니다).');
      const p = passwordProblem(pw);
      if (p) return setError(p);
      if (pw !== pw2) return setError('비밀번호 확인이 일치하지 않습니다.');
      body = { name: n, password: pw };
    }
    setBusy(true);
    try {
      const r = await api<{ workspaceId?: string } | null>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body, silent: true });
      clearAuthTokensFromUrl();
      // 수락한 워크스페이스로 들어간다 (다른 워크스페이스에 이미 속해 있어도)
      const joined = typeof r?.workspaceId === 'string' && r.workspaceId ? r.workspaceId : null;
      if (isShellLoaded()) {
        if (joined) {
          try { localStorage.setItem(WORKSPACE_STORAGE_KEY, joined); } catch { /* 저장 불가 */ }
        }
        return hardReload();
      }
      if (joined) saas.switchWorkspace(joined);
      await saas.refreshMe().catch(() => null);
      onDone();
    } catch (err) {
      // 그 사이 다른 탭 · 기기에서 수락했거나 만료됐으면 폼 대신 상태 안내로
      if (err instanceof ApiError && err.status === 409 && err.code === 'invite_used') setInfo((i) => (i ? { ...i, accepted: true } : i));
      else if (err instanceof ApiError && err.status === 410) setInfo((i) => (i ? { ...i, expired: true } : i));
      setError(authErrorMessage(err, 'invite'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    clearAuthTokensFromUrl();
    onDone();
  };

  return (
    <AuthFrame>
      <form className="auth-form" onSubmit={submit} noValidate aria-labelledby="invite-title">
        <h1 id="invite-title" className="auth-title">초대 수락</h1>
        {loadError ? (
          <>
            <FormError>{loadError}</FormError>
            <button type="button" className="auth-link" onClick={cancel}>로그인 화면으로</button>
          </>
        ) : !info ? (
          <div className="auth-loading" role="status"><span className="auth-spinner" aria-hidden="true" /> 초대 정보를 확인하는 중</div>
        ) : info.accepted || info.expired ? (
          <>
            <FormError>{info.accepted ? '이미 수락한 초대입니다. 로그인해 주세요.' : '초대 링크가 만료되었습니다. 초대한 관리자에게 새 링크를 요청해 주세요.'}</FormError>
            <button type="button" className="btn primary lg auth-submit" onClick={cancel}>로그인 화면으로</button>
          </>
        ) : (
          <>
            <dl className="auth-facts">
              <div><dt>워크스페이스</dt><dd>{info.workspaceName ?? info.brandName ?? '—'}</dd></div>
              <div><dt>역할</dt><dd>{info.role ? ROLE_LABEL[info.role] : '—'}</dd></div>
              <div><dt>이메일</dt><dd className="num">{info.email ?? '—'}</dd></div>
              {info.invitedBy ? <div><dt>초대한 사람</dt><dd>{info.invitedBy}</dd></div> : null}
            </dl>
            {saas.me && !info.signedInAsInvitee ? <FormNotice tone="warning">지금 {saas.me.user.name}({saas.me.user.email}) 계정으로 로그인되어 있습니다. 수락하면 초대받은 계정으로 로그인됩니다.</FormNotice> : null}
            <FormError>{error}</FormError>
            {info.signedInAsInvitee ? (
              <FormNotice>초대받은 계정으로 로그인되어 있습니다. 수락하면 이 워크스페이스가 추가됩니다.</FormNotice>
            ) : info.existingUser ? (
              <>
                <FormNotice>이미 가입된 이메일입니다. 이 계정의 비밀번호로 수락하면 워크스페이스가 추가됩니다.</FormNotice>
                <TextField id="invite-password" label="비밀번호" type="password" value={pw} onChange={setPw} autoComplete="current-password" autoFocus />
              </>
            ) : (
              <>
                <TextField id="invite-name" label="이름 (승인 · 반영 이력에 표시)" value={name} onChange={setName} autoComplete="name" autoFocus />
                <TextField id="invite-password" label="비밀번호" type="password" value={pw} onChange={setPw} autoComplete="new-password" hint="10자 이상 · 영문 대소문자 · 숫자 · 기호 중 2가지 이상" />
                <TextField id="invite-password2" label="비밀번호 확인" type="password" value={pw2} onChange={setPw2} autoComplete="new-password" />
              </>
            )}
            <Submit busy={busy}>초대 수락하고 시작하기</Submit>
            <button type="button" className="auth-link" onClick={cancel}>이미 계정이 있습니다 — 로그인</button>
          </>
        )}
      </form>
    </AuthFrame>
  );
}

/* ---------- 비밀번호 재설정 ---------- */

/** 재설정 링크 → 쓸 수 있는지 먼저 확인(사전 확인 API) → 새 비밀번호. onDone('forgot') = 재설정 메일 다시 받기 화면으로 */
export function ResetScreen({ token, onDone, initialCheck = 'checking' }: {
  token: string; onDone: (next?: 'forgot') => void;
  /** 미리보기 · 테스트용 사전 확인 결과 (기본: 열자마자 서버에 확인) */
  initialCheck?: ResetCheck | null | 'checking';
}) {
  const saas = useSaas();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 'checking' = 확인 중, null = 확인하지 못함(폼을 보여 주고 서버 confirm이 판정) */
  const [check, setCheck] = useState<ResetCheck | null | 'checking'>(initialCheck);

  useEffect(() => {
    if (initialCheck !== 'checking') return undefined;
    let alive = true;
    api('/api/auth/password-reset/check', { method: 'POST', body: { token }, silent: true })
      .then((j) => { if (alive) setCheck(normalizeResetCheck(j)); })
      .catch(() => { if (alive) setCheck(null); });
    return () => { alive = false; };
  }, [token, initialCheck]);

  const leave = (next?: 'forgot') => {
    clearAuthTokensFromUrl();
    onDone(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const p = passwordProblem(pw);
    if (p) return setError(p);
    if (pw !== pw2) return setError('비밀번호 확인이 일치하지 않습니다.');
    setBusy(true);
    try {
      await api('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: pw }, silent: true });
      clearAuthTokensFromUrl();
      saas.setNotice('비밀번호를 바꿨습니다. 다른 기기의 로그인은 종료됐을 수 있습니다. 새 비밀번호로 로그인해 주세요.');
      if (isShellLoaded()) return hardReload();
      await saas.refreshMe().catch(() => null);
      onDone();
    } catch (err) {
      // 링크 자체를 더 쓸 수 없으면(사용됨 · 만료 · 잘못됨) 폼을 닫고 다시 받기 안내로
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'reset_used' || code === 'reset_expired' || code === 'reset_invalid') {
        setCheck({ valid: false, reason: code === 'reset_used' ? 'used' : code === 'reset_expired' ? 'expired' : 'invalid', email: null, expiresAt: null });
      }
      setError(authErrorMessage(err, 'reset'));
    } finally {
      setBusy(false);
    }
  };

  const unusable = check !== 'checking' && check !== null && !check.valid;
  return (
    <AuthFrame>
      <form className="auth-form" onSubmit={submit} noValidate aria-labelledby="reset-title">
        <h1 id="reset-title" className="auth-title">새 비밀번호 정하기</h1>
        {check === 'checking' ? (
          <div className="auth-loading" role="status"><span className="auth-spinner" aria-hidden="true" /> 재설정 링크를 확인하는 중</div>
        ) : unusable ? (
          <>
            <FormError>{error ?? resetLinkProblem(check.reason)}</FormError>
            <button type="button" className="btn primary lg auth-submit" onClick={() => leave('forgot')}>재설정 메일 다시 받기</button>
            <button type="button" className="auth-link" onClick={() => leave()}>로그인 화면으로</button>
          </>
        ) : (
          <>
            <p className="small ink2">재설정 링크는 한 번만 쓸 수 있습니다. 바꾸면 이 계정의 다른 로그인은 모두 종료됩니다.</p>
            {check?.email ? (
              <dl className="auth-facts">
                <div><dt>계정</dt><dd className="num">{check.email}</dd></div>
                {check.expiresAt ? <div><dt>링크 유효</dt><dd className="num">{fmtKstDateTime(check.expiresAt)}까지</dd></div> : null}
              </dl>
            ) : null}
            <FormError>{error}</FormError>
            <TextField id="reset-password" label="새 비밀번호" type="password" value={pw} onChange={setPw} autoComplete="new-password" autoFocus hint="10자 이상 · 영문 대소문자 · 숫자 · 기호 중 2가지 이상" />
            <TextField id="reset-password2" label="새 비밀번호 확인" type="password" value={pw2} onChange={setPw2} autoComplete="new-password" />
            <Submit busy={busy}>비밀번호 바꾸기</Submit>
            <button type="button" className="auth-link" onClick={() => leave()}>로그인 화면으로</button>
          </>
        )}
      </form>
    </AuthFrame>
  );
}

/** ISO 시각 → 'M/D HH:mm' (KST) */
function fmtKstDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const k = new Date(ms + 9 * 3600_000);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

/* ---------- 워크스페이스 없음 · 오류 ---------- */

export function NoWorkspaceScreen() {
  const saas = useSaas();
  return (
    <AuthFrame>
      <div className="auth-form">
        <h1 className="auth-title">소속된 워크스페이스가 없습니다</h1>
        <p className="small ink2">{saas.me?.user.name}({saas.me?.user.email}) 계정은 아직 어느 워크스페이스에도 속해 있지 않거나, 멤버십이 해제되었습니다. 워크스페이스 관리자에게 초대를 요청해 주세요.</p>
        <button type="button" className="btn lg auth-submit" onClick={() => void saas.logout()}>로그아웃</button>
      </div>
    </AuthFrame>
  );
}

export function WorkspaceErrorScreen({ message }: { message: string }) {
  const saas = useSaas();
  return (
    <AuthFrame>
      <div className="auth-form">
        <h1 className="auth-title">워크스페이스 정보를 불러오지 못했습니다</h1>
        <FormError>{message}</FormError>
        <button type="button" className="btn primary lg auth-submit" onClick={() => void saas.reloadDetail()}>다시 시도</button>
        <button type="button" className="auth-link" onClick={() => void saas.logout()}>로그아웃</button>
      </div>
    </AuthFrame>
  );
}

/** 토큰 쿼리에 따라 초대 · 재설정 · 로그인 화면 (재설정 링크를 쓸 수 없으면 '재설정 메일 다시 받기' 화면으로) */
export function AuthScreens({ tokens, onTokensUsed }: { tokens: AuthTokens; onTokensUsed: () => void }) {
  const [loginView, setLoginView] = useState<'login' | 'forgot'>('login');
  if (tokens.invite) return <InviteScreen token={tokens.invite} onDone={onTokensUsed} />;
  if (tokens.reset) return <ResetScreen token={tokens.reset} onDone={(next) => { setLoginView(next === 'forgot' ? 'forgot' : 'login'); onTokensUsed(); }} />;
  return <LoginScreen key={loginView} initialView={loginView} />;
}

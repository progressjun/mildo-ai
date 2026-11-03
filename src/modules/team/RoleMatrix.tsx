/** 역할 → 권한 표 (docs/SAAS_SPEC.md §2) — 서버 판정과 같은 표(src/core/permissions.ts)에서 그린다 */
import { Card } from '@/ui/primitives';
import { can, ROLE_LABEL, ROLES, type Permission } from '@/core/permissions';
import { PERMISSION_LABEL, ROLE_DESC } from './rules';

const PERMS: Permission[] = ['read', 'comment', 'request', 'approve:AE', 'approve:PM', 'approve:CLIENT', 'operate', 'configure', 'manage_team', 'live_write', 'owner'];

export function RoleMatrixCard() {
  return (
    <Card title="역할 · 권한 표" sub="서버가 모든 쓰기 요청을 이 표로 판정합니다 · 화면 버튼도 같은 표로 켜고 끕니다">
      <div className="table-wrap">
        <table className="tbl team-matrix">
          <thead>
            <tr>
              <th>역할</th>
              {PERMS.map((p) => <th key={p} className="c">{PERMISSION_LABEL[p]}</th>)}
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => (
              <tr key={r}>
                <td>
                  <strong>{ROLE_LABEL[r]}</strong>
                  <div className="xs muted">{ROLE_DESC[r]}</div>
                </td>
                {PERMS.map((p) => (
                  <td key={p} className="c">{can(r, p) ? <span className="yes" aria-label="허용">O</span> : <span className="no" aria-label="불가">–</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="stack-sm small ink2" style={{ marginTop: 12 }}>
        <p>소유자 권한을 주거나 회수하는 일(소유자 지정 · 소유자 강등 · 소유자 제외 · 소유자 계정 비활성화)은 소유자만 할 수 있습니다.</p>
        <p>자기 역할과 자기 계정 상태는 직접 바꾸지 않습니다. 다른 관리자 · 소유자에게 요청합니다.</p>
        <p>활성 소유자가 0명이 되는 변경은 서버가 거부합니다(마지막 소유자 보호). 두 소유자가 동시에 서로를 강등해도 한 명은 남습니다.</p>
        <p>초대로는 소유자 권한을 줄 수 없습니다. 관리자로 초대한 뒤 가입하면 소유자가 역할을 바꿉니다(소유권 이전은 두 단계).</p>
        <p>제외는 이 워크스페이스 멤버십만 지웁니다. 계정 비활성화는 모든 워크스페이스 로그인을 막으므로 관리 범위 밖 워크스페이스에 소속된 계정에는 쓰지 못합니다.</p>
      </div>
    </Card>
  );
}

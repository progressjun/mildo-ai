/**
 * 변경 요청 화면 권한(changeActionCheck · requestCheck · operateCheck)이 서버 최종 판정과 같은지 — 역할 × 승인 등급 × 액션 전부 대조.
 * 화면이 데모 3역할(demoRoleOf)로 판정하면 viewer는 담당 AE처럼, owner는 PM처럼 보여 버튼이 서버와 어긋난다(QA: 낙관적 성공 → 403 되돌림).
 */
import { describe, expect, it } from 'vitest';
import { checkActionPermission, type ServerAction } from '../../server/src/changes/policy';
import {
  actorLabel, APPROVAL_LEVELS, approvalLevelsOf, approvalScopeText, can, changeActionCheck, demoRoleOf, isMemberActor, operateCheck, requestCheck, ROLES,
  type ChangeAction,
} from './permissions';

const ACTIONS: ChangeAction[] = ['approve', 'reject', 'cancel', 'hold', 'resume', 'apply', 'retry', 'rollback'];

describe('changeActionCheck = 서버 checkActionPermission', () => {
  it('모든 역할 × 등급 × 액션에서 ok가 같다', () => {
    for (const role of ROLES) for (const lvl of APPROVAL_LEVELS) for (const a of ACTIONS) {
      const ui = changeActionCheck(role, lvl, a);
      const srv = checkActionPermission(role, lvl, a as ServerAction);
      expect({ role, lvl, a, ok: ui.ok }).toEqual({ role, lvl, a, ok: srv.ok });
      expect(ui.reason.length).toBeGreaterThan(0);
    }
  });

  it('QA 사례: 열람자는 아무 것도 못 하고(데모 매핑은 담당 AE), 소유자는 CLIENT 건 승인 · 반영, 광고주 담당자는 승인만', () => {
    expect(demoRoleOf('viewer')).toBe('담당 AE');
    for (const a of ACTIONS) expect(changeActionCheck('viewer', 'AE', a)).toMatchObject({ ok: false, reason: expect.stringContaining('읽기 전용') });
    expect(demoRoleOf('owner')).toBe('PM');
    expect(changeActionCheck('owner', 'CLIENT', 'approve').ok).toBe(true);
    expect(changeActionCheck('owner', 'CLIENT', 'apply').ok).toBe(true);
    expect(changeActionCheck('owner', 'CLIENT', 'rollback').ok).toBe(true);
    expect(changeActionCheck('admin', 'CLIENT', 'apply').ok).toBe(false);
    expect(changeActionCheck('client', 'PM', 'approve').ok).toBe(true);
    const ap = changeActionCheck('client', 'PM', 'apply');
    expect(ap.ok).toBe(false);
    expect(ap.reason).toContain('운영 권한');
    expect(ap.reason).toContain('광고주 담당자는 승인 · 반려까지');
    expect(ap.reason).not.toContain('은(는)');
    expect(changeActionCheck('client', 'CLIENT', 'hold').ok).toBe(false);
    expect(changeActionCheck('ae', 'PM', 'hold').ok).toBe(true);
    expect(changeActionCheck('ae', 'PM', 'approve').ok).toBe(false);
  });

  it('요청 · 운영 권한은 권한표와 같다', () => {
    for (const role of ROLES) {
      expect(requestCheck(role).ok).toBe(can(role, 'request'));
      expect(operateCheck(role).ok).toBe(can(role, 'operate'));
    }
    expect(requestCheck('viewer')).toMatchObject({ ok: false, reason: expect.stringContaining('열람자') });
  });

  it('승인 범위 · 표시 이름', () => {
    expect(approvalLevelsOf('owner')).toEqual(['AE', 'PM', 'CLIENT']);
    expect(approvalLevelsOf('admin')).toEqual(['AE', 'PM']);
    expect(approvalScopeText('viewer')).toBe('없음');
    expect(approvalScopeText('client')).toBe('담당 AE · PM · 수면밀도');
    expect(actorLabel({ member: 'viewer' })).toBe('열람자');
    expect(actorLabel('PM')).toBe('PM');
    expect(isMemberActor('PM')).toBe(false);
    expect(isMemberActor({ member: 'pm' })).toBe(true);
  });
});

/* 워크스페이스 설정 — 섹션별 카드 (브랜드 · 예산 배분 · 목표 · SAFETY · 위임 범위 · 데이터 시간표 · SLA · 감지 · 공휴일 · 당번 · 사용 모듈 · AI) */
import { useState } from 'react';
import { Button, Callout, Card, NumberInput, Pill, Toggle } from '@/ui/primitives';
import { fmt } from '@/core/util';
import type { MediaId } from '@/core/types';
import { DATA_TIMETABLE } from '@/data/constants';
import {
  ALWAYS_ON_MODULES, ANOMALY_LABEL, ANOMALY_METRICS, delegationRanges, formatConfigValue, getPath, KNOWN_MODULE_IDS, mergeConfig, minutesLabel,
  SEVERITY_LIST, TF_LABEL, TF_ROLE_IDS, TIMETABLE_KEYS, type TfRoleId,
} from '@/data/config';
import { MODULES, GROUP_LABEL } from '@/modules/registry';
import { allocationRows, issueFor, normalizeAllocation } from './model';
import { FieldRow, ListField, NullableNumField, NumField, TextField, TimeField, ToggleField, type FormCtx } from './Fields';

const Uses = ({ children }: { children: string }) => <span className="ws-uses">적용: {children}</span>;

/* ---------- 브랜드 · SKU ---------- */
export function BrandSection({ ctx }: { ctx: FormCtx }) {
  return (
    <div className="stack-lg">
      <Card title="브랜드" sub={<Uses>화면 · 리포트 · 에이전트 표기, MILDO Watch 경쟁사 추적, 검수 규칙(경쟁사명 사용 경고)</Uses>}>
        <div className="ws-grid">
          <TextField ctx={ctx} path="brand.name" label="브랜드명" />
          <TextField ctx={ctx} path="brand.productLine" label="제품군" placeholder="예: 매트리스" />
          <ListField ctx={ctx} path="brand.competitors" label="경쟁사 (한 줄에 하나 · 최대 10개)" hint="MILDO Watch 아카이브 · 검수 규칙에 같은 목록을 씁니다" rows={6} />
          <ListField ctx={ctx} path="brandKeywords" label="추가 브랜드 키워드 (브랜드명 외)" hint="수집 시 브랜드 키워드 판정에 브랜드명과 함께 씁니다" rows={4} />
        </div>
      </Card>
      <Card title="SKU 진입점" sub={<Uses>매출 성장 · 타겟 탭 SKU 확장 매트릭스 (제품 1 × 문제 × 상황 × 비교 기준, p.36)</Uses>}>
        <div className="ws-grid g3">
          <ListField ctx={ctx} path="sku.problems" label="고객의 문제" rows={5} />
          <ListField ctx={ctx} path="sku.situations" label="구매 상황" rows={5} />
          <ListField ctx={ctx} path="sku.criteria" label="비교 기준" rows={5} />
        </div>
      </Card>
    </div>
  );
}

/* ---------- 예산 배분 (합계 실시간 확인) ---------- */
export function BudgetSection({ ctx }: { ctx: FormCtx }) {
  const [locked, setLocked] = useState<MediaId>('naver_sa');
  const a = allocationRows(ctx.draft, ctx.defaults);
  const err = issueFor(ctx.issues, 'budget.allocation');
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  return (
    <Card title="예산 · 매체 배분" sub={<Uses>MILDO Board 월 예산 페이싱(연 예산 × 비중 ÷ 12) · 매체 비교의 가안 비중 · 수수료 계산</Uses>}
      actions={<span className="row" style={{ gap: 6 }}><Pill tone={a.ok ? 'good' : 'critical'} title="기준: 합계 100% ± 0.1%p">{a.ok ? '합계 100%' : `합계 ${fmt.dec1(a.sum * 100)}% · ${a.gapPp > 0 ? '+' : ''}${a.gapPp}%p`}</Pill><span className="xs muted">기준 100% ± 0.1%p</span></span>}>
      <div className="stack">
        <NumField ctx={ctx} path="budget.annual" hint={`= ${fmt.krw(eff.budget.annual)}원 · 월 ${fmt.krw(Math.round(eff.budget.annual / 12))}원`} />
        <div className="table-wrap">
          <table className="tbl ws-alloc">
            <thead><tr><th>매체</th><th className="r">배분 비중</th><th className="r">기본값</th><th className="r">연 예산</th><th className="r">월 예산</th><th>출처</th></tr></thead>
            <tbody>
              {a.rows.map((r) => (
                <tr key={r.id} data-media={r.id}>
                  <td><strong>{r.label}</strong></td>
                  <td className="r">
                    {ctx.readOnly
                      ? <span className="num">{formatConfigValue(`budget.allocation.${r.id}`, r.share)}</span>
                      : <NumberInput id={`ws-alloc-${r.id}`} value={Math.round(r.share * 1000) / 10} min={0} max={100} step={0.5} suffix="%"
                          onChange={(v) => { setLocked(r.id); ctx.set(`budget.allocation.${r.id}`, Math.round(v * 10) / 1000); }} style={{ justifyContent: 'flex-end' }} />}
                  </td>
                  <td className="r muted">{formatConfigValue('budget.allocation.x', r.defaultShare)}</td>
                  <td className="r">{fmt.krw(r.annual)}</td>
                  <td className="r">{fmt.krw(r.monthly)}</td>
                  <td>
                    {r.overridden ? <span className="row" style={{ gap: 4 }}><Pill tone="accent">워크스페이스 값</Pill>{!ctx.readOnly ? <Button size="sm" variant="ghost" icon="rollback" onClick={(e) => { if (e.detail > 1) return; ctx.reset(`budget.allocation.${r.id}`); }}>기본값으로</Button> : null}</span> : <Pill tone="neutral">기본값</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>합계</td><td className="r num">{fmt.dec1(a.sum * 100)}%</td><td className="r muted">100%</td><td className="r">{fmt.krw(a.rows.reduce((s, r) => s + r.annual, 0))}</td><td className="r">{fmt.krw(a.rows.reduce((s, r) => s + r.monthly, 0))}</td><td /></tr>
            </tfoot>
          </table>
        </div>
        {!a.ok ? (
          <Callout tone="critical" title="매체 배분 합계가 100%가 아닙니다">
            <div className="stack-sm">
              <span>{err ?? `현재 ${fmt.dec1(a.sum * 100)}% — 저장하려면 합계를 100%(허용 ±0.1%p)로 맞춰야 합니다.`}</span>
              {!ctx.readOnly ? (
                <span><Button size="sm" icon="check" onClick={(e) => { if (e.detail > 1) return; ctx.set('budget.allocation', normalizeAllocation(eff.budget.allocation, locked)); }}>
                  {`${a.rows.find((r) => r.id === locked)?.label ?? ''} 고정 · 나머지를 기존 비율대로 맞추기`}
                </Button></span>
              ) : null}
            </div>
          </Callout>
        ) : null}
        <div className="xs muted">기본 배분은 제안서 p.37 (연 50억 가정, VAT · 수수료 별도). 매체 연 예산은 계산값이며 실제 집행 예산은 매체 계정의 일 예산이 기준입니다.</div>
        {!ctx.readOnly && getPath(ctx.draft, 'budget.allocation') !== undefined ? (
          <div><Button size="sm" variant="ghost" icon="rollback" onClick={(e) => { if (e.detail > 1) return; ctx.reset('budget.allocation'); }}>매체 배분 전체를 기본값으로</Button></div>
        ) : null}
      </div>
    </Card>
  );
}

/* ---------- 목표 · SAFETY ---------- */
export function TargetsSection({ ctx }: { ctx: FormCtx }) {
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  return (
    <div className="stack-lg">
      <Card title="목표" sub={<Uses>AD Pilot 입찰 판정 · MILDO Board 키워드 판정 · Lab 테스트 판정 · Watch · 매출 성장 확대 여지 기준</Uses>}>
        <div className="ws-grid">
          <NumField ctx={ctx} path="targets.roas" />
          <NumField ctx={ctx} path="targets.brandRoas" />
          <NumField ctx={ctx} path="targets.highEfficiencyRatio" hint={`고효율 = 목표 ROAS × ${eff.targets.highEfficiencyRatio} = ${fmt.int(eff.targets.roas * eff.targets.highEfficiencyRatio)}% 이상 (브랜드 ${fmt.int(eff.targets.brandRoas * eff.targets.highEfficiencyRatio)}%)`} />
          <NullableNumField ctx={ctx} path="targets.cpa" emptyLabel="CPA 목표 없음" fallback={50_000} />
        </div>
      </Card>
      <Card title="SAFETY" sub={<Uses>AD Pilot 조정안 · 반영 전 점검(서버 반영 실행기 포함) · 대량 변경 가드 · MILDO Alert 키워드 급변 보류</Uses>}>
        <div className="ws-grid">
          <NumField ctx={ctx} path="safety.dailyChangeCapPct" />
          <NumField ctx={ctx} path="safety.minConversionsForDown" />
          <NumField ctx={ctx} path="safety.lostShareTrigger" scale={100} suffix="%" step={1} />
          <NumField ctx={ctx} path="safety.anomalyHoldPct" />
          <NumField ctx={ctx} path="safety.bulkWarnCount" />
          <NumField ctx={ctx} path="safety.bulkBlockCount" />
        </div>
      </Card>
    </div>
  );
}

/* ---------- 위임 범위 ---------- */
export function DelegationSection({ ctx }: { ctx: FormCtx }) {
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  const ranges = delegationRanges(eff.delegation.aeMaxPct, eff.delegation.pmMaxPct);
  const tiers = [
    { range: ranges[0], who: '담당 AE' },
    { range: ranges[1], who: 'PM' },
    { range: ranges[2], who: '광고주 승인' },
  ];
  return (
    <Card title="위임 범위" sub={<Uses>변경 요청 승인 라우팅 (MILDO Flow · AD Pilot · GFA Control · 서버 변경 요청 판정)</Uses>}>
      <div className="stack">
        <div className="ws-grid">
          <NumField ctx={ctx} path="delegation.aeMaxPct" />
          <NumField ctx={ctx} path="delegation.pmMaxPct" />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>변경 폭 (일 예산 · 입찰은 같은 폭 준용)</th><th>승인 주체</th></tr></thead>
            <tbody>{tiers.map((t) => <tr key={t.who}><td>{t.range}</td><td>{t.who}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="xs muted">경계값은 '이내'에 포함합니다. 기본값은 제안서 p.15 예시이며 계약 시 확정합니다. 브랜드 키워드 · 자동 조정 보류 대상은 폭과 관계없이 PM 이상이 승인합니다.</div>
      </div>
    </Card>
  );
}

/* ---------- 데이터 시간표 · SLA ---------- */
export function TimetableSection({ ctx }: { ctx: FormCtx }) {
  return (
    <Card title="데이터 시간표" sub={<Uses>리포트 · 데이터 시간표 화면, MILDO Board 수집 기준 시각 표기, 업무시간 안내</Uses>}>
      <div className="stack">
        <div className="ws-grid g3">
          {TIMETABLE_KEYS.map((k, i) => (
            <TimeField key={k} ctx={ctx} path={`timetable.${k}`} label={DATA_TIMETABLE[i]?.title ?? k} hint={`${DATA_TIMETABLE[i]?.channel ?? ''} · ${DATA_TIMETABLE[i]?.detail ?? ''}`} />
          ))}
        </div>
        <div className="xs muted">시간 순서(수집 → 리포트 → 브리핑 → 점검 → 마감)를 지켜야 저장됩니다. 서버의 예약 수집(전일 확정 07:00 · 매시 10분)과 리포트 발송 시각은 아직 고정 일정으로 동작하며, 이 표는 화면 · 안내 기준으로 먼저 반영됩니다.</div>
      </div>
    </Card>
  );
}

export function SlaSection({ ctx }: { ctx: FormCtx }) {
  const err = issueFor(ctx.issues, 'sla');
  return (
    <Card title="SLA (분)" sub={<Uses>MILDO Alert SLA 타이머 · 서버 24시간 감지의 기한 초과 에스컬레이션 · 이슈 보고 문구</Uses>}>
      <div className="stack">
        <div className="ws-grid g3">
          {SEVERITY_LIST.map((s) => (
            <div key={s} className="ws-sla-col stack-sm">
              <strong>{s}</strong>
              <NumField ctx={ctx} path={`sla.${s}.ackMin`} hint={labelOf(ctx, `sla.${s}.ackMin`)} />
              <NullableNumField ctx={ctx} path={`sla.${s}.actionMin`} emptyLabel="협의" fallback={240} />
              <NullableNumField ctx={ctx} path={`sla.${s}.reportMin`} emptyLabel={s === 'P2' ? '당일' : s === 'P3' ? '주간' : '협의'} fallback={480} />
            </div>
          ))}
        </div>
        {err ? <div className="ws-field-error">{err}</div> : null}
        <div className="xs muted">인지 ≤ 1차 조치 ≤ 결과 보고 순서, 인지 기한은 P1 ≤ P2 ≤ P3이어야 합니다. 주말 · 공휴일 당번 체계의 인지 30분 규칙(p.48)은 그대로 적용됩니다.</div>
      </div>
    </Card>
  );
}
function labelOf(ctx: FormCtx, path: string): string {
  const v = getPath(mergeConfig(ctx.defaults, ctx.draft), path);
  return typeof v === 'number' ? `= ${minutesLabel(v)}` : '';
}

/* ---------- 감지 · 공휴일 · 당번 ---------- */
export function DetectSection({ ctx }: { ctx: FormCtx }) {
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  const extraText = Object.entries(eff.holidays.extra).map(([d, l]) => `${d} ${l}`).join('\n');
  const [holidayDraft, setHolidayDraft] = useState<string | null>(null);
  const holidayErr = issueFor(ctx.issues, 'holidays');
  return (
    <div className="stack-lg">
      <Card title="이상 징후 기준" sub={<Uses>MILDO Alert 감지(동요일 · 동시간 대비) · MILDO Board 매체 비교 판정 · MILDO Watch</Uses>}>
        <div className="ws-grid g5">
          {ANOMALY_METRICS.map((m) => (
            <div key={m} className="stack-sm ws-sla-col">
              <strong>{ANOMALY_LABEL[m]}</strong>
              <NumField ctx={ctx} path={`anomalyThresholds.${m}.warnPct`} />
              <NumField ctx={ctx} path={`anomalyThresholds.${m}.dangerPct`} />
            </div>
          ))}
        </div>
      </Card>
      <Card title="공휴일" sub={<Uses>주말 · 공휴일 당번 체계 · 연휴 전 사전 점검 · 리포트 영업일 계산</Uses>}>
        <div className="ws-grid">
          <FieldRow ctx={ctx} path="holidays.extra" label="추가 휴무일 (한 줄에 'YYYY-MM-DD 이름')" hint="창립기념일 · 임시 휴무 등. 관공서 공휴일은 기본 목록에 있습니다">
            {(_st, id) => ctx.readOnly
              ? <span className="ws-value">{extraText || '없음'}</span>
              : (
                <textarea id={id} className="textarea ws-list" rows={4} value={holidayDraft ?? extraText} placeholder="2026-12-31 종무식"
                  onChange={(e) => {
                    setHolidayDraft(e.target.value);
                    const rec: Record<string, string> = {};
                    for (const line of e.target.value.split('\n')) {
                      const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
                      if (m) rec[m[1]] = m[2].trim();
                    }
                    ctx.set('holidays.extra', rec);
                  }}
                  onBlur={() => setHolidayDraft(null)} />
              )}
          </FieldRow>
          <ListField ctx={ctx} path="holidays.exclude" label="공휴일에서 제외 (근무일로 운영 · 한 줄에 날짜 하나)" hint="기본 공휴일 목록에 있는 날짜만" rows={4} />
        </div>
        {holidayErr ? <div className="ws-field-error">{holidayErr}</div> : null}
      </Card>
      <Card title="주말 · 공휴일 당번 · TF 백업" sub={<Uses>MILDO Alert 당번 배정 · 서버 SLA 에스컬레이션 · 전담 TF 화면 당번표</Uses>}>
        <div className="stack">
          <FieldRow ctx={ctx} path="onDuty.pool" label="당번 순번 대상 (선택한 역할이 차례로 맡습니다)">
            {(st) => (
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                {TF_ROLE_IDS.map((r) => {
                  const pool = (st.value as TfRoleId[]) ?? [];
                  const on = pool.includes(r);
                  return ctx.readOnly
                    ? <Pill key={r} tone={on ? 'accent' : 'neutral'}>{TF_LABEL[r]}{on ? ` · ${pool.indexOf(r) + 1}번째` : ''}</Pill>
                    : <Toggle key={r} id={`ws-duty-${r}`} checked={on} label={TF_LABEL[r]} onChange={(v) => ctx.set('onDuty.pool', v ? [...pool, r] : pool.filter((x) => x !== r))} />;
                })}
              </div>
            )}
          </FieldRow>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>TF 역할</th><th>백업</th><th>출처</th></tr></thead>
              <tbody>
                {TF_ROLE_IDS.map((r) => {
                  const path = `tf.backups.${r}`;
                  const cur = eff.tf.backups[r];
                  const overridden = getPath(ctx.draft, path) !== undefined;
                  const err = issueFor(ctx.issues, path);
                  return (
                    <tr key={r}>
                      <td>{TF_LABEL[r]}</td>
                      <td>
                        {ctx.readOnly ? TF_LABEL[cur] ?? cur : (
                          <select className="input ws-select" aria-label={`${TF_LABEL[r]} 백업`} value={cur} onChange={(e) => ctx.set(path, e.target.value)}>
                            {TF_ROLE_IDS.filter((x) => x !== r).map((x) => <option key={x} value={x}>{TF_LABEL[x]}</option>)}
                          </select>
                        )}
                        {err ? <div className="ws-field-error">{err}</div> : null}
                      </td>
                      <td>{overridden ? <span className="row" style={{ gap: 4 }}><Pill tone="accent">워크스페이스 값</Pill>{!ctx.readOnly ? <Button size="sm" variant="ghost" icon="rollback" onClick={() => ctx.reset(path)}>기본값으로</Button> : null}</span> : <Pill tone="neutral">기본값 · p.52</Pill>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ---------- 사용 모듈 · AI · 구독 ---------- */
export function ModulesSection({ ctx }: { ctx: FormCtx }) {
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  const all = MODULES.filter((m) => (KNOWN_MODULE_IDS as readonly string[]).includes(m.id));
  const enabled = new Set(eff.modules ?? all.map((m) => m.id));
  const always = new Set<string>(ALWAYS_ON_MODULES);
  const toggle = (id: string, on: boolean) => {
    const next = all.map((m) => m.id).filter((x) => (x === id ? on : enabled.has(x)) && !always.has(x));
    const everything = all.filter((m) => !always.has(m.id)).every((m) => next.includes(m.id));
    if (everything) ctx.reset('modules');
    else ctx.set('modules', next);
  };
  const groups = [...new Set(all.map((m) => m.group))];
  const err = issueFor(ctx.issues, 'modules');
  return (
    <div className="stack-lg">
      <Card title="사용 모듈" sub={<Uses>메뉴 표시 — 끈 모듈은 메뉴에서 숨고 주소로 열어도 커맨드 센터로 돌아갑니다. 데이터 · 감지는 서버에서 계속 동작합니다</Uses>}
        actions={<Pill tone={eff.modules ? 'accent' : 'neutral'}>{eff.modules ? `${all.filter((m) => always.has(m.id) || enabled.has(m.id)).length}/${all.length}개 사용` : '모든 모듈 (기본값)'}</Pill>}>
        <div className="stack">
          {groups.map((g) => (
            <div key={g} className="stack-sm">
              <div className="xs muted bold">{GROUP_LABEL[g]}</div>
              <div className="ws-modules">
                {all.filter((m) => m.group === g).map((m) => {
                  const locked = always.has(m.id);
                  const on = locked || enabled.has(m.id);
                  return (
                    <div key={m.id} className={`ws-module${on ? ' on' : ''}`}>
                      {ctx.readOnly || locked
                        ? <span className="row" style={{ gap: 6 }}><Pill tone={on ? 'good' : 'neutral'}>{on ? '사용' : '끔'}</Pill><strong className="small">{m.title}</strong></span>
                        : <Toggle id={`ws-mod-${m.id}`} checked={on} onChange={(v) => toggle(m.id, v)} label={<strong className="small">{m.title}</strong>} />}
                      <span className="xs muted">{locked ? '항상 표시 · ' : ''}{m.summary}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {err ? <div className="ws-field-error">{err}</div> : null}
          {!ctx.readOnly && eff.modules ? <div><Button size="sm" variant="ghost" icon="rollback" onClick={() => ctx.reset('modules')}>모든 모듈 사용 (기본값으로)</Button></div> : null}
        </div>
      </Card>
      <Card title="AI · 구독 · 성과 증명" sub={<Uses>서버 AI 호출 월 한도(ai 도메인) · 성과 증명 회수 배수 계산(구독료 · 공헌이익률 · 인건비 — 추정 입력)</Uses>}>
        <div className="ws-grid">
          <ToggleField ctx={ctx} path="ai.enabled" label="AI 사용" onText="켜짐 · 서버 키로 호출" offText="꺼짐 · 규칙 엔진만" />
          <NumField ctx={ctx} path="ai.monthlyTokenLimit" />
          <NumField ctx={ctx} path="billing.monthlyFee" />
          <NumField ctx={ctx} path="impact.contributionMargin" scale={100} suffix="%" step={1} />
          <NumField ctx={ctx} path="impact.hourlyCost" />
        </div>
      </Card>
    </div>
  );
}

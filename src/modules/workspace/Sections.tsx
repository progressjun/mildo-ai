/* 워크스페이스 설정 — 섹션별 카드 (브랜드 · 예산 배분 · 목표 · SAFETY · 위임 범위 · 데이터 시간표 · SLA · 감지 · 공휴일 · 당번 · 사용 모듈 · AI 사용량 · 한도 · 성과 증명 기준) */
import { useState } from 'react';
import { Button, Callout, Card, Empty, NumberInput, Pill, ProgressBar, Src, Stat, Toggle } from '@/ui/primitives';
import { fmt } from '@/core/util';
import type { MediaId } from '@/core/types';
import { DATA_TIMETABLE } from '@/data/constants';
import {
  ALWAYS_ON_MODULES, ANOMALY_LABEL, ANOMALY_METRICS, delegationRanges, formatConfigValue, getPath, KNOWN_MODULE_IDS, mergeConfig, minutesLabel,
  SEVERITY_LIST, TF_LABEL, TF_ROLE_IDS, TIMETABLE_KEYS, type TfRoleId,
} from '@/data/config';
import { MODULES, GROUP_LABEL } from '@/modules/registry';
import { PAYBACK_FORMULA } from '@/modules/impact/engine';
import { aiUsageView, allocationRows, impactBasis, issueFor, normalizeAllocation, pctText, type AiUsageState } from './model';
import { FieldRow, ListField, NullableNumField, NumField, TextField, TimeField, ToggleField, type FormCtx } from './Fields';

const Uses = ({ children }: { children: string }) => <span className="ws-uses">적용: {children}</span>;

/* ---------- 브랜드 · SKU ---------- */
export function BrandSection({ ctx }: { ctx: FormCtx }) {
  return (
    <div className="stack-lg">
      <Card title="브랜드" sub={<Uses>화면 · 리포트 · 에이전트 표기, MILDO Watch 경쟁사 추적, 검수 규칙(경쟁사명 사용 경고)</Uses>}>
        <div className="ws-grid">
          <TextField ctx={ctx} path="brand.name" label="브랜드명" hint="화면 · 에이전트 표기. 수집 시 브랜드 키워드 판정은 워크스페이스 브랜드명과 아래 추가 브랜드 키워드를 씁니다" />
          <TextField ctx={ctx} path="brand.productLine" label="제품군" placeholder="예: 매트리스" hint="MILDO Agent 설정 요약 표기용 · 판정에는 쓰지 않습니다" />
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
    <Card title="데이터 시간표" sub={<Uses>커맨드 센터 · 리포트 · MILDO Board의 데이터 시간표 표, 업무시간 안내</Uses>}>
      <div className="stack">
        <div className="ws-grid g3">
          {TIMETABLE_KEYS.map((k, i) => (
            <TimeField key={k} ctx={ctx} path={`timetable.${k}`} label={DATA_TIMETABLE[i]?.title ?? k} hint={`${DATA_TIMETABLE[i]?.channel ?? ''} · ${DATA_TIMETABLE[i]?.detail ?? ''}`} />
          ))}
        </div>
        <div className="xs muted">시간 순서(수집 → 리포트 → 브리핑 → 점검 → 마감)를 지켜야 저장됩니다. 서버의 예약 수집(전일 확정 07:00 · 매시 10분)과 리포트 발송 시각은 고정 일정으로 동작하고, MILDO Board 수집 현황의 배치 상태 문구 · 예산 소진 점검 안내 시각도 기본 시각(07:00 · 14:00) 기준입니다. 이 표는 위의 시간표 표 · 안내 문구에 반영됩니다.</div>
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
const HOLIDAY_LINE = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/;
export function DetectSection({ ctx }: { ctx: FormCtx }) {
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  const extraText = Object.entries(eff.holidays.extra).map(([d, l]) => `${d} ${l}`).join('\n');
  const [holidayDraft, setHolidayDraft] = useState<string | null>(null);
  const holidayErr = issueFor(ctx.issues, 'holidays');
  const skipped = holidayDraft === null ? 0 : holidayDraft.split('\n').filter((l) => l.trim() && !HOLIDAY_LINE.test(l.trim())).length;
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
                      const m = line.trim().match(HOLIDAY_LINE);
                      if (m) rec[m[1]] = m[2].trim();
                    }
                    ctx.set('holidays.extra', rec);
                  }}
                  onBlur={() => setHolidayDraft(null)} />
              )}
          </FieldRow>
          <ListField ctx={ctx} path="holidays.exclude" label="공휴일에서 제외 (근무일로 운영 · 한 줄에 날짜 하나)" hint="기본 공휴일 목록에 있는 날짜만" rows={4} />
        </div>
        {skipped ? <div className="ws-field-error" role="status">형식이 맞지 않아 저장에서 빠지는 줄 {skipped}개 — 한 줄에 'YYYY-MM-DD 이름' (예: 2026-12-31 종무식)</div> : null}
        {holidayErr ? <div className="ws-field-error">{holidayErr}</div> : null}
      </Card>
      <Card title="주말 · 공휴일 당번 · TF 백업" sub={<Uses>MILDO Alert 당번 배정 · 서버 SLA 에스컬레이션 · 전담 TF 화면 당번표</Uses>}>
        <div className="stack">
          <ToggleField ctx={ctx} path="offHoursMode" label="주말 · 공휴일 당번 체계 강제 (평일 포함)"
            onText="켜짐 · 평일에도 당번 순번 배정 · 전 등급 인지 30분 (p.48)" offText="꺼짐 · 평일은 담당 AE + 백업 · 등급별 SLA (p.49)"
            hint="연휴 전후 · 임시 휴무 · 비상 운영 기간에 켭니다. 서버 24시간 감지가 새 이슈를 배정할 때 이 값을 씁니다. MILDO Alert의 '주말 모드 시뮬레이션'은 이 브라우저 화면에서만 보는 시뮬레이션입니다" />
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
    </div>
  );
}

/* ---------- AI 사용량 · 한도 ---------- */
const tok = (n: number) => (Number.isFinite(n) ? `${fmt.krw(n)} 토큰` : '—');

function AiUsagePanel({ ai, draftLimit, onReload }: { ai: AiUsageState; draftLimit: number; onReload?: () => void }) {
  const demo = ai.status === 'demo';
  if (ai.status === 'loading') return <Card title="이번 달 AI 사용량"><Empty icon="clock" title="사용량을 불러오는 중입니다" /></Card>;
  if (!ai.usage) {
    return (
      <Card title="이번 달 AI 사용량" actions={onReload ? <Button size="sm" icon="refresh" onClick={onReload}>다시 불러오기</Button> : undefined}>
        <Empty icon="info" title="사용량을 불러오지 못했습니다">{ai.error ?? '서버 AI 연결 정보가 아직 없습니다. 잠시 후 다시 시도해 주세요.'}</Empty>
      </Card>
    );
  }
  const u = ai.usage;
  const v = aiUsageView(u, draftLimit);
  return (
    <Card title={<span className="row" style={{ gap: 8 }}>{u.month} AI 사용량{demo ? <Src kind="DEMO" /> : <Src kind="LIVE" title="서버 ai_usage 기록 (KST 월 기준)" />}</span>}
      sub={<span className="ws-uses">{u.basis}</span>}
      actions={onReload && !demo ? <Button size="sm" icon="refresh" onClick={onReload}>새로고침</Button> : undefined}>
      <div className="stack">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Pill tone={u.configured ? 'good' : 'warning'}>{u.configured ? '서버 키 연결됨' : '서버 키 미설정 (ANTHROPIC_API_KEY)'}</Pill>
          <Pill tone={u.enabled ? 'good' : 'neutral'}>{u.enabled ? 'AI 사용 켜짐' : 'AI 사용 꺼짐'}</Pill>
          {u.budgetExceeded ? <Pill tone="critical">한도 도달</Pill> : null}
          <Pill tone="outline">모델 {u.model}</Pill>
        </div>
        <div className="ws-ai-meter stack-sm">
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <strong>{tok(v.used)} / {tok(v.limit)}</strong>
            <span className="small">{pctText(v.usedRatio)} 사용</span>
          </div>
          <ProgressBar value={Math.min(v.used, v.limit || 1)} max={v.limit || 1} marker={(v.limit || 1) * 0.8} tone={v.usedRatio >= 1 ? 'critical' : v.usedRatio >= 0.8 ? 'warning' : 'accent'} label="월 한도 대비 사용량" />
          <span className="xs muted">{v.verdict} · 표시선 = 한도의 80%</span>
        </div>
        {v.draftLimit !== null ? (
          <Callout tone={v.draftBlocksNow ? 'critical' : 'info'} title={`저장 전 한도 ${tok(v.draftLimit)} 기준 사용률 ${pctText(v.draftRatio ?? 0)}`}>
            {v.draftBlocksNow
              ? '새 한도가 이번 달 사용량 이하입니다. 저장하면 이번 달 남은 기간 서버 AI 호출이 막히고 화면은 규칙 엔진 · 오프라인 브리프로 동작합니다.'
              : `저장하면 남은 토큰이 ${tok(Math.max(0, v.draftLimit - v.used))}이 됩니다.`}
          </Callout>
        ) : null}
        <div className="grid g-4">
          <Stat label="남은 토큰" value={tok(Math.max(0, u.remaining))} foot={<span className="ws-basis">월 한도 − (입력 + 출력)</span>} />
          <Stat label="호출" value={`${fmt.int(u.calls)}회`} foot={<span className="ws-basis">오류 {fmt.int(u.errors)}회 포함</span>} />
          <Stat label="입력 · 출력" value={`${fmt.krw(u.inputTokens)} · ${fmt.krw(u.outputTokens)}`} foot={<span className="ws-basis">입력은 캐시 읽기 · 쓰기 포함</span>} />
          <Stat label="캐시 읽기" value={tok(u.cacheReadTokens)} foot={<span className="ws-basis">캐시 쓰기 {tok(u.cacheCreationTokens)}</span>} />
        </div>
        <div className="ws-grid">
          <div className="stack-sm">
            <strong className="small">용도별</strong>
            {v.purposes.length ? (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>용도</th><th className="r">호출</th><th className="r">토큰</th><th className="r">비중</th></tr></thead>
                  <tbody>{v.purposes.slice(0, 8).map((p) => <tr key={p.purpose}><td title={p.purpose}>{p.label}</td><td className="r">{fmt.int(p.calls)}</td><td className="r">{fmt.krw(p.tokens)}</td><td className="r">{pctText(p.share)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <span className="xs muted">이번 달 호출이 없습니다</span>}
          </div>
          <div className="stack-sm">
            <strong className="small">최근 7일</strong>
            {v.recentDaily.length ? (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>날짜 (KST)</th><th className="r">호출</th><th className="r">토큰</th></tr></thead>
                  <tbody>{v.recentDaily.map((d) => <tr key={d.date}><td className="num">{d.date}</td><td className="r">{fmt.int(d.calls)}</td><td className="r">{fmt.krw(d.tokens)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <span className="xs muted">기록 없음</span>}
          </div>
        </div>
        {v.users.length ? (
          <div className="stack-sm">
            <strong className="small">사용자별 (설정 권한자에게만 보임)</strong>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>사용자</th><th className="r">호출</th><th className="r">토큰</th></tr></thead>
                <tbody>{v.users.slice(0, 10).map((x) => <tr key={x.name}><td>{x.name}</td><td className="r">{fmt.int(x.calls)}</td><td className="r">{fmt.krw(x.tokens)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        ) : null}
        {demo ? <div className="xs muted">위 사용량은 예시(TEST DATA)입니다. 서버에 연결하면 이 워크스페이스의 실제 기록을 보여 줍니다.</div> : null}
      </div>
    </Card>
  );
}

export function AiSection({ ctx, ai, onReloadUsage }: { ctx: FormCtx; ai: AiUsageState; onReloadUsage?: () => void }) {
  const eff = mergeConfig(ctx.defaults, ctx.draft);
  return (
    <div className="stack-lg">
      <AiUsagePanel ai={ai} draftLimit={eff.ai.monthlyTokenLimit} onReload={onReloadUsage} />
      <Card title="AI 사용 · 월 한도" sub={<Uses>서버 AI 호출(POST /ai/messages) 허용 여부와 월 토큰 한도 — 한도는 호출 전에 판정하고, 닿으면 화면은 규칙 엔진으로 동작합니다</Uses>}>
        <div className="ws-grid">
          <ToggleField ctx={ctx} path="ai.enabled" label="AI 사용" onText="켜짐 · 서버 키로 호출" offText="꺼짐 · 규칙 엔진 · 오프라인 브리프만" />
          <NumField ctx={ctx} path="ai.monthlyTokenLimit" hint={`= ${tok(eff.ai.monthlyTokenLimit)} · 0이면 서버 AI 호출을 막습니다. 입력 + 출력 토큰 합계 · KST 월 기준`} />
        </div>
      </Card>
    </div>
  );
}

/* ---------- 성과 증명 기준 ---------- */
export function ImpactSection({ ctx }: { ctx: FormCtx }) {
  const b = impactBasis(mergeConfig(ctx.defaults, ctx.draft));
  return (
    <div className="stack-lg">
      <Card title="성과 증명 기준" sub={<Uses>성과 증명 화면 · 월간 가치 리포트의 회수 배수 계산 입력 (서버 impact.measure · 월간 가치 리포트가 같은 값을 씁니다)</Uses>}>
        <div className="stack">
          <div className="ws-grid g3">
            <NumField ctx={ctx.canOwner ? ctx : { ...ctx, readOnly: true }} path="billing.monthlyFee"
              hint={`= ${fmt.krw(b.monthlyFee)}원 · 회수 배수의 분모${!ctx.readOnly && !ctx.canOwner ? ' · 소유자만 바꿀 수 있어 읽기 전용입니다' : ''}`} />
            <NumField ctx={ctx} path="impact.contributionMargin" scale={100} suffix="%" step={1} />
            <NumField ctx={ctx} path="impact.hourlyCost" />
          </div>
          <Callout tone="info" title="계산식">
            <span className="stack-sm">
              <span>{PAYBACK_FORMULA}</span>
              <span className="xs">측정 증분 이익은 반영 전 7일 대비 후 7일 · 같은 매체 · 의도의 미변경 키워드 대조군으로 추정합니다. 손실 회피 · 절감 시간은 추정값이며 화면 · 리포트에 추정으로 표기합니다. 회수 판정 기준: 80% 구간 하한 ≥ 1배면 회수, 점추정만 ≥ 1배면 불확실.</span>
            </span>
          </Callout>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>1배 회수 조건 (계산값)</th><th className="r">값</th><th>근거</th></tr></thead>
              <tbody>
                <tr><td>필요한 월 가치 합계</td><td className="r">{fmt.won(b.breakEvenValue)}</td><td className="xs muted">= 월 구독료</td></tr>
                <tr><td>증분 이익만으로 채울 때 필요한 증분 매출</td><td className="r">{fmt.won(b.breakEvenRevenue)}</td><td className="xs muted">= 월 구독료 ÷ 공헌이익률 {Math.round(b.margin * 100)}%</td></tr>
                <tr><td>절감 시간만으로 채울 때 필요한 시간</td><td className="r">{b.breakEvenHours === null ? '시간당 인건비 0원 — 계산 안 함' : `${fmt.dec1(b.breakEvenHours)}시간`}</td><td className="xs muted">= 월 구독료 ÷ 시간당 인건비 {fmt.won(b.hourlyCost)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="xs muted">공헌이익률 · 시간당 인건비는 광고주 확인 전까지 가정값입니다. 반례: 같은 기간 프로모션 · 시즌 요인이 있으면 대조군 보정 후에도 증분이 과대 추정될 수 있습니다.</div>
        </div>
      </Card>
    </div>
  );
}

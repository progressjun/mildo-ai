/**
 * 전담 TF · 온보딩 · 계약 · RFP 커버리지 — 제안서 p.51–59 (+ p.48 당번 · p.50 계정 구조 · p.53 의사결정)
 * 제출 준비 스트립 → TF · 백업 · 운영 체계 · 90일 온보딩 · 회사 · 레퍼런스 · 수수료 · 계약 · RFP 커버리지
 * TF 성명 · 연차 · 투입률은 전역 스토어(state.tf), 나머지 제출 전 입력값은 모듈 로컬 저장(local.ts).
 */
import { useState, type ReactNode } from 'react';
import { useStore } from '@/core/store';
import { fmt } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { PageHeader, Pill, Src, Tabs, Card, Button } from '@/ui/primitives';
import { ddayLabel, feeBrief, onboardingBrief, rfpBrief, shortDate, tfBrief } from './engine';
import { moduleIds, useOpsLocal, useOpsModel } from './useOps';
import { TfTab } from './TfTab';
import { StructureTab } from './StructureTab';
import { OnboardingTab } from './OnboardingTab';
import { CompanyTab } from './CompanyTab';
import { ContractTab } from './ContractTab';
import { CoverageTab } from './CoverageTab';
import './styles.css';

type TabId = 'tf' | 'structure' | 'onboarding' | 'company' | 'contract' | 'coverage';
const TAB_IDS: TabId[] = ['tf', 'structure', 'onboarding', 'company', 'contract', 'coverage'];

function Badge({ n, tone = 'warning' }: { n: number; tone?: 'warning' | 'critical' }) {
  return n > 0 ? <Pill tone={tone}>{n}</Pill> : null;
}

function Tile({ label, value, foot, flag, onClick, active, accent }: { label: ReactNode; value: ReactNode; foot: ReactNode; flag?: ReactNode; onClick: () => void; active: boolean; accent?: boolean }) {
  return (
    <button type="button" className="ops-tile" aria-pressed={active} onClick={onClick}>
      <span className="ops-tile-label"><span>{label}</span>{flag}</span>
      <span className={`ops-tile-value${accent ? ' accent' : ''}`}>{value}</span>
      <span className="ops-tile-foot">{foot}</span>
    </button>
  );
}
const Flag = ({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) => <span className={`ops-flag ${ok ? 'ok' : warn ? 'warn' : 'bad'}`}>{children}</span>;

export default function View() {
  const { state } = useStore();
  const d = state.data;
  const { local, patch, reset } = useOpsLocal();
  const model = useOpsModel(local);
  const s = model.summary;
  const [tab, setTab] = useState<TabId>('tf');
  const [confirmReset, setConfirmReset] = useState(false);
  const goTab = (t: string) => { if ((TAB_IDS as string[]).includes(t)) setTab(t as TabId); };
  const dl = s.schedule.deadline;
  const own = s.ownership.summary;
  const feeMissing = s.fee.missing.total + s.fee.missing.invalid;
  const ownIssues = own.nonRealName + own.paymentRisk + own.review;

  const tabs: { id: TabId; label: ReactNode; badge?: ReactNode }[] = [
    { id: 'tf', label: '전담 TF · 백업', badge: <Badge n={s.tf.total + s.tf.invalid + s.graph.gaps} /> },
    { id: 'structure', label: '운영 체계 · 계정 구조', badge: <Badge n={ownIssues} tone="critical" /> },
    { id: 'onboarding', label: '90일 온보딩' },
    { id: 'company', label: '회사 · 레퍼런스', badge: <Badge n={s.refs.total} /> },
    { id: 'contract', label: '수수료 · 계약', badge: <Badge n={feeMissing + s.contract.missing} /> },
    { id: 'coverage', label: 'RFP 커버리지', badge: <Badge n={s.coverage.length - s.coverageDone} /> },
  ];

  const fallback = () => {
    if (tab === 'tf' || tab === 'structure') return tfBrief(d, model.inputs);
    if (tab === 'contract') return feeBrief(model.inputs);
    if (tab === 'onboarding') return onboardingBrief(d, local.kickoff);
    return rfpBrief(d, model.inputs, moduleIds());
  };
  const buildPrompt = () => {
    const snap = {
      기준시각: `${d.today} ${d.currentHour}시`,
      제출마감: `${dl.date} ${dl.hour}시 (${ddayLabel(dl.days)}, ${dl.hoursLeft}시간)`,
      TF: { 미입력칸: s.tf.total, 오입력: s.tf.invalid, 상호백업: s.graph.mutualPairs.length, 단방향: s.graph.oneWay, 공백: s.graph.gaps, 이슈: s.graph.issues.map((i) => i.text) },
      계정구조: { 계정: own.accounts, 비실명권한: own.nonRealName, 결제위험: own.paymentRisk, 검수상태: own.review },
      레퍼런스: { 빈칸: s.refs.total, 침구월합산: s.refs.bedding.sum, 장표표기: s.refs.bedding.claim },
      수수료: { 미입력: feeMissing, 순수수료: Math.round(s.fee.totals.net), 실효율pct: Number.isFinite(s.fee.totals.effectivePct) ? Math.round(s.fee.totals.effectivePct * 100) / 100 : null, 계약미입력: s.contract.missing },
      커버리지: s.coverage.map((r) => ({ 구분: r.groupLabel, 항목: r.text, 상태: r.status === 'done' ? '구현됨' : '입력 필요', 비고: r.note })),
      평가준비도: s.eval.rows.map((e) => `${e.label} ${e.weight}% · ${e.done}/${e.items}`),
    };
    return `과제: 수면밀도 RFP 제출 준비 상태와 전담 TF · 백업 · 온보딩 · 수수료 구조를 평가 비중(리소스 절감 자동화 25 · 운영 안정성 20 · 전략 20 · 인력 15 · 비용 10 · 레퍼런스 10) 기준으로 해석하라. 우선 협상은 리소스 절감 자동화 · 운영 안정성 점수 우선, 동점 시 수수료다. 남은 입력 항목의 제출 리스크와 처리 순서를 담당자 · 기한과 함께 제시하라. 성과 수치는 시연용 테스트 데이터다.\n\n현재 화면: ${tabs.find((t) => t.id === tab)?.label}\n\n데이터(JSON):\n${JSON.stringify(snap)}`;
  };

  return (
    <div className="page ops-page">
      <PageHeader
        eyebrow="06 DEDICATED TF & ONBOARDING · 07 COMPANY & REFERENCE · 08 COMMERCIAL PROPOSAL"
        title="전담 TF · 온보딩 · 계약"
        sub="툴을 만드는 사람까지 한 팀에 있습니다. 개발자 포함 전담 7인 TF와 1:1 백업, 90일 온보딩, 매체별 수수료 공개, 그리고 RFP 요청 항목이 MILDO OS 어디에서 시연되는지를 한 화면에서 점검합니다."
        sources={<><Src kind="PROPOSAL" page="p.51–59" /><Src kind="RFP" /><Src kind="DEMO" title="계정 · 성과 기준선은 시연용 테스트 데이터" /></>}
        actions={confirmReset ? (
          <>
            <span className="small muted">레퍼런스 · 수수료 · 계약 · Kick-off · 백업 재지정 · 제출 체크 입력을 지웁니다 (TF 명단 제외)</span>
            <Button size="sm" variant="danger" onClick={() => { reset(); setConfirmReset(false); }}>초기화 확인</Button>
            <Button size="sm" onClick={() => setConfirmReset(false)}>취소</Button>
          </>
        ) : <Button size="sm" icon="refresh" onClick={() => setConfirmReset(true)}>입력 초기화</Button>}
      />

      <Card tone="dark" title="제출 준비 현황" sub={`기준일 ${shortDate(d.today)} ${d.currentHour}시 · 칸을 누르면 해당 탭으로 이동`} actions={<><Src kind="RFP" /><Src kind="PROPOSAL" page="p.50–58" /><Src kind="DEMO" title="계정 · 결제 · 권한 칸은 시연용 테스트 데이터" /></>}>
        <div className="ops-strip">
          <Tile label="제안서 제출 마감" value={dl.passed ? '마감' : ddayLabel(dl.days)} accent active={tab === 'coverage'} onClick={() => setTab('coverage')}
            foot={`${shortDate(dl.date)} ${dl.hour}시 · ${dl.passed ? '지남' : `${fmt.int(dl.hoursLeft)}시간`} · 내부 확정 ${shortDate(dl.freeze)}`} />
          <Tile label={'TF 명단 (필수 제출물\u00a04)'} value={<>{s.tf.total}<span className="small"> / {s.tf.cells}칸</span></>} active={tab === 'tf'} onClick={() => setTab('tf')}
            flag={<Flag ok={s.tf.complete} warn={!s.tf.complete}>{s.tf.complete ? '완료' : '미입력'}</Flag>}
            foot={`성명 ${s.tf.name} · 연차 ${s.tf.years} · 투입률 ${s.tf.allocation}${s.tf.invalid ? ` · 오입력 ${s.tf.invalid}` : ''}`} />
          <Tile label="1:1 백업" value={<>{s.graph.mutualPairs.length}<span className="small">쌍 상호</span></>} active={tab === 'tf'} onClick={() => setTab('tf')}
            flag={<Flag ok={s.graph.gaps === 0}>{s.graph.gaps === 0 ? '공백 0' : `공백 ${s.graph.gaps}`}</Flag>}
            foot={`단방향 ${s.graph.oneWay} · 백업 집중 ${s.graph.concentration} · 지정 ${s.graph.covered}/${s.roster.length} (기준 공백 0)`} />
          <Tile label="계정 · 결제 · 권한" value={<>{ownIssues}<span className="small">건</span></>} active={tab === 'structure'} onClick={() => setTab('structure')}
            flag={<Flag ok={ownIssues === 0}>{ownIssues === 0 ? '이상 없음' : '조치 필요'}</Flag>}
            foot={`비실명 ${own.nonRealName} · 결제 위험 ${own.paymentRisk} · 검수 ${own.review} · TEST DATA`} />
          <Tile label="레퍼런스 · 수수료 · 계약" value={<>{s.refs.total + feeMissing + s.contract.missing}<span className="small">칸</span></>} active={tab === 'contract' || tab === 'company'} onClick={() => setTab(s.refs.total ? 'company' : 'contract')}
            flag={<Flag ok={s.refs.total + feeMissing + s.contract.missing === 0} warn>{s.refs.total + feeMissing + s.contract.missing === 0 ? '완료' : '미입력'}</Flag>}
            foot={`레퍼런스 ${s.refs.total} · 수수료 · 페이백 ${feeMissing} · 계약 ${s.contract.missing}`} />
          <Tile label="RFP 커버리지" value={<>{s.coverageDone}<span className="small"> / {s.coverage.length}</span></>} active={tab === 'coverage'} onClick={() => setTab('coverage')}
            flag={<Flag ok={s.coverageDone === s.coverage.length} warn>{s.coverageDone === s.coverage.length ? '전 항목' : `입력 필요 ${s.coverage.length - s.coverageDone}`}</Flag>}
            foot={`가중 준비도 ${fmt.dec1(s.eval.total)} / 100 · 우선 협상 기준 ${fmt.dec1(s.eval.priorityReady)} / ${s.eval.priorityWeight}`} />
        </div>
      </Card>

      <Tabs tabs={tabs} value={tab} onChange={setTab} id="ops-tabs" />

      {tab === 'tf' ? <TfTab model={model} local={local} patch={patch} /> : null}
      {tab === 'structure' ? <StructureTab model={model} /> : null}
      {tab === 'onboarding' ? <OnboardingTab local={local} patch={patch} /> : null}
      {tab === 'company' ? <CompanyTab rows={s.refRows} check={s.refs} patch={patch} /> : null}
      {tab === 'contract' ? <ContractTab fee={s.fee} contract={s.contract} local={local} patch={patch} /> : null}
      {tab === 'coverage' ? <CoverageTab model={model} local={local} patch={patch} goTab={goTab} /> : null}

      <AiInsight
        title="제출 준비 · 운영 체계 해석"
        sub="현재 탭 기준 · 확정 팩트 / 반복 관측 패턴 / AI 해석 구분 · AI 미연결 시 규칙 엔진"
        buildPrompt={buildPrompt}
        fallback={fallback}
        cta="해석 생성"
      />
    </div>
  );
}

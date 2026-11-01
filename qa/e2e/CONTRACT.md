# claude.ai 아티팩트 런타임 계약 요약 (0.2.96) — 점검 기준

window.claude 에는 use 만 있다. `await claude.use("sample")` / `await claude.use("downloads")` → 네임스페이스 또는 null (null이면 기능 숨김/대체).

## sample
- `await sample(input, opts?)` → `{text, truncated, modelTierApplied}`; `await sample.json(input, opts?)` → 파싱된 값
- input: 문자열, 또는 user로 시작·끝나는 [{role:'user'|'assistant', content}] (연속 같은 role 허용), 총 256KiB 이하
- opts: onText({text, delta}) — text는 지금까지의 전체 답(대입), signal(호출마다 새 AbortController), tools:[{name, description, inputSchema?, execute(input, {signal})}] (결과 32KB 이하, throw하면 Claude가 오류로 받음), modelTier quick|default|complex, cache (기본 5분 재사용; 채팅은 false; tools와 cache(false 외) 동시 지정 시 invalid_request)
- `sample.limits()` → {maxPromptBytes, tools?:{maxCount}, images?} — tools 없으면 도구 호출 불가(tools_unavailable)
- 실패는 reject {code, message, text?}: cancelled(중지; 사용자에게 오류로 알리지 않음), not_granted/sampling_disabled/…(기능 숨김, 재요청 금지), rate_limited(사용자에게 알리고 컨트롤 유지, 자동 재시도 금지), upstream_error(부분 text 유지 + 수동 재시도), invalid_json(json만), refused(부분 출력 지움)
- 반드시 클릭 등 명시적 사용자 동작에서만 호출. 루프 · 타이머 · 자동 재시도 금지. 첫 호출 시 사용자 동의 창이 뜬다(대기 동안 onText 없음 → '생각 중' 표시 유지).

## downloads
- `await downloads.save({filename, data})` → {status:'saved'}; 사용자가 확인창에서 수락해야 저장. 실패 reject {code}: declined(재시도 금지), rejected_extension(허용: gif png jpg jpeg webp mp4 webm mov txt json md docx pptx epub csv ttf html svg pdf xlsx zip fig), bad_request(빈 데이터 등), unavailable…
- 페이지는 직접 다운로드(a[download])하지 않는다 — 아티팩트 안에서는 save만.

## 페이지 제약 (CSP)
- 외부 fetch 불가, window.alert/confirm/prompt/print/open 불가, 해시 라우팅만.

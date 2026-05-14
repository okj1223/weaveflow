# Next Design Request For GPT Pro

## 목표

현재 Weaveflow를 다음 단계로 발전시키기 위한 personal automation/아키텍처 설계를
제안해라. 단순히 "기능을 더 추가하자"가 아니라, 지금의 core MVP와 OpenClaw/Codex
자동화층을 어떻게 정리하고 확장할지 판단할 수 있어야 한다.

## 핵심 질문

1. Weaveflow의 core boundary와 personal automation boundary는 어디까지인가?
2. core Python CLI는 계속 local-first workflow kernel로만 남겨야 하는가?
3. OpenClaw/Codex runner는 core에 포함할 기능인가, 별도 personal automation
   package인가?
4. "수동 Codex brief"와 "자동 Codex job runner"를 같은 제품 안에서 어떻게 설명할
   것인가?
5. `.weaveflow/tasks/`와 `.weaveflow/jobs/`의 관계는 무엇인가?
6. task lifecycle과 job lifecycle은 통합해야 하는가, 분리해야 하는가?
7. 외부 채널에서 mutating action을 허용하기 위한 최소 safety contract는 무엇인가?
8. job runner가 commit/push까지 할 때 필요한 승인, branch, PR, rollback 정책은
   무엇인가?
9. Discord/OpenClaw 사용자에게 보여줄 UX는 task 중심이어야 하는가, job 중심이어야
   하는가?
10. 현재 문서와 코드의 모순을 어떤 순서로 정리해야 하는가?

## 제안할 산출물

아래 형식으로 답해라.

### 1. 현재 상태 진단

- core kernel
- adapter/bridge layer
- OpenClaw plugin layer
- Codex job runner layer
- 문서/계약 불일치

### 2. 권장 개발 방향

다음 중 하나를 선택하거나 혼합안을 제안해라.

- A. core CLI 중심: OpenClaw/Codex runner는 personal automation layer로 격리
- B. personal automation 중심: OpenClaw/Codex runner 사용성, 신뢰성, 비용/시간
  효율을 우선 개선
- C. unified workflow 중심: task와 job을 통합해 하나의 local workflow model로 확장

선택 이유와 포기하는 것을 명확히 적어라.

### 3. 권장 아키텍처

최소한 다음 boundary를 정의해라.

- `weaveflow-core`
- `weaveflow-adapters`
- `weaveflow-openclaw`
- `weaveflow-codex-runner`
- runtime state: `.weaveflow/tasks/` vs `.weaveflow/jobs/`
- public contracts and schema versioning

### 4. 마일스톤 3개

각 마일스톤마다 다음을 적어라.

- goal
- non-goals
- files/modules likely touched
- success criteria
- tests/verification
- risks
- stop criteria

### 5. 바로 실행 가능한 Codex 프롬프트

작고 독립적인 implementation prompt를 5-10개 제안해라. 각 프롬프트는 한 번의
Codex 작업으로 끝날 수 있어야 한다.

좋은 프롬프트 예시:

```text
현재 branch에서 README와 integration POC README가 Codex job runner tool surface를
정확히 설명하도록 문서만 업데이트해라. 코드 변경 금지. pytest와 npm test는 실행하지
않아도 되지만, 문서 링크와 tool 이름이 일치하는지 확인해라.
```

나쁜 프롬프트 예시:

```text
Weaveflow를 완성해줘.
```

## 설계 시 주의사항

- 외부 API 호출을 전제로 설계하지 마라.
- production deploy, secret 변경, DB migration 같은 고위험 자동화를 기본값으로
  허용하지 마라.
- "가능하다"와 "제품으로 안전하다"를 구분해라.
- 현재 runtime validation이 있었다고 해서 unattended automation이 충분히 신뢰
  가능하다고 단정하지 마라.
- 문서가 오래된 것인지, 코드가 너무 앞서간 것인지 판단하고 정리 순서를 제안해라.
- unknown은 unknown으로 남겨라.

# GPT Project Context Pack

이 디렉터리는 웹 GPT Pro 프로젝트에 업로드하거나 첫 대화에 붙여 넣기 위한
Weaveflow 사전지식 묶음이다.

생성 기준:

- 저장소: `/home/robros0/Desktop/ws/weaveflow`
- 브랜치: `poc/openclaw-codex-job-runner`
- 기준 커밋: `c1624e9 feat: integrate Codex job recovery planning`
- 작성일: 2026-05-14

## 권장 업로드 순서

1. `00_START_HERE_PROMPT.md`
2. `01_PROJECT_CONTEXT.md`
3. `02_CURRENT_ARCHITECTURE.md`
4. `03_REPOSITORY_MAP.md`
5. `04_NEXT_DESIGN_REQUEST.md`

`00_START_HERE_PROMPT.md`는 GPT 프로젝트를 처음 시작할 때 붙여 넣는 기본
프롬프트다. 나머지 파일은 프로젝트 지식 파일로 넣거나, 첫 대화에서 같이
첨부하면 된다.

## 중요한 해석 규칙

이 저장소에는 두 층이 공존한다.

- 원래 MVP: 로컬 파일 기반 Python CLI `weaveflow`
- 실험/확장층: OpenClaw stdio plugin POC와 Codex job runner

일부 오래된 README와 설계 문서는 아직 "OpenClaw 통합 없음", "Codex 자동 실행
없음"을 원래 MVP 비목표로 설명한다. 현재 브랜치에는 그 이후의 실험층이 이미
추가되어 있으므로, GPT는 "MVP의 안전한 핵심 계약"과 "실험적 통합층"을 분리해서
읽어야 한다.

## 업로드하지 않아도 되는 것

- `.weaveflow/` 런타임 상태
- `.pytest_cache/`, `__pycache__/`
- 로컬 환경 파일

필요하면 원본 저장소의 `README.md`, `AGENTS.md`, `docs/`, `schemas/`,
`src/weaveflow/`, `integrations/openclaw-weaveflow-stdio-poc/`를 추가로 업로드해도
된다.

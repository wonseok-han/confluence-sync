# 웹 서비스 배포·운영

웹 서비스를 직접 배포·운영하는 유지보수자를 위한 문서입니다. 패키지 설치와 CLI·웹 사용법은 [README](../README.md), npm 패키지 발행 절차는 [릴리스 안내](RELEASING.md)를 참고하세요.

## Vercel 배포

**Docker·Sandbox·로컬 CLI 설치 없이 사용할 수 있습니다.** Vercel에는 정적 웹과 Confluence 중계 API를 배포합니다. 문서 탐색·변환·서식·변경 확인 및 동기화 판단은 브라우저에서 기존 CLI와 같은 엔진으로 처리합니다.

```text
브라우저의 문서 폴더 ↔ 브라우저 Worker의 공통 CLI 엔진
                              ↕ Confluence 요청만
                       Vercel 중계 Functions ↔ Confluence Cloud
```

1. 저장소를 Vercel에 Import합니다. Framework는 **Other**, Build Command는 `npm run build`, Output Directory는 `dist/site`입니다. 저장소의 `vercel.json`에 설정되어 있습니다.
2. 발급된 `https://프로젝트명.vercel.app` 주소를 데스크톱 Chrome·Edge에서 엽니다. 별도 도메인이나 인증서를 준비할 필요가 없습니다.
3. **문서 폴더 열기**로 로컬 폴더의 읽기·쓰기 권한을 허용합니다. `.env`는 선택한 폴더에서 읽거나 웹의 가져오기 기능으로 설정합니다. 사용자의 Confluence 토큰을 Vercel 환경변수에 등록하지 않습니다.
4. 변환·문서 서식 정리·로컬 변경 확인은 문서 서버 전송 없이 동작합니다. 스페이스 연결 후 Fetch로 원격을 확인하고 Pull, 또는 문서 체크 → 업로드 미리보기 → Push를 사용합니다.

로컬 폴더 전체와 `.csync`를 서버에 복사하지 않습니다. Confluence 요청에 필요한 인증 정보, 선택한 문서 본문과 첨부는 중계 API를 거칩니다. 서버는 인증 정보를 저장하거나 쿠키로 유지하지 않습니다. 문서 미리보기·각주·콜아웃·표·위키링크 변환과 충돌 검사는 CLI와 같은 규칙을 사용합니다. PDF는 브라우저의 PDF.js와 Canvas로 이미지화합니다.

**큰 업로드에는 Private Blob 설정이 필요합니다.** 요청 본문이 3MiB를 넘는 첨부·문서 본문은 Vercel Functions의 요청 크기 제한을 피하도록 브라우저에서 비공개 임시 Blob에 직접 올립니다.

- Vercel 프로젝트의 Storage에 **Private Blob**을 연결하고 `BLOB_READ_WRITE_TOKEN`을 설정합니다. Public Blob은 사용하지 않습니다.
- `CRON_SECRET`에 충분히 긴 임의 값을 설정합니다. `vercel.json`의 일일 정리 작업이 전송 중단으로 남은 24시간 이상 된 임시 파일을 삭제합니다.
- 정상 전달하거나 전송을 실패한 임시 Blob은 중계 요청이 끝날 때 삭제합니다. 브라우저 종료·네트워크 단절로 전달 요청 자체가 발생하지 않은 파일은 일일 정리 대상입니다.
- 다운로드는 Functions에서 스트리밍합니다. Blob을 연결하지 않아도 작은 요청과 대용량 다운로드는 동작합니다. Blob 및 Functions에는 사용량에 따른 한도·요금이 적용됩니다.

파일당 100MiB·전체 512MiB·20,000개 한도를 유지합니다. 탭별 문서 핸들·가져온 연결 설정·비교 기준·실행 결과는 해당 브라우저의 IndexedDB에 보관하고 연결 해제 시 정리합니다. 새로고침으로 종료된 실행은 자동 재시작하지 않습니다. 원격 작업 중에는 탭을 열어 두세요. 중단 후에는 Fetch로 원격 상태를 먼저 확인하고 다시 미리보기합니다. 업로드 승인은 새로고침 후 다시 받아야 합니다. 실제 로컬 파일 적용은 기존과 같이 원본 재검사·충돌 차단·실패 시 복원을 거칩니다.

현재 배포 웹은 Atlassian Cloud HTTPS 주소만 지원합니다. Docker 기반 서버 배포와 로컬 `csync web`도 계속 사용할 수 있습니다. `csync web --ui`로 만든 명시적 로컬 실행기 연결 링크도 호환됩니다.

## Docker 배포

**내 컴퓨터에 CLI나 로컬 서버를 설치·실행하지 않아도 됩니다.** 배포 웹에서 브라우저의 폴더 읽기·쓰기 권한을 받고, Docker 서버가 사용자 세션별 임시 작업공간에서 기존 CLI의 공통 변환·동기화 로직을 처리합니다.

```text
배포 웹 접속 → 내 문서 폴더 선택·권한 허용 → .env 연결 설정
             → 변환·Fetch·Pull·Push → 브라우저가 로컬 폴더에 결과 반영
```

저장소 루트의 `Dockerfile`과 `compose.yaml`로 서버를 실행합니다.

```bash
docker compose up -d --build
```

기본 포트는 8080입니다. 실제 배포는 HTTPS 역방향 프록시 뒤에 두고 공개 주소를 지정하세요. 프록시는 Host와 파일 전송 요청·응답을 그대로 전달해야 합니다. 요청당 100MiB 이상 업로드와 긴 변환 요청을 허용하도록 설정하세요. 루트 경로에서 서비스합니다.

```bash
CSYNC_PUBLIC_URL=https://csync.example.com docker compose up -d --build
# 웹 포트 변경
CSYNC_WEB_PORT=8090 CSYNC_PUBLIC_URL=https://csync.example.com docker compose up -d --build

docker compose ps
docker compose logs -f web
docker compose down
```

재배포는 같은 설정으로 `docker compose up -d --build`를 실행합니다. Compose는 Confluence API 토큰 등 로컬 `.env`의 다른 값을 컨테이너 환경변수로 전달하지 않습니다. 서버에 Vault·`.env` 볼륨을 마운트하지 않습니다. Node 서버는 비관리자 사용자·읽기 전용 컨테이너에서 실행하고, `/tmp`의 1GiB 임시 메모리 파일시스템에서 작업합니다. `/healthz`로 프로세스 상태를 확인합니다. `unhealthy` 자체가 컨테이너를 자동 재시작시키지는 않습니다.

Compose 없이 실행하려면:

```bash
docker build -t csync-web .
docker run -d --name csync-web -p 8080:8080 \
  --read-only --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=1073741824 \
  -e CSYNC_PUBLIC_URL=https://csync.example.com csync-web
```

사용 흐름:

1. **데스크톱 Chrome·Edge**에서 HTTPS 주소에 접속합니다. 서버를 내 PC에서 테스트할 때는 `http://localhost`·`http://127.0.0.1`도 사용할 수 있습니다. Safari·Firefox·모바일에서는 현재 폴더 읽기·쓰기 기능을 지원하지 않습니다.
2. **문서 폴더 열기**로 Vault 또는 스페이스 폴더를 선택하고 읽기·쓰기 권한을 허용합니다. 브라우저는 선택한 폴더와 명시적으로 추가한 출력·참조 폴더만 사용합니다. 이 모드는 탭당 문서 폴더 하나를 기준으로 변환과 동기화를 사용합니다. 별도 작업공간은 새 탭에서 여세요.
3. 폴더의 `.env` 또는 가져온 `.env`로 Confluence 연결을 설정합니다. 배포 모드는 **Atlassian Cloud HTTPS 주소**만 지원합니다.
4. 문서 미리보기·표 편집·전체 변환·Fetch·업로드 선택·Push·Pull·복구를 사용합니다. 변환 결과를 저장할 **출력 폴더를 브라우저에서 선택**합니다. 원본 폴더를 선택해 같은 위치에 저장할 수도 있습니다. 원본을 덮어쓸 때는 변경 파일 목록을 확인한 뒤 저장합니다. 출력 폴더의 기존 파일도 덮어쓰기 검사를 위해 서버에 전달하므로 전용 결과 폴더를 선택하세요. 참조 폴더는 읽기 전용입니다. 로컬의 임의 절대 경로를 문자열로 입력하는 방식은 사용하지 않습니다.
5. Pull·표 편집·복구 및 `.csync` 변경 결과는 브라우저가 선택한 폴더에 기록합니다. 서버에 보냈던 해시와 로컬 파일을 다시 비교해 작업 중 편집된 파일을 덮어쓰지 않습니다. 저장 실패 시 현재 결과를 보관하고 **다시 적용 확인**으로 재시도합니다. 추가 편집이 없는 적용분만 되돌리며, 브라우저의 여러 파일 쓰기는 OS 수준의 단일 트랜잭션이 아닙니다.
6. **폴더 연결 해제**는 서버 세션과 현재 탭의 연결 정보를 정리합니다. 실행·적용 중에는 해제하지 않습니다. 폴더 핸들과 로컬 비교 해시는 IndexedDB, 세션 키는 해당 탭의 sessionStorage에 보관합니다. 새로고침 시 권한·세션이 유효하면 이어서 사용하고, 권한이 해제되었다면 다시 허용해야 합니다.

선택한 문서·출력·참조 폴더의 파일 및 `.csync`·`.env`와 가져온 인증 정보는 **처리에 필요한 동안 서버로 전송**됩니다. 서버는 브라우저 세션마다 별도 임시 디렉터리·실행 상태·토큰을 사용하며, 다른 세션의 파일과 작업에 접근할 수 없습니다. 서버 요청이 30분 동안 없거나 연결을 해제하면 정리하고, 컨테이너를 제거하면 tmpfs 내용도 사라집니다. `.git`·`.obsidian`·`node_modules` 등은 전송하지 않습니다. 참조 폴더의 `.env`도 전송하지 않습니다. 파일당 100MiB·탭당 전체 512MiB·20,000개, 서버 동시 세션 8개 한도를 사용하며 실제 여유 공간은 서버의 tmpfs 용량에 따라 달라집니다.

이 Docker 배포 방식은 Node API 서버를 사용합니다. Vercel 배포 방식은 위 절의 정적 웹 + 중계 Functions 구성을 사용합니다. 기존 `csync web`의 로컬 전용 실행과 `--ui` 로컬 연결 방식은 호환용으로 유지하지만, **Docker 배포의 기본 경로에는 로컬 csync가 필요하지 않습니다.** 서버에서 직접 실행할 때는 `csync web --hosted --port 8080 --no-open`을 사용할 수 있습니다.

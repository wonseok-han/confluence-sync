# 릴리스 절차

배포 권한을 가진 유지보수자를 위한 문서입니다. 패키지 사용자는 [README](../../README.md), 변경 이력은 [CHANGELOG](../../CHANGELOG.md)를 참고하세요.

## 배포 준비

1. 릴리스 PR의 변경 사항과 Linux/macOS/Windows × Node.js 22/24 CI 결과를 확인합니다.
2. `CHANGELOG.md`의 해당 버전 설명이 최종 동작과 일치하는지 확인합니다.
3. `package.json`과 `package-lock.json`의 버전, 기존 Git 태그와 npm 발행 버전을 확인합니다. 이미 배포할 버전으로 변경되어 있으면 `npm version`을 다시 실행하지 않습니다.
4. `npm test`, `npm pack --dry-run`과 임시 디렉토리에 설치한 패키지의 CLI 도움말·변환을 확인합니다. 실제 `.env`·문서·계정 정보가 패키지에 포함되지 않는지도 확인합니다.

```bash
npm version patch --no-git-tag-version # 버전을 새로 올릴 때만 사용; minor 또는 major 선택 가능
```

## 배포 실행

준비한 변경을 커밋·푸시하고 PR을 main에 병합합니다. 병합된 main의 CI가 통과하면 해당 커밋에 버전 태그를 생성하고 그 태그만 푸시합니다. 태그 푸시는 실제 npm 발행과 GitHub Release 생성을 시작하므로 준비 단계와 구분합니다.

```bash
git switch main
git pull --ff-only origin main
release_version=$(node -p "require('./package.json').version")
git tag -a "v$release_version" -m "Release v$release_version"
git push origin "v$release_version"
```

[릴리스 워크플로](../../.github/workflows/release.yml)는 버전 태그를 받으면 의존성 설치와 테스트를 수행합니다. `package.json` 버전과 태그가 일치하는지 확인한 뒤 npm 패키지를 발행하고 GitHub Release를 생성합니다.

npm 발행에는 Trusted Publishing(OIDC)을 사용합니다. npm 패키지의 신뢰 발행자 설정이 이 저장소와 릴리스 워크플로를 가리켜야 합니다.

- 패키지: `@wonseok-han/confluence-sync`
- GitHub owner/repository: `wonseok-han/confluence-sync`
- 워크플로 파일: `release.yml`

최초 설정이나 변경 후에는 npm의 신뢰 발행자 설정 화면도 확인하세요. 로컬 테스트와 pack 성공만으로 외부 신뢰 발행자 설정까지 검증되지는 않습니다.

릴리스 노트는 `CHANGELOG.md`의 해당 버전 섹션을 사용합니다. 해당 섹션이 없으면 이전 태그 이후의 커밋 목록으로 대체합니다.

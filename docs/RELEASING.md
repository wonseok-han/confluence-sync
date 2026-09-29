# 릴리스 절차

배포 권한을 가진 유지보수자를 위한 문서입니다. 패키지 사용자는 [README](../README.md), 변경 이력은 [CHANGELOG](../CHANGELOG.md)를 참고하세요.

## 배포 준비

1. 배포할 변경 사항과 CI 결과를 확인합니다.
2. `CHANGELOG.md`에 다음 버전의 변경 사항을 기록합니다.
3. 버전을 올리고 생성된 커밋과 태그를 확인합니다.

```bash
npm version patch     # 변경 범위에 따라 minor 또는 major
```

## 배포 실행

버전 커밋과 태그를 원격 저장소에 푸시합니다.

```bash
git push
git push --tags
```

[릴리스 워크플로](../.github/workflows/release.yml)는 버전 태그를 받으면 의존성 설치와 테스트를 수행합니다. `package.json` 버전과 태그가 일치하는지 확인한 뒤 npm 패키지를 발행하고 GitHub Release를 생성합니다.

npm 발행에는 Trusted Publishing(OIDC)을 사용합니다. npm 패키지의 신뢰 발행자 설정이 이 저장소와 릴리스 워크플로를 가리켜야 합니다.

릴리스 노트는 `CHANGELOG.md`의 해당 버전 섹션을 사용합니다. 해당 섹션이 없으면 이전 태그 이후의 커밋 목록으로 대체합니다.

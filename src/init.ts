/**
 * `confluence-sync init` — 대화형으로 cwd 에 .env 를 생성한다.
 * TTY 가 아니면(파이프/CI) 값 없는 빈 템플릿을 쓴다. 토큰 입력은 *로 가린다.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { bold, cyan, dim, green, red, yellow } from './colors.js';

type Field = {
  key: string;
  hint: string;
  secret?: boolean;
  optional?: boolean;
  def?: string;
};

/** 일반 한 줄 입력(에코 표시). 매 질문마다 readline 을 새로 열고 닫아 stdin 경쟁을 피한다. */
async function promptLine(query: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

/** 비밀 입력: raw 모드로 직접 읽어 *로 가린다(readline 미사용 → 에코 충돌 없음). */
function promptSecret(query: string): Promise<string> {
  return new Promise((resolve) => {
    output.write(query);
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();
    let val = '';
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { // Enter / Ctrl+D
          cleanup();
          output.write('\n');
          resolve(val.trim());
          return;
        }
        if (ch === '\u0003') { // Ctrl+C
          cleanup();
          output.write('\n');
          process.exit(1);
        }
        if (ch === '\u007f' || ch === '\b') { // Backspace
          if (val.length) {
            val = val.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          val += ch;
          output.write('*');
        }
      }
    };
    input.on('data', onData);
  });
}

export async function runInit(argv: string[]): Promise<void> {
  const target = resolve(process.cwd(), '.env');
  const force = argv.includes('--force');

  const fields: Field[] = [
    { key: 'CONFLUENCE_BASE_URL', hint: 'https://api.atlassian.com/ex/confluence/<CLOUD_ID>/wiki 형식 (CLOUD_ID: <도메인>.atlassian.net/_edge/tenant_info 에서 확인)' },
    { key: 'CONFLUENCE_EMAIL', hint: 'Atlassian 계정 이메일' },
    { key: 'CONFLUENCE_API_TOKEN', hint: 'Scoped API 토큰 (id.atlassian.com → Create API token with scopes). 입력은 가려집니다', secret: true },
    { key: 'CONFLUENCE_SPACE_KEY', hint: 'URL .../wiki/spaces/<KEY>/... 의 KEY' },
    { key: 'CONFLUENCE_PARENT_ID', hint: '루트 앵커(페이지 또는 폴더 id). 비우면 공간 최상위', optional: true },
    { key: 'CONFLUENCE_SYNC_BASE', hint: `동기화 루트 디렉토리 (기본: ${process.cwd()})`, optional: true, def: process.cwd() },
  ];

  const renderEnv = (vals: Record<string, string>) =>
    '# confluence-sync 설정 (confluence-sync init 으로 생성)\n\n' +
    fields.map((f) => `# ${f.hint}\n${f.key}=${vals[f.key] ?? ''}`).join('\n\n') +
    '\n';

  // 덮어쓰기 가드
  if (existsSync(target) && !force) {
    if (!input.isTTY) {
      console.error(red(`✗ .env 가 이미 있습니다: ${target}`) + `\n  덮어쓰려면:  ${cyan('confluence-sync init --force')}`);
      process.exit(1);
    }
    const rlConfirm = createInterface({ input, output });
    const ans = await rlConfirm.question(`.env 가 이미 존재합니다 (${target}). 덮어쓸까요? [y/N] `);
    rlConfirm.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log('취소했습니다.');
      return;
    }
  }

  // 비대화형(파이프/CI): 값 없이 빈 템플릿만 생성
  if (!input.isTTY) {
    writeFileSync(target, renderEnv({}));
    console.log(`템플릿 .env 를 생성했습니다: ${target}\n각 값을 채워 넣으세요.`);
    return;
  }

  // 대화형 마법사
  console.log(bold('confluence-sync .env 설정 마법사'));
  console.log(dim('각 항목을 입력하세요. (Enter 로 비우면 빈 값 또는 기본값)\n'));
  const values: Record<string, string> = {};
  try {
    for (const f of fields) {
      const label = `${cyan(f.key)}${f.optional ? dim(' (선택)') : ''}\n  ${dim(f.hint)}\n  ${cyan('>')} `;
      let v = f.secret ? await promptSecret(label) : await promptLine(label);
      if (!v && f.def) v = f.def;
      values[f.key] = v;
    }
  } catch (e) {
    // 일반 입력에서 Ctrl+D(EOF) → AbortError. 깔끔히 취소
    if ((e as { name?: string })?.name === 'AbortError') {
      output.write(yellow('\n취소했습니다. (.env 미생성)\n'));
      return;
    }
    throw e;
  }

  writeFileSync(target, renderEnv(values));
  console.log(green(`\n✓ .env 생성 완료: ${target}`));
  console.log(`  다음으로:  ${cyan('confluence-sync --dry-run')}  ${dim('(대상·상태 미리보기)')}`);
}

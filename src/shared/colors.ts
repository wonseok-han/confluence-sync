/**
 * 의존성 없는 ANSI 컬러 헬퍼.
 * 비활성 조건: NO_COLOR / TERM=dumb / --no-color / 출력이 TTY 가 아님(파이프·리다이렉트).
 * FORCE_COLOR 가 있으면 강제 활성.
 */
const enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  !process.argv.includes('--no-color') &&
  (process.env.FORCE_COLOR ? true : process.stdout.isTTY === true);

const wrap = (open: number, close: number) => (s: string | number) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

export const colorEnabled = (): boolean => enabled;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function check(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export function shortText(value, max, label) {
  check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, 400, `${label}须为 1–${max} 个字符`);
  return value.trim();
}

import { randomUUID } from 'node:crypto';
import { digest, secret } from './store.mjs';
import { check, shortText } from './validation.mjs';

const REVIEW_DURATION = 30 * 60 * 1000;
const MAX_COMMENTS = 3;

export function createReviews(room) {
  const grants = new Map();
  function list() {
    for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(id);
    return [...grants.values()].map(({ id, expiresAt, ip }) => ({ id, expiresAt, ip }));
  }
  function grantFor(token, ip) {
    list();
    const hash = digest(token || '');
    const grant = [...grants.values()].find(({ tokenHash }) => tokenHash === hash);
    check(grant && ip && (!grant.ip || grant.ip === ip), 403, '评审链接无效、已过期或已绑定其他地址');
    grant.ip = ip;
    return grant;
  }
  return {
    list,
    issue(input) {
      check(list().length < 16, 409, '活动评审链接过多，请先撤销其中一个');
      const context = shortText(input.context, 9000, '评审材料');
      const id = randomUUID(), token = secret(), expiresAt = Date.now() + REVIEW_DURATION;
      const packet = { reviewId: id, title: room.state.title, context, createdAt: Date.now() };
      grants.set(id, { id, tokenHash: digest(token), expiresAt, packet, comments: new Map(), ip: null });
      return { id, token, expiresAt };
    },
    revoke(id) { grants.delete(id); },
    read(token, ip) {
      const grant = grantFor(token, ip);
      return { ...grant.packet, expiresAt: grant.expiresAt, remainingComments: MAX_COMMENTS - grant.comments.size };
    },
    comment(token, ip, input) {
      const text = shortText(input.text, 6000, '评审意见');
      const requestId = shortText(input.requestId, 100, '请求标识');
      const grant = grantFor(token, ip);
      const existing = grant.comments.get(requestId);
      if (existing) {
        check(existing.text === text, 409, '相同请求标识已有其他意见');
        return existing;
      }
      check(grant.comments.size < MAX_COMMENTS, 429, '已达到该链接的评审意见上限');
      const message = room.postReview(ip, text);
      grant.comments.set(requestId, message);
      return message;
    },
  };
}

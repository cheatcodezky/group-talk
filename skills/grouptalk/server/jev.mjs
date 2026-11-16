export class JevJudge {
  constructor({ key = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY, endpoint = 'https://api.typesafe.ai/v1/systemone', model = 'jev-1.14.0', timeout = 3000, fetcher = fetch } = {}) {
    Object.assign(this, { key, endpoint, model, timeout, fetcher });
  }
  get ready() { return Boolean(this.key); }
  async evaluate(state, signal) {
    if (!this.ready) throw new Error('尚未配置 TYPESAFE_API_KEY，继续使用 @Codex 即可');
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]),
      body: JSON.stringify({ model: this.model, state, questions: {
        information_gap: { type: 'noul', instructions: '当前多人讨论是否存在尚未解决、适合 AI 补充的明确信息缺口？如果只是闲聊、已经有人回答、要求 AI 保持沉默或缺少背景，回答否。' },
        needs_clarification: { type: 'noul', instructions: '当前需求或方案是否存在阻碍讨论的关键歧义，且 AI 此时提出一个澄清问题会有帮助？不要把普通的意见差异当作阻碍。' },
      } }),
    });
    if (!response.ok) throw new Error(`Jev 暂不可用（HTTP ${response.status}），已退回点名模式`);
    const result = await response.json();
    const gap = result.answers?.information_gap?.noul;
    const clarify = result.answers?.needs_clarification?.noul;
    if (![gap, clarify].every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1)) throw new Error('Jev 返回格式不正确，已退回点名模式');
    return { gap, clarify, tokens: Number(result.usage?.input_tokens) || 0, model: result.model || this.model };
  }
}

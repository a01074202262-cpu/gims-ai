'use strict';
const gemini = require('./gemini');
// Python 코드를 Gemini 코드 실행 샌드박스에서 실행한다. 이 서버 프로세스에서는 아무 코드도 실행하지 않는다.
// 주의: 실제 실행은 모델이 맡으므로 출력이 입력 코드와 일치하는지는 보장되지 않는다. 중요한 결과는 교차 확인하라.
const MAX_CODE = 8000;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });

const IMPL = {};
IMPL.run_python_sandbox = async ({ code, stdin = '' }, ctx = {}) => {
  if (!ctx.base || !ctx.key || !ctx.model) throw new Error('샌드박스 컨텍스트가 없습니다');
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE) throw new Error(`code 는 1~${MAX_CODE}자여야 합니다`);
  const prompt = `아래 Python 코드를 코드 실행 도구로 그대로 실행하고, 출력과 오류만 보고하라. 코드를 수정하지 마라.\n${stdin ? `[표준입력]\n${String(stdin).slice(0, 2000)}\n` : ''}\n\`\`\`python\n${code}\n\`\`\``;
  const j = await gemini.generateContent({
    base: ctx.base, key: ctx.key, model: ctx.model,
    signal: AbortSignal.timeout(30_000),
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ codeExecution: {} }],
      generationConfig: { temperature: 0 }
    }
  });
  const parts = j.candidates?.[0]?.content?.parts || [];
  const results = parts.filter(p => p.codeExecutionResult).map(p => ({
    outcome: p.codeExecutionResult.outcome,
    output: String(p.codeExecutionResult.output || '').slice(0, 3000)
  }));
  if (!results.length) throw new Error('실행 결과가 없습니다');
  return { results };
};

const DECL = [
  { name: 'run_python_sandbox', description: 'Python 코드를 샌드박스에서 실행하고 출력을 받는다. 계산 검증, 테스트 실행, 데이터 처리 확인에 사용.',
    parameters: OBJ({ code: S('STRING', '실행할 Python 코드'), stdin: S('STRING', '표준 입력 (선택)') }, ['code']) }
];

module.exports = { DECL, IMPL };

// 持久化包集成测试 —— 直接加载本仓库的实际模块，
// mock 一个 Cordis ctx，验证 apply() 注册的 llm/stream 与 agent/request-error 行为。
// 这验证的是真实落盘代码，而非算法副本。

const MODULE_PATH = new URL('../lib/index.js', import.meta.url).href

const m = await import(MODULE_PATH)

const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail })
}

check('模块导出 name', m.name === 'repetition-guard', String(m.name))
check('模块导出 apply', typeof m.apply === 'function', typeof m.apply)

// ── mock Cordis ctx ───────────────────────────────────────────
function makeCtx() {
  const handlers = {}
  const logs = []
  const ctx = {
    logger: { info: (msg) => logs.push(msg) },
    on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name] } },
  }
  return { ctx, handlers, logs }
}

const { ctx, handlers, logs } = makeCtx()
m.apply(ctx, { verbose: true })

check('注册了 llm/stream', typeof handlers['llm/stream'] === 'function', Object.keys(handlers).join(','))
check('注册了 agent/request-error', typeof handlers['agent/request-error'] === 'function', Object.keys(handlers).join(','))
check('启动日志已输出', logs.some(l => l.includes('active')), logs[0] || '')

const handler = handlers['llm/stream']

// 构造流并跑过真实监听器
async function run(text, type, purpose, h) {
  const inner = (async function* () {
    yield { type: 'block-start', index: 0, blockType: type === 'reasoning-delta' ? 'reasoning' : 'text' }
    for (let i = 0; i < text.length; i += 5) {
      yield { type, index: 0, text: text.slice(i, i + 5) }
    }
    yield { type: 'block-end', index: 0, block: { type: type === 'reasoning-delta' ? 'reasoning' : 'text', text } }
  })()
  const options = { provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' }
  if (purpose !== undefined) options.purpose = purpose
  const stream = (h || handler)(options, () => inner)
  const out = []
  for await (const c of stream) out.push(c)
  return out
}

// ── 基础抑制行为（回归） ──────────────────────────────────────
{
  const text = 'ok '.repeat(200)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  const fwd = out.filter(c => c.type === 'reasoning-delta').reduce((a, c) => a + c.text.length, 0)
  check('ok 死循环 delta 削减', fwd < text.length * 0.5, `${fwd}/${text.length}`)
  check('ok 死循环 block-end 清除', be.block.text.length <= 8, `len=${be.block.text.length}`)
}
{
  const text = '好的，马上 '.repeat(80)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('好的马上 block-end 清除', be.block.text.length <= 16, `len=${be.block.text.length}`)
}
{
  const text = '我需要检查配置文件。首先看 baseURL 是否指向本地网关。端口 23091 是 web 服务。模型网关在 7863。因此问题在流式解析层。接下来验证 block-end 语义。'
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('正常文本透传', be.block.text === text, `len=${be.block.text.length}`)
}
{
  const junk = 'ok '.repeat(120)
  const good = '现在重新分析：根因是缓冲区没有上限，需要在写入前做长度检查。'
  const out = await run(junk + good, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('循环后恢复保留有效内容', be.block.text.includes('根因是缓冲区没有上限'), JSON.stringify(be.block.text.slice(-24)))
  check('循环后恢复清除垃圾', be.block.text.length < junk.length, `len=${be.block.text.length} < ${junk.length}`)
}
{
  const out = await run('-'.repeat(400), 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('分隔线不误伤', be.block.text.length === 400, `len=${be.block.text.length}`)
}
{
  const out = await run('ok '.repeat(200), 'reasoning-delta', 'session-title')
  const be = out.find(c => c.type === 'block-end')
  check('辅助调用跳过抑制', be.block.text.length === 600, `len=${be.block.text.length}`)
}
{
  const { ctx: ctx2, handlers: h2 } = makeCtx()
  m.apply(ctx2, { models: ['global:deepseek-v4.1-flash'] })
  const inner = (async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'ok '.repeat(200) } }
  })()
  const out = []
  for await (const c of h2['llm/stream']({ provider: 'workbuddy', model: 'other-model' }, () => inner)) out.push(c)
  check('模型不匹配跳过', out[0].block.text.length === 600, `len=${out[0].block.text.length}`)
}
{
  const inner = (async function* () {
    yield { type: 'reasoning-delta', index: 0, text: null }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'tail' } }
  })()
  const stream = handler({ provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' }, () => inner)
  const out = []
  let threw = false
  try { for await (const c of stream) out.push(c) } catch (err) { threw = true }
  check('异常输入不中断流', threw === false && out.length >= 1, `out=${out.length} threw=${threw}`)
}

// ── 熔断后的恢复链路（新增） ──────────────────────────────────
{
  const out = await run('ok '.repeat(4000), 'reasoning-delta')
  const last = out[out.length - 1]
  check('熔断发出 finish', last.type === 'finish', last.type)
  check('熔断用 error 而非 stop（关键）', last.reason.kind === 'error', last.reason.kind)
  check('failure.code = REPETITION_LOOP', last.reason.failure.code === 'REPETITION_LOOP', String(last.reason.failure.code))
  check('failure 带可读 message', typeof last.reason.failure.message === 'string' && last.reason.failure.message.length > 0, last.reason.failure.message)
}

// agent/request-error 的重试裁决
const errHandler = handlers['agent/request-error']
{
  const payload = { agent: { id: 'sess-A' }, turn: 1, step: 1, provider: 'workbuddy', failure: { code: 'REPETITION_LOOP', message: 'loop' }, signal: {} }
  const a1 = await errHandler(payload, () => Promise.resolve(undefined))
  check('首次循环错误 -> retry', a1 !== undefined && a1.kind === 'retry', JSON.stringify(a1))
  const a2 = await errHandler(payload, () => Promise.resolve(undefined))
  check('第二次循环错误 -> retry', a2 !== undefined && a2.kind === 'retry', JSON.stringify(a2))
  const a3 = await errHandler(payload, () => Promise.resolve(undefined))
  check('超 maxLoopRetries 后放行（任务终止而非死循环）', a3 === undefined, JSON.stringify(a3))
}
{
  const payload = { agent: { id: 'sess-B' }, turn: 2, step: 1, provider: 'workbuddy', failure: { code: 'SOME_OTHER_ERROR', message: 'x' }, signal: {} }
  const a = await errHandler(payload, () => Promise.resolve({ kind: 'retry' }))
  check('非循环错误不劫持（透传下游裁决）', a !== undefined && a.kind === 'retry', JSON.stringify(a))
}
{
  const payload = { agent: { id: 'sess-C' }, turn: 3, step: 1, failure: undefined }
  let threw = false
  let a
  try { a = await errHandler(payload, () => Promise.resolve(undefined)) } catch (err) { threw = true }
  check('failure 缺失时不抛异常', threw === false && a === undefined, `threw=${threw}`)
}

// ── hardStopMode 分支 ─────────────────────────────────────────
{
  const { ctx: ctx3, handlers: h3 } = makeCtx()
  m.apply(ctx3, { hardStopMode: 'stop' })
  const out = await run('ok '.repeat(4000), 'reasoning-delta', undefined, h3['llm/stream'])
  const last = out[out.length - 1]
  check("hardStopMode:'stop' 仍发 stop（旧行为可选）", last.type === 'finish' && last.reason.kind === 'stop', JSON.stringify(last.reason))
}
{
  const { ctx: ctx4, handlers: h4 } = makeCtx()
  m.apply(ctx4, { hardStopMode: 'off' })
  const out = await run('ok '.repeat(4000), 'reasoning-delta', undefined, h4['llm/stream'])
  const hasFinish = out.some(c => c.type === 'finish')
  check("hardStopMode:'off' 不熔断（只抑制）", hasFinish === false, `finish=${hasFinish}`)
}

let pass = 0, fail = 0
for (const r of results) {
  if (r.pass) pass++; else fail++
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
}
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)

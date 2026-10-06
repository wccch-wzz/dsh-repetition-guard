// 持久化包集成测试 —— 直接加载本仓库的实际模块，
// mock 一个 Cordis ctx，验证 apply() 注册的 llm/stream 监听器行为。
// 这验证的是真实落盘代码，而非算法副本。

const MODULE_PATH = new URL('../lib/index.js', import.meta.url).href

const m = await import(MODULE_PATH)

const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail })
}

check('模块导出 name', m.name === 'repetition-guard', String(m.name))
check('模块导出 apply', typeof m.apply === 'function', typeof m.apply)

// mock Cordis ctx
const handlers = {}
const logs = []
const ctx = {
  logger: { info: (msg) => logs.push(msg) },
  on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name] } },
}

m.apply(ctx, { verbose: true })

check('注册了 llm/stream 监听器', typeof handlers['llm/stream'] === 'function', Object.keys(handlers).join(','))
check('启动日志已输出', logs.some(l => l.includes('active')), logs[0] || '')

const handler = handlers['llm/stream']

// 构造流并跑过真实监听器
async function run(text, type, purpose) {
  const inner = (async function* () {
    yield { type: 'block-start', index: 0, blockType: type === 'reasoning-delta' ? 'reasoning' : 'text' }
    for (let i = 0; i < text.length; i += 5) {
      yield { type, index: 0, text: text.slice(i, i + 5) }
    }
    yield { type: 'block-end', index: 0, block: { type: type === 'reasoning-delta' ? 'reasoning' : 'text', text } }
  })()
  const options = { provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' }
  if (purpose !== undefined) options.purpose = purpose
  const stream = handler(options, () => inner)
  const out = []
  for await (const c of stream) out.push(c)
  return out
}

// 1: ok 死循环
{
  const text = 'ok '.repeat(200)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  const fwd = out.filter(c => c.type === 'reasoning-delta').reduce((a, c) => a + c.text.length, 0)
  check('持久化包: ok 死循环 delta 削减', fwd < text.length * 0.5, `${fwd}/${text.length}`)
  check('持久化包: ok 死循环 block-end 清除', be.block.text.length <= 8, `len=${be.block.text.length}`)
}

// 2: 好的，马上 循环
{
  const text = '好的，马上 '.repeat(80)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('持久化包: 好的马上 block-end 清除', be.block.text.length <= 16, `len=${be.block.text.length}`)
}

// 3: 正常文本透传
{
  const text = '我需要检查配置文件。首先看 baseURL 是否指向本地网关。端口 23091 是 web 服务。模型网关在 7863。因此问题在流式解析层。接下来验证 block-end 语义。'
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('持久化包: 正常文本透传', be.block.text === text, `len=${be.block.text.length}`)
}

// 4: 循环后恢复
{
  const junk = 'ok '.repeat(120)
  const good = '现在重新分析：根因是缓冲区没有上限，需要在写入前做长度检查。'
  const out = await run(junk + good, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('持久化包: 循环后恢复保留有效内容', be.block.text.includes('根因是缓冲区没有上限'), JSON.stringify(be.block.text.slice(-24)))
  check('持久化包: 循环后恢复清除垃圾', be.block.text.length < junk.length, `len=${be.block.text.length} < ${junk.length}`)
}

// 5: 纯符号不误伤
{
  const out = await run('-'.repeat(400), 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('持久化包: 分隔线不误伤', be.block.text.length === 400, `len=${be.block.text.length}`)
}

// 6: 辅助调用默认跳过
{
  const text = 'ok '.repeat(200)
  const out = await run(text, 'reasoning-delta', 'session-title')
  const be = out.find(c => c.type === 'block-end')
  check('持久化包: 辅助调用跳过抑制', be.block.text.length === text.length, `len=${be.block.text.length}`)
}

// 7: 模型不匹配跳过（用收窄配置的独立 ctx —— 默认 ['*'] 是全匹配，必须显式收窄）
{
  const h2 = {}
  const ctx2 = { logger: { info: () => {} }, on: (n, f) => { h2[n] = f } }
  m.apply(ctx2, { models: ['global:deepseek-v4.1-flash'] })
  const inner = (async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'ok '.repeat(200) } }
  })()
  const out = []
  for await (const c of h2['llm/stream']({ provider: 'workbuddy', model: 'other-model' }, () => inner)) out.push(c)
  check('持久化包: 模型不匹配跳过', out[0].block.text.length === 600, `len=${out[0].block.text.length}`)
}

// 8: 检测层崩溃时降级透传
{
  const inner = (async function* () {
    yield { type: 'reasoning-delta', index: 0, text: null } // 触发内部异常
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'tail' } }
  })()
  const stream = handler({ provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' }, () => inner)
  const out = []
  let threw = false
  try {
    for await (const c of stream) out.push(c)
  } catch (err) { threw = true }
  check('持久化包: 异常输入不中断流', threw === false && out.length >= 1, `out=${out.length} threw=${threw}`)
}

let pass = 0, fail = 0
for (const r of results) {
  if (r.pass) pass++; else fail++
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
}
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)

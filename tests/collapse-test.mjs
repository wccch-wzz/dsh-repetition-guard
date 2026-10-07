// 塌缩检测集成测试：加载真实落盘模块，验证不规律循环能被抑制且危险样本不误伤

const MODULE_PATH = new URL('../lib/index.js', import.meta.url).href
const m = await import(MODULE_PATH)

const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail })
}

function makeCtx(config) {
  const handlers = {}
  const logs = []
  const ctx = {
    logger: { info: (msg) => logs.push(msg) },
    on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name] } },
  }
  m.apply(ctx, config || { verbose: true })
  return { ctx, handlers, logs }
}

const { handlers, logs } = makeCtx()
const handler = handlers['llm/stream']

check('模块导出 name', m.name === 'repetition-guard', String(m.name))
check('注册 llm/stream', typeof handler === 'function', Object.keys(handlers).join(','))
check('注册 agent/request-error', typeof handlers['agent/request-error'] === 'function', '')
check('启动日志含 collapse 配置', logs.some(l => l.includes('collapse=true')), logs[0] || '')

async function run(text, type, opts) {
  const step = (opts && opts.step) || 16
  const inner = (async function* () {
    yield { type: 'block-start', index: 0, blockType: type === 'reasoning-delta' ? 'reasoning' : 'text' }
    for (let i = 0; i < text.length; i += step) {
      yield { type, index: 0, text: text.slice(i, i + step) }
    }
    yield { type: 'block-end', index: 0, block: { type: type === 'reasoning-delta' ? 'reasoning' : 'text', text } }
  })()
  const out = []
  for await (const c of handler({ provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' }, () => inner)) out.push(c)
  return out
}

function irregular(seed, count) {
  const w = ['**执行。**', '**写。**', '生成。', '好。', '**执行。**', '**写。**']
  let s = seed, o = ''
  for (let i = 0; i < count; i++) { s = (s * 1103515245 + 12345) % 2147483648; o += w[s % w.length] }
  return o
}

// ── 新增能力：不规律循环 ──────────────────────────────────────
{
  const text = irregular(12345, 600)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('不规律混排(种子1): 被抑制', be.block.text.length < text.length * 0.3,
    `${be.block.text.length}/${text.length}`)
}
{
  const text = irregular(99999, 600)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('不规律混排(种子2): 被抑制', be.block.text.length < text.length * 0.3,
    `${be.block.text.length}/${text.length}`)
}
{
  // 三词不规律
  const w = ['执行。', '写。', '好。']
  let s = 4242, text = ''
  for (let i = 0; i < 600; i++) { s = (s * 1103515245 + 12345) % 2147483648; text += w[s % 3] }
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('三词不规律混排: 被抑制', be.block.text.length < text.length * 0.3,
    `${be.block.text.length}/${text.length}`)
}
{
  // 塌缩前有正常内容，应保留
  const head = '我需要检查配置文件的加载顺序，先看 provider 的 baseURL 是否指向本地网关，端口 23091 是 web 服务。'
  const text = head + irregular(777, 400)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('塌缩前有效内容保留', be.block.text.startsWith('我需要检查配置文件'), JSON.stringify(be.block.text.slice(0, 18)))
  check('塌缩部分被切除', be.block.text.length < head.length + 200,
    `${be.block.text.length} vs 头${head.length}`)
}

// ── 回归：周期循环仍然有效 ────────────────────────────────────
{
  const text = 'ok '.repeat(200)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('回归 ok 循环: 仍被清除', be.block.text.length <= 8, `len=${be.block.text.length}`)
}
{
  const text = '好的，马上 '.repeat(80)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('回归 好的马上循环: 仍被清除', be.block.text.length <= 16, `len=${be.block.text.length}`)
}
{
  const junk = 'ok '.repeat(120)
  const good = '现在重新分析：根因是缓冲区没有上限，需要在写入前做长度检查。'
  const out = await run(junk + good, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('回归 循环后恢复: 尾段保留', be.block.text.includes('根因是缓冲区没有上限'),
    JSON.stringify(be.block.text.slice(-22)))
}

// ── 误伤防护 ──────────────────────────────────────────────────
{
  const text = '我需要检查配置文件的加载顺序，首先看 provider 的 baseURL 是否指向本地网关。端口 23091 看起来是 web 服务，不是模型网关。模型网关在 7863，走的是 openai-completions 协议。因此问题不在网络层，而在流式解析层。'
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('正常中文: 零改动', be.block.text === text, `len=${be.block.text.length}`)
}
{
  const json = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i, name: 'item' + i, ok: true })), null, 1)
  const out = await run(json, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: JSON 数组不误伤', be.block.text === json, `len=${be.block.text.length}`)
}
{
  const code = Array.from({ length: 25 }, (_, i) => `  const v${i} = read(${i})\n  if (v${i} === null) return null`).join('\n')
  const out = await run(code, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 相似代码行不误伤', be.block.text === code, `len=${be.block.text.length}`)
}
{
  const text = '- 检查 baseURL 指向\n- 确认端口归属\n- 验证协议类型\n'.repeat(3)
  const out = await run(text, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 列表重复3次不误伤', be.block.text === text, `len=${be.block.text.length}`)
}
{
  const out = await run('-'.repeat(400), 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 分隔线不误伤', be.block.text.length === 400, `len=${be.block.text.length}`)
}
{
  const b64 = 'Y29uc3QgY2ZnID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVFMsIGNvbmZpZykKY3R4Lm9uKCdsbG0vc3RyZWFtJywgKG9wdGlvbnMsIG5leHQpID0+IHsKfSk='
  const out = await run(b64, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: base64 不误伤', be.block.text === b64, `len=${be.block.text.length}`)
}
{
  // 日志行：结构固定，只有数字变化
  const logs = Array.from({ length: 40 }, (_, i) =>
    `2026-10-07 01:${String(i % 60).padStart(2, '0')}:12 INFO  request id=${1000 + i} handled in ${20 + i}ms status=200`).join('\n')
  const out = await run(logs, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 日志行不误伤', be.block.text === logs, `len=${be.block.text.length}`)
}
{
  // 数值序列
  const nums = Array.from({ length: 300 }, (_, i) => (i * 7 % 251)).join(', ')
  const out = await run(nums, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 数值序列不误伤', be.block.text === nums, `len=${be.block.text.length}`)
}
{
  // 英文重复句式（每句只换一个词）
  const en = Array.from({ length: 20 }, (_, i) =>
    `The plugin wraps every streaming model call and suppresses item ${i} in both channels.`).join(' ')
  const out = await run(en, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 英文相似句不误伤', be.block.text === en, `len=${be.block.text.length}`)
}
{
  // 多行相同结构的表格
  const table = '# | name | value | note\n' + Array.from({ length: 30 }, (_, i) =>
    `${i} | metric_${i} | ${i * 3} | checked`).join('\n')
  const out = await run(table, 'text-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 表格多行不误伤', be.block.text === table, `len=${be.block.text.length}`)
}
{
  // 中文但句尾标点稀疏（词表信号 token 数不足，应回落到 gram 判断）
  const sparse = '我需要检查配置文件的加载顺序首先看 provider 的 baseURL 是否指向本地网关端口 23091 看起来是 web 服务不是模型网关模型网关在 7863 走的是 openai-completions 协议因此问题不在网络层而在流式解析层'
  const out = await run(sparse, 'reasoning-delta')
  const be = out.find(c => c.type === 'block-end')
  check('危险: 稀疏标点中文不误伤', be.block.text === sparse, `len=${be.block.text.length}`)
}

// ── 可关闭 ────────────────────────────────────────────────────
{
  const { handlers: h2 } = makeCtx({ collapse: false })
  const text = irregular(12345, 600)
  const inner = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text } }
  })()
  const out = []
  for await (const c of h2['llm/stream']({ provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' }, () => inner)) out.push(c)
  const be = out.find(c => c.type === 'block-end')
  check('collapse:false 时关闭塌缩检测', be.block.text === text, `len=${be.block.text.length}`)
}

// ── 性能 ──────────────────────────────────────────────────────
{
  const normal = '这是一段完全正常的中文推理内容，涉及配置检查与协议分析。'.repeat(80)
  const t0 = process.hrtime.bigint()
  await run(normal, 'reasoning-delta', { step: 32 })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  check('性能: 3.4K 正常文本 < 120ms', ms < 120, `${ms.toFixed(1)}ms`)
}
{
  const loop = irregular(12345, 2000)
  const t0 = process.hrtime.bigint()
  await run(loop, 'reasoning-delta', { step: 32 })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  check('性能: 11K 循环文本 < 400ms', ms < 400, `${ms.toFixed(1)}ms`)
}

let pass = 0, fail = 0
for (const r of results) {
  if (r.pass) pass++; else fail++
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
}
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)

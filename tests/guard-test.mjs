// repetition-guard 逻辑验证 v2
// 算法与插件实现逐字一致。v2 修正：block-end 改用全文本循环清除(stripCycles)，
// 而非仅尾部检测 —— 后者在「循环后又接正常内容」时会漏检并还原垃圾。

const CONFIG = {
  models: ['*'], providers: ['*'], guardAuxiliary: false,
  reasoning: true, text: true,
  minRepeats: 6, minRunChars: 120, maxPeriod: 32,
  window: 1024, checkEvery: 48, escapeChars: 256,
  hardStop: true, hardStopChars: 6000,
}

const HAS_WORD = /[\p{L}\p{N}]/u
const RX_SPECIAL = /[.*+?^${}()|[\]\\]/g

function escapeRx(s) { return s.replace(RX_SPECIAL, '\\$&') }

function globMatch(patterns, value) {
  if (typeof value !== 'string') return false
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]
    if (p === '*') return true
    try {
      const rx = new RegExp('^' + p.split('*').map(escapeRx).join('.*') + '$', 'i')
      if (rx.test(value)) return true
    } catch (err) { }
  }
  return false
}

// 尾部周期检测：流式实时抑制用。返回 start 为循环段在 s 中的起始索引。
function detectCycle(s, cfg) {
  const n = s.length
  if (n < cfg.minRunChars) return null
  const limit = Math.min(cfg.maxPeriod, n >> 1)
  for (let p = 1; p <= limit; p++) {
    const unit = s.slice(n - p)
    if (!HAS_WORD.test(unit)) continue
    let reps = 1
    let i = n - p
    while (i >= p && s.startsWith(unit, i - p)) {
      reps++
      i -= p
    }
    if (reps >= cfg.minRepeats && reps * p >= cfg.minRunChars) {
      return { period: p, reps: reps, start: i, chars: reps * p }
    }
  }
  return null
}

// 从 from 起检测周期重复（用于全文本扫描）。
function cycleAt(s, from, cfg) {
  const n = s.length
  const maxP = Math.min(cfg.maxPeriod, Math.floor((n - from) / cfg.minRepeats))
  for (let p = 1; p <= maxP; p++) {
    if (s.charCodeAt(from) !== s.charCodeAt(from + p)) continue
    const unit = s.slice(from, from + p)
    if (!HAS_WORD.test(unit)) continue
    let reps = 1
    let j = from + p
    while (j + p <= n && s.startsWith(unit, j)) {
      reps++
      j += p
    }
    if (reps >= cfg.minRepeats && reps * p >= cfg.minRunChars) {
      return { period: p, reps: reps, chars: reps * p }
    }
  }
  return null
}

// 全文本循环清除：把任意位置的重复段压缩为一个周期，保留循环前后的有效内容。
function stripCycles(s, cfg) {
  const n = s.length
  if (n < cfg.minRunChars) return s
  const parts = []
  let last = 0
  let i = 0
  let changed = false
  while (i < n) {
    const hit = cycleAt(s, i, cfg)
    if (hit !== null) {
      parts.push(s.slice(last, i + hit.period))
      i += hit.chars
      last = i
      changed = true
    } else {
      i++
    }
  }
  if (!changed) return s
  parts.push(s.slice(last))
  return parts.join('')
}

function runGuard(chunks, options, cfg) {
  const out = []
  const st = { trips: 0, escapes: 0, hardStops: 0, blockTrims: 0, suppressedChars: 0 }
  let buf = '', pending = 0, squelching = false, squelchChars = 0, cleanChars = 0, stopped = false

  for (const chunk of chunks) {
    const t = chunk.type

    if (t === 'reasoning-delta' || t === 'text-delta') {
      const on = t === 'reasoning-delta' ? cfg.reasoning : cfg.text
      if (on) {
        buf = (buf + chunk.text).slice(-cfg.window)
        pending += chunk.text.length
        if (pending >= cfg.checkEvery) {
          pending = 0
          const hit = detectCycle(buf, cfg)
          if (hit !== null) {
            if (!squelching) { squelching = true; squelchChars = 0; st.trips++ }
            cleanChars = 0
          } else if (squelching) {
            cleanChars += cfg.checkEvery
            if (cleanChars >= cfg.escapeChars) { squelching = false; st.escapes++ }
          }
        }
        if (squelching) {
          squelchChars += chunk.text.length
          st.suppressedChars += chunk.text.length
          if (cfg.hardStop && squelchChars >= cfg.hardStopChars) {
            st.hardStops++
            out.push({ type: 'finish', reason: { kind: 'stop' } })
            stopped = true
            break
          }
          continue
        }
      }
      out.push(chunk)
      continue
    }

    if (t === 'block-start') {
      squelching = false; cleanChars = 0; buf = ''; pending = 0
      out.push(chunk)
      continue
    }

    if (t === 'block-end') {
      const b = chunk.block
      if (b && (b.type === 'reasoning' || b.type === 'text') && typeof b.text === 'string') {
        const on = b.type === 'reasoning' ? cfg.reasoning : cfg.text
        if (on) {
          const trimmed = stripCycles(b.text, cfg)
          if (trimmed !== b.text) {
            st.blockTrims++
            st.suppressedChars += b.text.length - trimmed.length
            out.push({ type: 'block-end', index: chunk.index, block: { type: b.type, text: trimmed } })
            continue
          }
        }
      }
      out.push(chunk)
      continue
    }

    out.push(chunk)
  }
  return { out, st, stopped }
}

function stream(text, type, index, step) {
  const chunks = [{ type: 'block-start', index, blockType: type === 'reasoning-delta' ? 'reasoning' : 'text' }]
  for (let i = 0; i < text.length; i += step) {
    chunks.push({ type, index, text: text.slice(i, i + step) })
  }
  chunks.push({
    type: 'block-end', index,
    block: { type: type === 'reasoning-delta' ? 'reasoning' : 'text', text },
  })
  return chunks
}

// 真正不重复的正常长文本
const NORMAL_TEXT = [
  '我需要检查一下配置文件的加载顺序。',
  '首先看 provider 的 baseURL 是否指向本地网关。',
  '端口 23091 看起来是 web 服务，不是模型网关。',
  '模型网关在 7863，走的是 openai-completions 协议。',
  '因此问题不在网络层，而在流式解析层。',
  '接下来验证一下 block-end 的语义。',
  'assembler 里写着 block-end 是 authoritative。',
  '这意味着它携带的完整文本会覆盖 delta 累积。',
  '所以抑制 delta 而不改 block-end 等于没做。',
  '结论是必须在 block-end 上做全文本清除。',
  '另外要注意 tool-call 类型的 block 没有 text 字段。',
  '对这类 block 必须原样透传，不能误改。',
  '最后确认一下纯符号重复不应该被判定为循环。',
  '比如分隔线、括号、等号这类字符。',
  '这些在代码和表格里是合法且常见的。',
].join('')

const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail })
}

// ---- 1: "ok" 死循环 ----
{
  const text = 'ok '.repeat(200)
  const { out, st } = runGuard(stream(text, 'reasoning-delta', 0, 3), { model: 'm' }, CONFIG)
  const fwd = out.filter(c => c.type === 'reasoning-delta').reduce((a, c) => a + c.text.length, 0)
  const be = out.find(c => c.type === 'block-end')
  check('ok 死循环: 触发 trip', st.trips >= 1, `trips=${st.trips}`)
  check('ok 死循环: delta 被削减', fwd < text.length * 0.5, `转发=${fwd}/${text.length}`)
  check('ok 死循环: block-end 清除循环', be.block.text.length <= 8, `len=${be.block.text.length}`)
}

// ---- 2: "好的，马上" 循环 ----
{
  const text = '好的，马上 '.repeat(80)
  const { out, st } = runGuard(stream(text, 'reasoning-delta', 0, 4), { model: 'm' }, CONFIG)
  const be = out.find(c => c.type === 'block-end')
  check('好的马上循环: 触发', st.trips >= 1, `trips=${st.trips}`)
  check('好的马上循环: block-end 清除', be.block.text.length <= 16, `len=${be.block.text.length}`)
}

// ---- 3: 正常长文本不误伤 ----
{
  const { out, st } = runGuard(stream(NORMAL_TEXT, 'reasoning-delta', 0, 7), { model: 'm' }, CONFIG)
  const fwd = out.filter(c => c.type === 'reasoning-delta').reduce((a, c) => a + c.text.length, 0)
  const be = out.find(c => c.type === 'block-end')
  check('正常中文: 无 trip', st.trips === 0, `trips=${st.trips}`)
  check('正常中文: delta 全透传', fwd === NORMAL_TEXT.length, `${fwd}/${NORMAL_TEXT.length}`)
  check('正常中文: block-end 未改', be.block.text === NORMAL_TEXT, `len=${be.block.text.length}`)
}

// ---- 4: 纯符号重复不触发 ----
{
  const { st } = runGuard(stream('-'.repeat(400), 'text-delta', 0, 8), { model: 'm' }, CONFIG)
  check('分隔线 ----: 不触发', st.trips === 0, `trips=${st.trips}`)
}
{
  const { st } = runGuard(stream('}'.repeat(300), 'text-delta', 0, 8), { model: 'm' }, CONFIG)
  check('代码 }}}} 重复: 不触发', st.trips === 0, `trips=${st.trips}`)
}

// ---- 5: 轻度强调不触发 ----
{
  const text = '这个方案非常非常非常重要，必须认真对待。'.repeat(4)
  const { st } = runGuard(stream(text, 'text-delta', 0, 5), { model: 'm' }, CONFIG)
  check('轻度强调: 不触发', st.trips === 0, `trips=${st.trips}`)
}

// ---- 6: 循环后恢复（v1 失效场景） ----
{
  const junk = 'ok '.repeat(120)
  const good = '现在重新分析这个问题：根因在于缓冲区没有上限，需要在写入前做长度检查。'
  const { out, st } = runGuard(stream(junk + good, 'reasoning-delta', 0, 6), { model: 'm' }, CONFIG)
  const be = out.find(c => c.type === 'block-end')
  check('循环后恢复: 触发 trip', st.trips >= 1, `trips=${st.trips}`)
  check('循环后恢复: 有效内容保留', be.block.text.includes('根因在于缓冲区没有上限'), `tail=${JSON.stringify(be.block.text.slice(-30))}`)
  check('循环后恢复: 垃圾被清除', be.block.text.length < junk.length, `len=${be.block.text.length} < ${junk.length}`)
  check('循环后恢复: block-end 已重写', st.blockTrims >= 1, `trims=${st.blockTrims}`)
}

// ---- 7: 中间循环（前后都有有效内容） ----
{
  const text = '开始分析配置。' + 'ok '.repeat(100) + '结论是需要加长度上限。'
  const { out } = runGuard(stream(text, 'reasoning-delta', 0, 9), { model: 'm' }, CONFIG)
  const be = out.find(c => c.type === 'block-end')
  check('中间循环: 头部保留', be.block.text.startsWith('开始分析配置。'), JSON.stringify(be.block.text.slice(0, 12)))
  check('中间循环: 尾部保留', be.block.text.endsWith('结论是需要加长度上限。'), JSON.stringify(be.block.text.slice(-14)))
  check('中间循环: 长度大幅压缩', be.block.text.length < 80, `len=${be.block.text.length}`)
}

// ---- 8: hardStop 熔断 ----
{
  const { out, st, stopped } = runGuard(stream('ok '.repeat(4000), 'reasoning-delta', 0, 10), { model: 'm' }, CONFIG)
  const last = out[out.length - 1]
  check('hardStop: 触发熔断', st.hardStops === 1 && stopped, `hardStops=${st.hardStops}`)
  check('hardStop: 以 finish stop 收尾', last.type === 'finish' && last.reason.kind === 'stop', JSON.stringify(last))
}

// ---- 9: tool-call block 不被误改 ----
{
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{"command":"ls"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  ]
  const { out } = runGuard(chunks, { model: 'm' }, CONFIG)
  const be = out.find(c => c.type === 'block-end')
  check('tool-call: 原样透传', be.block.arguments === '{"command":"ls"}', JSON.stringify(be.block))
}

// ---- 10: glob 匹配 ----
{
  check('glob * 命中任意', globMatch(['*'], 'global:deepseek-v4.1-flash') === true, '')
  check('glob 精确命中', globMatch(['global:deepseek-v4.1-flash'], 'global:deepseek-v4.1-flash') === true, '')
  check('glob 不命中他者', globMatch(['global:deepseek-v4.1-flash'], 'cn:kimi-k2.8-preview') === false, '')
  check('glob 通配命中', globMatch(['*flash*'], 'global:deepseek-v4.1-flash') === true, '')
  check('glob 点号按字面', globMatch(['global:deepseek-v4.1-flash'], 'global:deepseek-vX4Y1-flash') === false, '')
}

// ---- 11: 性能 ----
{
  const big = NORMAL_TEXT.repeat(12) // ~4000 字符
  const t0 = process.hrtime.bigint()
  stripCycles(big, CONFIG)
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6
  check('性能: 4K 正常文本 < 30ms', ms < 30, `${ms.toFixed(2)}ms`)
}
{
  const big = 'ok '.repeat(3000) // 9000 字符纯循环
  const t0 = process.hrtime.bigint()
  const r = stripCycles(big, CONFIG)
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6
  check('性能: 9K 循环文本 < 60ms', ms < 60, `${ms.toFixed(2)}ms`)
  check('性能: 9K 循环压缩到极短', r.length <= 8, `len=${r.length}`)
}

let pass = 0, fail = 0
for (const r of results) {
  if (r.pass) pass++; else fail++
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
}
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)

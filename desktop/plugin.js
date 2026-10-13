// token-usage — 侧边栏「用量」页：按 provider/model 统计指定时间范围内的
// token 用量（输入/输出/缓存命中/总计），点击展开单条 session。
// 数据来自插件后端 GET /api/plugins/token-usage/usage（只读 state.db）。

// 用 namespace import：shim 只 re-export 运行时实际存在的名字，
// 具名导入一个不存在的导出会在加载期直接抛 SyntaxError。
import * as sdk from '@hermes/plugin-sdk'
import { useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const { useQuery, ROUTES_AREA, SIDEBAR_NAV_AREA } = sdk
const SIDEBAR_NAV_PREFS_AREA = sdk.SIDEBAR_NAV_PREFS_AREA // 旧版桌面端可能没有这个导出

// ---------------------------------------------------------------------------
// helpers

let restFn = null // register(ctx) 时绑定 ctx.rest

const fmtNum = n => {
  if (!n) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

const fmtFull = n => Math.round(n || 0).toLocaleString('en-US')

const fmtTime = ts => {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = x => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const localDayStart = offsetDays => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d.getTime() / 1000
}

const rangeOf = (preset, cs, ce) => {
  const now = Date.now() / 1000
  if (preset === '7d') return { start: localDayStart(-6), end: now }
  if (preset === '30d') return { start: localDayStart(-29), end: now }
  if (preset === 'all') return { start: 0, end: now }
  if (preset === 'custom') {
    const s = new Date(cs + 'T00:00:00').getTime() / 1000
    const e = new Date(ce + 'T00:00:00').getTime() / 1000 + 86400
    return s <= e ? { start: s, end: e } : { start: e - 86400, end: s + 86400 }
  }
  return { start: localDayStart(0), end: now } // today
}

const cnJoin = (...xs) => xs.filter(Boolean).join(' ')

// app 原生 hover 背景（sidebar 行同款）；CSS var + /opacity 修饰符不生效，别用
const HOVER = 'hover:bg-(--ui-control-hover-background)'

// 名称 | 调用 | 输入 | 输出 | 缓存命中 | 命中率 | 总计
// 块内第一行(灰标签)、第二行(数值)、session 行共用同一模板，列严格对齐
const GRID = 'minmax(140px,2fr) 64px 96px 96px 104px 72px 104px'

const NUM_CELL = 'px-2 text-right tabular-nums whitespace-nowrap overflow-hidden'

// 命中率 = 缓存命中 / (输入 + 缓存命中)；无输入时显示 —
const fmtPct = (hit, input) => {
  const d = (hit || 0) + (input || 0)
  return d > 0 ? ((hit / d) * 100).toFixed(1) + '%' : '—'
}

// 第一行灰色列标签（右对齐，与数值同列）
const labelCell = label =>
  jsx('div', {
    className: cnJoin(NUM_CELL, 'text-[0.6875rem]'),
    children: label
  })

// 数值格（右对齐，悬停 title 显示标签+完整数字）
const numCell = (label, value, opts = {}) =>
  jsx('div', {
    className: cnJoin(NUM_CELL, opts.strong && 'font-semibold'),
    title: `${label} ${fmtFull(value)}`,
    children: fmtNum(value)
  })

// 命中率格
const pctCell = (hit, input) =>
  jsx('div', {
    className: NUM_CELL,
    children: fmtPct(hit, input)
  })

// ---------------------------------------------------------------------------
// components

function SessionRow({ s }) {
  return jsxs('div', {
    style: { display: 'grid', gridTemplateColumns: GRID },
    className:
      'text-xs py-2 items-center border-t border-(--ui-stroke-secondary)/40 ' +
      `text-(--ui-text-secondary) ${HOVER} transition-colors`,
    children: [
      jsxs('div', {
        className: 'pl-7 pr-2 overflow-hidden text-ellipsis whitespace-nowrap',
        title: s.session_id,
        children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: fmtTime(s.started_at) }),
          jsx('span', { children: `  ${s.title || s.session_id}` })
        ]
      }),
      numCell('调用', s.api_call_count),
      numCell('输入', s.input_tokens),
      numCell('输出', s.output_tokens),
      numCell('缓存命中', s.cache_read_tokens),
      pctCell(s.cache_read_tokens, s.input_tokens),
      numCell('总计', s.total_tokens, { strong: true })
    ]
  })
}

function GroupRow({ g, open, onToggle }) {
  return jsxs('div', {
    // 主题色边框区分主块与 session 从行；下边距分组、右边距不顶边
    className: 'rounded-md border border-(--ui-accent)/45 overflow-hidden',
    style: { marginBottom: 12, marginRight: 8 },
    children: [
      jsxs('button', {
        type: 'button',
        onClick: onToggle,
        className: `w-full text-left text-sm flex flex-col gap-0.5 py-2.5 ${HOVER} transition-colors`,
        children: [
          // 第一行（灰色）：▸ provider + 列标签
          jsxs('div', {
            style: { display: 'grid', gridTemplateColumns: GRID },
            className: 'items-center text-(--ui-text-tertiary)',
            children: [
              jsxs('div', {
                className: 'px-3 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem]',
                children: [
                  jsx('span', { className: 'mr-1', children: open ? '▾' : '▸' }),
                  jsx('span', { children: g.provider })
                ]
              }),
              labelCell('调用'),
              labelCell('输入'),
              labelCell('输出'),
              labelCell('缓存命中'),
              labelCell('命中率'),
              labelCell('总计')
            ]
          }),
          // 第二行：model + 具体数值（列与上行对齐）
          jsxs('div', {
            style: { display: 'grid', gridTemplateColumns: GRID },
            className: 'items-center',
            children: [
              jsx('div', {
                // 与上行 provider 左边对齐（无额外缩进）
                className: 'px-3 overflow-hidden text-ellipsis whitespace-nowrap font-medium',
                title: `${g.provider}/${g.model}`,
                children: g.model
              }),
              numCell('调用', g.api_call_count),
              numCell('输入', g.input_tokens),
              numCell('输出', g.output_tokens),
              numCell('缓存命中', g.cache_read_tokens),
              pctCell(g.cache_read_tokens, g.input_tokens),
              numCell('总计', g.total_tokens, { strong: true })
            ]
          })
        ]
      }),
      open
        ? jsxs('div', {
            className: 'bg-(--ui-stroke-secondary)/10',
            children: [
              jsx('div', {
                className: 'px-3 py-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                children: `${g.sessions.length} 条 session`
              }),
              ...g.sessions.map(s => jsx(SessionRow, { s, key: s.session_id }))
            ]
          })
        : null
    ].filter(Boolean)
  })
}

const PRESETS = [
  ['today', '今天'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['all', '全部'],
  ['custom', '自定义']
]

function UsagePage() {
  const todayIso = new Date().toLocaleDateString('sv-SE') // 本地时区 YYYY-MM-DD
  const [preset, setPreset] = useState('today')
  const [cs, setCs] = useState(todayIso)
  const [ce, setCe] = useState(todayIso)
  const [open, setOpen] = useState({})

  const range = useMemo(() => rangeOf(preset, cs, ce), [preset, cs, ce])
  const { data, isLoading, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['token-usage', 'usage', Math.round(range.start), Math.round(range.end)],
    queryFn: () => restFn(`/usage?start=${range.start}&end=${range.end}`),
    refetchInterval: 30_000
  })

  const groups = data?.groups ?? []
  const grand = groups.reduce((a, g) => a + g.total_tokens, 0)

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-4 text-sm overflow-hidden',
    children: [
      // 顶部：标题 + 总计
      jsxs('div', {
        className: 'flex items-baseline gap-3',
        children: [
          jsx('div', { className: 'text-base font-semibold', children: '用量' }),
          jsx('div', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: isLoading
              ? '加载中…'
              : `共 ${groups.length} 个模型 · 总 token ${fmtNum(grand)}（${fmtFull(grand)}）`
          }),
          jsx('div', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            onClick: () => refetch(),
            className:
              `rounded border border-(--ui-stroke-secondary) px-2 py-0.5 text-xs ` +
              `text-(--ui-text-secondary) ${HOVER}`,
            children: '刷新'
          }),
          jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: dataUpdatedAt ? `更新于 ${fmtTime(dataUpdatedAt / 1000)}` : ''
          })
        ]
      }),

      // 日期选择
      jsxs('div', {
        className: 'flex items-center gap-1.5 flex-wrap',
        children: [
          ...PRESETS.map(([id, label]) =>
            jsx('button', {
              key: id,
              type: 'button',
              onClick: () => setPreset(id),
              className: cnJoin(
                'rounded px-2.5 py-1 text-xs border transition-colors',
                preset === id
                  ? 'border-(--ui-accent) text-(--ui-accent) bg-(--ui-accent)/10'
                  : `border-(--ui-stroke-secondary) text-(--ui-text-secondary) ${HOVER}`
              ),
              children: label
            })
          ),
          preset === 'custom'
            ? jsxs('span', {
                className: 'flex items-center gap-1.5 text-xs text-(--ui-text-secondary)',
                children: [
                  jsx('input', {
                    type: 'date',
                    value: cs,
                    max: ce,
                    onChange: e => setCs(e.target.value),
                    className:
                      'rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-xs'
                  }),
                  jsx('span', { children: '至' }),
                  jsx('input', {
                    type: 'date',
                    value: ce,
                    min: cs,
                    max: todayIso,
                    onChange: e => setCe(e.target.value),
                    className:
                      'rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-xs'
                  })
                ]
              })
            : null,
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary) ml-1',
            children: preset === 'all' ? '全部时间' : `${fmtTime(range.start)} 起`
          })
        ].filter(Boolean)
      }),

      // 内容：最外层 border 包裹所有行（无独立表头）
      jsx('div', {
        className: 'flex-1 overflow-y-auto rounded-lg border border-(--ui-stroke-secondary) p-2',
        children: error
          ? jsxs('div', {
              className: 'text-xs text-(--ui-text-tertiary) flex flex-col gap-1 pt-4 px-2',
              children: [
                jsx('div', {
                  className: 'text-red-400',
                  children: `查询失败：${error.message || String(error)}`
                }),
                jsx('div', {
                  children: '后端未就绪？确认 config.yaml 的 plugins.enabled 含 token-usage，并重启 gateway。'
                })
              ]
            })
          : groups.length === 0 && !isLoading
            ? jsx('div', {
                className: 'text-xs text-(--ui-text-tertiary) pt-4 px-2',
                children: '该时间段内无 token 用量'
              })
            : jsxs('div', {
                className: 'flex flex-col',
                children: groups.map(g =>
                  jsx(GroupRow, {
                    g,
                    key: `${g.provider}/${g.model}`,
                    open: !!open[`${g.provider}/${g.model}`],
                    onToggle: () =>
                      setOpen(o => ({ ...o, [`${g.provider}/${g.model}`]: !o[`${g.provider}/${g.model}`] }))
                  })
                )
              })
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// plugin contract

export default {
  id: 'token-usage',
  name: '用量',
  description: '按 provider/model 统计 token 用量（state.db），侧边栏「用量」页',
  register(ctx) {
    restFn = ctx.rest

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/token-usage' },
        render: () => jsx(UsagePage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/token-usage', label: '用量', codicon: 'graph' }
      }
    ])

    // 钉在「消息平台」(messaging) 正下方
    if (SIDEBAR_NAV_PREFS_AREA) {
      ctx.register({
        id: 'nav-prefs',
        area: SIDEBAR_NAV_PREFS_AREA,
        data: { order: ['new-session', 'capabilities', 'messaging', 'token-usage:nav'] }
      })
    }
  }
}

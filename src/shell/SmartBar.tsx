import { Bot, CalendarDays, Folder, Globe, Loader2, MonitorSmartphone, Tag, Timer } from 'lucide-react'
import type { SmartChip } from '../api'

export interface SmartMeta {
  chips: SmartChip[]
  ms: number
  question: boolean
  rank: Map<string, number>
  terms: string[]
}
export interface AskAnswer {
  loading: boolean
  answer: string | null
  cites: { n: number; id: string; title: string }[]
  source: 'cloud' | 'local'
  error?: string
}

const ICON: Record<SmartChip['kind'], JSX.Element> = {
  time: <CalendarDays size={12} />,
  browser: <MonitorSmartphone size={12} />,
  site: <Globe size={12} />,
  folder: <Folder size={12} />,
  status: <Tag size={12} />
}
const KIND: Record<SmartChip['kind'], string> = { time: '时间', browser: '浏览器', site: '站点', folder: '收藏夹', status: '状态' }

/** Parsed 智能搜索 conditions as chips + latency, and the AI 问答 answer with clickable citations. */
export function SmartBar(p: { smart: SmartMeta; answer: AskAnswer | null; count: number; onAsk: () => void; onCite: (id: string) => void }) {
  const { smart, answer } = p
  const parts = answer?.answer?.split(/(\[\d+\])/) ?? []
  return (
    <div className="smart-bar" data-testid="smart-bar">
      <div className="smart-chips">
        {smart.chips.map((c) => (
          <span key={c.kind + c.label} className="smart-chip" data-kind={c.kind}>
            {ICON[c.kind]}
            {KIND[c.kind]}：{c.label}
          </span>
        ))}
        {smart.terms.length > 0 && (
          <span className="smart-chip muted">
            <Tag size={12} />
            关键词：{smart.terms.slice(0, 5).join(' · ')}
          </span>
        )}
        <span className="smart-ms muted" title="本地解析 + 混合排序耗时">
          <Timer size={12} /> {smart.ms} ms
        </span>
        {smart.question && !answer && (
          <button className="btn btn-sm" onClick={p.onAsk}>
            <Bot size={12} /> AI 回答
          </button>
        )}
      </div>
      {answer && (
        <div className="smart-answer" data-testid="ai-answer">
          {answer.loading ? (
            <span className="muted">
              <Loader2 size={12} className="spin" /> AI 正在阅读你的收藏…
            </span>
          ) : answer.answer ? (
            <>
              <Bot size={14} />
              <span>
                {parts.map((x, i) => {
                  const m = /^\[(\d+)\]$/.exec(x)
                  const c = m && answer.cites.find((k) => k.n === Number(m[1]))
                  return c ? (
                    <button key={i} className="cite" title={c.title} onClick={() => p.onCite(c.id)}>
                      [{c.n}]
                    </button>
                  ) : (
                    <span key={i}>{x}</span>
                  )
                })}
              </span>
              {answer.cites.length > 0 && (
                <div className="cite-list">
                  {answer.cites.map((c) => (
                    <button key={c.n} className="cite-item" onClick={() => p.onCite(c.id)}>
                      [{c.n}] {c.title}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="muted">
              {answer.error ? `${answer.error}。` : '未启用云端 AI，'}以下是本地智能搜索的 {p.count} 条结果。
            </span>
          )}
        </div>
      )}
    </div>
  )
}
